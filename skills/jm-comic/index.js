// 禁漫漫画下载（jm-comic）—— 异步任务版
// ---------------------------------------------------------------------------
// 类型：**技能**（LLM 型），放 skills/。插件注册的工具不会进模型的工具列表，
// 只有 skills/ 里的模块才有这待遇（doc/extend_development/plugin-development.md 第 6 节）。
//
// 一次请求的完整链路（全部异步，不阻塞模型回合）：
//   群友发 jm123456
//     └─ 钩子识别 ID → 提示模型调用工具
//          └─ 工具：权限校验 → 入队 → **立即返回**（模型马上能继续说话）
//               └─ 后台任务：
//                    ① engine 下载原图（纯 Node，零依赖）
//                    ② 现查 scramble_id
//                    ③ pdf.js → Python+Pillow 还原竖切并合成 PDF（可选增强）
//                    ④ upload.js 上传到「提出请求的那个会话」
//                    ⑤ 发消息汇报；记录留痕，失败可见
//
// 设计取舍（都踩过坑，写下来免得以后改错）：
//   · 不在模型回合里同步下载：一本 300 页要几十秒到几分钟，会把模型请求挂住、
//     白烧 token，还可能撞上大模型调用超时（群友连发几本直接卡死）。
//   · 工具的 execute(ctx) 里**没有** triggerEntries，所以"谁在下指令"只能靠
//     before-tool 钩子里记下来的 callerLog（文档 skill-development.md 第 5 节）。
//   · 任务持久化到 data/jm-comic/tasks.json：热重载/重启后仍能看到历史与失败记录。
//   · 所有 catch 都打日志：静默吞异常会让"装好了没反应"变成无头案。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as engine from './engine.js';
import * as pdfBridge from './pdf.js';
import { uploadFile, groupQuota, deleteGroupFile, humanSize } from './upload.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASKS_FILE = () => path.join(downloadRoot(), 'tasks.json');

// ───────────────────────── 模块级状态 ─────────────────────────
// ⚠️ 热重载会重新 import 本文件，这些变量会被重置（正常行为）。

let api = null;
const activeTasks = new Map(); // albumId -> task
const activeByChat = new Map(); // chatKey -> albumId（每个会话同时只跑一本）
const callerLog = new Map(); // sessionId/chatKey -> { candidates, at }
const pendingHint = new Map(); // sessionId/chatKey -> { id, who, at }
let taskHistory = []; // 最近的任务记录（持久化）
let historyLoaded = false;
let cleanupTimer = null;
let workerCache = { at: 0, result: null };

// ───────────────────────── 配置 ─────────────────────────

function num(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function cfg() {
  const c = api?.config?.() || {};
  return {
    enabled: c.enabled !== false,
    downloadDir: String(c.downloadDir ?? '').trim(),
    domains: String(c.domains ?? '').trim(),
    maxPages: num(c.maxPages, 500, 1, 5000),
    multiChapter: c.multiChapter !== false,
    concurrency: num(c.concurrency, 4, 1, 8),
    timeoutSeconds: num(c.timeoutSeconds, 30, 5, 300),
    restore: c.restore !== false,
    outputFormat: String(c.outputFormat || 'pdf').toLowerCase() === 'images' ? 'images' : 'pdf',
    deleteImagesAfterPdf: c.deleteImagesAfterPdf === true,
    pdfQuality: num(c.pdfQuality, 85, 30, 95),
    pdfMaxDim: num(c.pdfMaxDim, 0, 0, 6000),
    uploadMode: ['off', 'request', 'group', 'private'].includes(String(c.uploadMode))
      ? String(c.uploadMode)
      : 'request',
    rejectOversize: c.rejectOversize === true,
    maxUploadMB: num(c.maxUploadMB, 200, 1, 4096),
    checkQuota: c.checkQuota !== false,
    allowIds: String(c.allowIds ?? '').trim(),
    keepDays: num(c.keepDays, 7, 0, 365),
    groupFileKeepDays: num(c.groupFileKeepDays, 0, 0, 365),
    pythonPath: String(c.pythonPath ?? '').trim(),
    progress: c.progress !== false,
  };
}

/** 下载根目录：优先配置，其次 resources/app/data/jm-comic。 */
function downloadRoot() {
  return cfg().downloadDir || path.join(APP_ROOT, 'data', 'jm-comic');
}

function fetchImpl() {
  if (typeof api?.fetch === 'function') return api.fetch;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

const log = (...a) => api?.log?.(...a);
const warn = (...a) => api?.warn?.(...a);

/** 建一个绑定当前配置的引擎客户端。 */
function client() {
  return engine.createClient({
    fetchImpl: fetchImpl(),
    timeoutMs: () => cfg().timeoutSeconds * 1000,
    domains: cfg().domains,
    warn,
  });
}

// ───────────────────────── Python 能力探测（带缓存）─────────────────────────

function detectWorker(force = false) {
  const c = cfg();
  if (!force && workerCache.result && Date.now() - workerCache.at < 60000) return workerCache.result;
  const result = c.restore || c.outputFormat === 'pdf'
    ? pdfBridge.detect(c.pythonPath)
    : { ok: false, error: '未启用还原/PDF' };
  workerCache = { at: Date.now(), result };
  return result;
}

// ───────────────────────── 任务持久化 ─────────────────────────

async function loadHistory() {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const raw = await fsp.readFile(TASKS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) taskHistory = parsed.slice(0, 50);
  } catch {
    taskHistory = [];
  }
}

async function saveHistory() {
  try {
    await fsp.mkdir(downloadRoot(), { recursive: true });
    await fsp.writeFile(TASKS_FILE(), JSON.stringify(taskHistory.slice(0, 50), null, 2), 'utf8');
  } catch (error) {
    warn(`任务记录写入失败（不影响下载）：${error?.message ?? error}`);
  }
}

function pushHistory(entry) {
  taskHistory.unshift({ ...entry, at: new Date().toISOString() });
  taskHistory = taskHistory.slice(0, 50);
  void saveHistory();
}

// ───────────────────────── 权限 ─────────────────────────

/**
 * 谁能触发。留空 = 所有人；填了 QQ 号 → 只有管理员/群主/白名单能触发。
 * 注意：工具的 ctx 里没有发送者，只能读 before-tool 钩子记下的 callerLog。
 */
async function checkPermission(ctx) {
  const c = cfg();
  if (!c.allowIds) return { ok: true };

  const allow = new Set(
    c.allowIds.split(/[\s,;，、]+/).map((s) => s.trim()).filter(Boolean),
  );
  const caller = callerLog.get(callerKey(ctx));
  const candidate = caller && Date.now() - caller.at < 120000 ? caller.candidates?.[0] : null;

  if (!candidate?.id) {
    return {
      ok: false,
      reason: '这个技能设置了「允许触发的 QQ」，但我认不出是谁在下指令。'
        + '请让有权限的人在消息里 @ 一下我再说一次。',
    };
  }
  if (allow.has(candidate.id)) return { ok: true, caller: candidate };

  if (String(ctx?.kind) === 'group' && ctx?.onebot) {
    try {
      const info = await ctx.onebot.call('get_group_member_info', {
        group_id: Number(ctx.chatId),
        user_id: Number(candidate.id),
        no_cache: true,
      });
      const role = String(info?.role || 'member');
      if (role === 'owner' || role === 'admin') return { ok: true, caller: candidate, role };
    } catch (error) {
      warn(`权限校验时查群身份失败（按拒绝处理）：${error?.message ?? error}`);
    }
  }
  return { ok: false, reason: `这个技能只对管理员或白名单 QQ 开放。要放开请把 ${candidate.id} 加进「允许触发的 QQ」。` };
}

// ───────────────────────── 下载一个本子 ─────────────────────────

/**
 * 下载整本（不含 PDF/上传）。返回结构供后续步骤复用。
 * @param {object} job { albumId, chatKey, onProgress }
 */
async function downloadAlbum({ albumId, chatKey, onProgress }) {
  const c = cfg();
  const api0 = client();
  const album = await api0.albumInfo(albumId);

  const chapters = album.series.length
    ? (c.multiChapter ? album.series : album.series.slice(0, 1))
    : [{ id: album.id, name: album.name, sort: 1 }];

  const albumDir = path.join(downloadRoot(), `jm-${album.id}`, engine.sanitizeSegment(`${album.id}-${album.name}`, `JM${album.id}`));
  await fsp.mkdir(albumDir, { recursive: true });

  const totals = { total: 0, ok: 0, fail: 0, pages: 0 };
  const failed = [];
  const chapterResults = [];

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    let photo;
    try {
      photo = await api0.photoInfo(chapter.id);
    } catch (error) {
      failed.push({ chapter: chapter.id, error: `章节信息读取失败：${error?.message ?? error}` });
      onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals });
      continue;
    }
    if (!photo.images.length) {
      failed.push({ chapter: chapter.id, error: '这一章没有图片（可能已被删除）' });
      onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals });
      continue;
    }

    let names = photo.images.map((n, idx) => engine.imageFileName(n, idx + 1));
    let skipped = 0;
    if (names.length > c.maxPages) {
      skipped = names.length - c.maxPages;
      names = names.slice(0, c.maxPages);
    }

    const chapterDir = chapters.length > 1
      ? path.join(
          albumDir,
          engine.sanitizeSegment(
            // 实测：/album 的 series[].name 常常是空串，真正的章节名在 /chapter 的 name 里
            `${String(chapter.sort || i + 1).padStart(3, '0')}-${chapter.name || photo.name || ''}`,
            `ch-${chapter.id}`,
          ),
        )
      : albumDir;
    await fsp.mkdir(chapterDir, { recursive: true });

    const pages = [];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= names.length) return;
        const target = path.join(chapterDir, names[idx]);
        totals.total += 1;
        try {
          if (fs.existsSync(target) && (await fsp.stat(target)).size > 1024) {
            totals.ok += 1; // 之前下过（同一 ID 重发时补下）
          } else {
            const buf = await api0.fetchImage(photo.id || chapter.id, names[idx]);
            await fsp.writeFile(target, buf);
            totals.ok += 1;
          }
          pages[idx] = target;
        } catch (error) {
          totals.fail += 1;
          failed.push({ chapter: chapter.id, error: `${names[idx]}：${error?.message ?? error}` });
        }
        totals.pages += 1;
        if (totals.pages % 5 === 0) {
          onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(c.concurrency, names.length)) }, worker));
    onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals });

    chapterResults.push({
      id: photo.id || chapter.id,
      name: chapter.name || photo.name || `第${i + 1}话`,
      sort: chapter.sort || i + 1,
      skipped,
      pages: pages.filter(Boolean),
    });
  }

  // scramble_id 每次现查（写死会把本来正常的图弄花）
  let scrambleId = 0;
  if (c.restore && chapterResults.length) {
    scrambleId = await api0.fetchScrambleId(chapterResults[0].id);
  }

  return { album, albumDir, chapters: chapterResults, totals, failed, scrambleId };
}

// ───────────────────────── 主任务 ─────────────────────────

async function runJob(job) {
  const c = cfg();
  const { albumId, chatKey, kind, sender, onebot, who } = job;
  const say = (text) => sendText(sender, onebot, chatKey, text);

  await loadHistory();
  await fsp.mkdir(downloadRoot(), { recursive: true });

  let lastReport = 0;
  const report = (text) => {
    if (!c.progress) return;
    const now = Date.now();
    if (now - lastReport < 12000) return; // 报太勤会把发言配额吃光
    lastReport = now;
    void say(text);
  };

  const record = { id: albumId, chatKey, who, ok: false, stage: 'download', startedAt: Date.now() };

  try {
    // ① 下载
    await say(`🔍 开始处理 JM${albumId}…`);
    const dl = await downloadAlbum({
      albumId,
      chatKey,
      onProgress: (p) => {
        if (p.stage === 'download' && p.total > 0) {
          report(`📥 下载中：第 ${p.chapter}/${p.chapters} 话，已存 ${p.ok}/${p.total} 张（失败 ${p.fail}）`);
        }
      },
    });
    record.title = dl.album.name;
    record.pages = dl.totals.total;
    record.pagesOk = dl.totals.ok;
    record.dir = dl.albumDir;
    if (!dl.totals.ok) {
      throw new Error(`一张图都没下下来（失败 ${dl.totals.fail} 张）。多半是站点限速或网络问题，稍后重发同一个 ID 会接着补下。`);
    }

    // ② 生成 PDF（可选增强）
    let deliverPath = '';
    let deliverName = '';
    let pdfInfo = null;
    const wantPdf = c.outputFormat === 'pdf';
    const worker = wantPdf ? detectWorker() : { ok: false, error: '输出格式设为「原始图片」' };

    if (wantPdf && worker.ok) {
      record.stage = 'pdf';
      await say(`🖼 下载完成（${dl.totals.ok} 张），正在${c.restore ? '还原竖切并' : ''}合成 PDF…`);
      const pdfName = `${engine.sanitizeSegment(`JM${dl.album.id}-${dl.album.name}`, `JM${dl.album.id}`)}.pdf`;
      const outPath = path.join(dl.albumDir, pdfName);
      const task = {
        album_id: dl.album.id,
        title: dl.album.name,
        scramble_id: dl.scrambleId,
        descramble: c.restore,
        output: outPath,
        quality: c.pdfQuality,
        max_dim: c.pdfMaxDim,
        chapters: dl.chapters.map((ch) => ({ name: ch.name, pages: ch.pages })),
      };
      const res = await pdfBridge.runTask({
        python: worker.python,
        task,
        timeoutMs: Math.max(180000, dl.totals.total * 4000),
        onProgress: (p) => {
          if (p.stage === 'descramble') {
            report(`🎨 还原中：${p.done}/${p.total}（失败 ${p.fail}）`);
          } else if (p.stage === 'pdf') {
            report('📄 正在写入 PDF…');
          }
        },
      });
      if (res.ok) {
        pdfInfo = res;
        deliverPath = res.output;
        deliverName = pdfName;
        record.pdf = { bytes: res.bytes, pages: res.pages, pagesOk: res.pagesOk, restored: res.restored };
      } else {
        // 降级：PDF 没成，但图已经下来了，不能算整体失败
        warn(`PDF 生成失败（已降级为原样图片）：${res.error}`);
        record.pdfError = res.error;
      }
    } else if (wantPdf) {
      record.pdfError = worker.error;
      warn(`PDF 不可用（降级为原样图片）：${worker.error}`);
    }

    // ②.5 写 metadata.json（书架工具要靠它显示本子名；也必须早于"删除原图"）
    // ⚠️ 这里踩过一次：v2 重写时把这个写入漏掉了，metadata.json 只被读、从不被写，
    //    于是 library 工具一直拿目录名硬猜本子名，而"删除原图"也少了要保护的文件。
    try {
      const meta = {
        id: dl.album.id,
        name: dl.album.name,
        authors: dl.album.authors,
        tags: dl.album.tags,
        chapters: dl.chapters.length,
        pages: dl.totals.total,
        pagesOk: dl.totals.ok,
        downloadedAt: new Date().toISOString(),
        dir: dl.albumDir,
        pdf: pdfInfo ? { bytes: pdfInfo.bytes, pages: pdfInfo.pages, pagesOk: pdfInfo.pagesOk, restored: pdfInfo.restored } : null,
        pdfError: record.pdfError || '',
        deletedImages: false,
        note: '图片为站点原始文件；较新的本子带站点防爬的竖切打乱，本技能会按站点返回的 scramble_id 还原。',
      };
      await fsp.writeFile(path.join(dl.albumDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch (error) {
      warn(`metadata.json 写入失败（不影响下载）：${error?.message ?? error}`);
    }

    if (!deliverPath) {
      record.stage = 'images';
      deliverPath = '';
    }

    // ③ 上传（若开启「合成 PDF 后删除原图」，这里只是收尾顺序的前半段 —— 见 ④）
    const dest = resolveUploadTarget(c, chatKey, kind);
    let uploadNote = '';
    if (c.uploadMode === 'off' || !dest) {
      uploadNote = '（当前设置不上传文件，图片已存在本地）';
    } else if (!deliverPath) {
      uploadNote = '⚠️ 没有生成可上传的文件（PDF 不可用），图片已存在本地';
    } else {
      record.stage = 'upload';
      const size = fs.statSync(deliverPath).size;
      const limit = c.maxUploadMB * 1024 * 1024;
      if (size > limit) {
        if (c.rejectOversize) {
          uploadNote = `⚠️ 文件 ${humanSize(size)} 超过单文件上限 ${c.maxUploadMB} MB，按设置没有上传（可调大上限或允许分卷）`;
        } else {
          const parts = splitForUpload(deliverPath, limit);
          uploadNote = `📦 文件 ${humanSize(size)} 超过 ${c.maxUploadMB} MB，已分成 ${parts.length} 卷上传`;
          let sent = 0;
          for (const part of parts) {
            const r = await uploadFile({
              onebot, chatKey: dest, filePath: part, name: path.basename(part),
              publish: c.uploadMode !== 'off', checkQuota: c.checkQuota,
            });
            if (r.ok) {
              sent += 1;
              rememberGroupFile(dest, r.fileId, path.basename(part));
            } else {
              uploadNote += `\n第 ${sent + 1} 卷上传失败：${r.error}`;
              break;
            }
          }
          if (sent === parts.length) uploadNote += `，全部成功`;
        }
      } else {
        const r = await uploadFile({
          onebot, chatKey: dest, filePath: deliverPath, name: deliverName || path.basename(deliverPath),
          checkQuota: c.checkQuota,
        });
        if (r.ok) {
          rememberGroupFile(dest, r.fileId, deliverName || path.basename(deliverPath));
          uploadNote = dest.startsWith('group:')
            ? `📎 已上传到本群群文件：${deliverName || path.basename(deliverPath)}（${humanSize(size)}）`
            : `📎 已发送文件：${deliverName || path.basename(deliverPath)}（${humanSize(size)}）`;
        } else {
          uploadNote = `⚠️ 文件上传失败：${r.error}`;
        }
      }
    }

    // ④ 按需删除原图（省空间模式）
    // 顺序说明：删除排在"上传"之后 —— 上传用的是 PDF 而不是原图，
    //          放在这里还能保证"上传失败时原图仍在"，便于重发补传。
    const wantCleanup = c.deleteImagesAfterPdf && c.outputFormat === 'pdf' && Boolean(pdfInfo);

    let cleanup = null;
    if (wantCleanup) {
      cleanup = await deleteImages(dl.albumDir);
      record.deletedImages = cleanup.files;
      record.freedBytes = cleanup.freed;
      log(`已删除原图 ${cleanup.files} 个（释放 ${humanSize(cleanup.freed)}），只保留 PDF：${dl.albumDir}`);
      // 在 metadata 里留痕：这本的原图已被删除（事后能说清"为什么只剩 PDF"）
      try {
        const metaPath = path.join(dl.albumDir, 'metadata.json');
        const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        meta.deletedImages = true;
        meta.deletedAt = new Date().toISOString();
        meta.freedBytes = cleanup.freed;
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      } catch (error) {
        warn(`metadata 更新删除标记失败（不影响结果）：${error?.message ?? error}`);
      }
    } else if (c.deleteImagesAfterPdf && !pdfInfo) {
      // 用户开了省空间，但 PDF 没生成 → 明确说明"没删"，避免他以为删了
      warn(`设置了「合成 PDF 后删除原图」，但本次 PDF 未生成 → 已保留原图，未做删除`);
    }

    // ⑤ 汇报
    const lines = [];
    lines.push(`✅ 「${dl.album.name}」（JM${dl.album.id}）处理好啦`);
    lines.push(`共 ${dl.chapters.length} 话 · 图片 ${dl.totals.ok}/${dl.totals.total} 张`);
    if (pdfInfo) {
      lines.push(`PDF ${pdfInfo.pages} 页（${humanSize(pdfInfo.bytes)}）${c.restore ? `，已还原竖切 ${pdfInfo.restored} 张` : ''}`);
    }
    if (record.pdfError) lines.push(`PDF 没生成：${record.pdfError}`);
    if (uploadNote) lines.push(uploadNote);
    if (cleanup) {
      lines.push(`🧹 已删除原图 ${cleanup.files} 个，释放 ${humanSize(cleanup.freed)}，本地只保留 PDF`);
    } else if (c.deleteImagesAfterPdf && !pdfInfo) {
      lines.push('⚠️ 本次 PDF 未生成，已保留原图（未按省空间设置删除）');
    }
    lines.push(`本地目录：${dl.albumDir}`);
    if (dl.totals.fail > 0) lines.push(`有 ${dl.totals.fail} 张没下下来，重发同一个 ID 会接着补下。`);
    await say(lines.join('\n'));

    record.stage = 'done';
    record.ok = true;
    record.finishedAt = Date.now();
    pushHistory(record);
    return record;
  } catch (error) {
    record.stage = 'failed';
    record.error = humanize(error?.message ?? String(error));
    record.finishedAt = Date.now();
    pushHistory(record);
    await say(`❌ JM${albumId} 处理失败：${record.error}`);
    warn(`JM${albumId} 任务失败：${error?.stack ?? error}`);
    return record;
  }
}

/** 上传目标：按设置决定传到哪个会话。 */
function resolveUploadTarget(c, chatKey, kind) {
  if (c.uploadMode === 'off') return '';
  if (c.uploadMode === 'request') return chatKey; // 在哪个会话提出就传回哪里
  if (c.uploadMode === 'group') return String(kind) === 'group' ? chatKey : '';
  if (c.uploadMode === 'private') return String(kind) === 'private' ? chatKey : '';
  return chatKey;
}

/**
 * 删除某一本的所有原始图片，只保留 PDF 与 metadata.json（"省空间"模式）。
 *
 * 三道保险，缺一不可：
 *   ① 调用方必须已确认 PDF 生成成功（PDF 失败时绝不删，否则等于白下）
 *   ② 目标路径必须在 albumDir 之内（解析后 path.relative 校验，防误删）
 *   ③ 只删图片后缀的文件（不碰 .pdf / .partNofM / metadata.json）
 *
 * @returns {Promise<{freed:number, files:number, dirs:number}>} 释放的字节数与文件数
 */
async function deleteImages(albumDir) {
  const result = { freed: 0, files: 0, dirs: 0 };
  if (!albumDir || !fs.existsSync(albumDir)) return result;

  const rootResolved = path.resolve(albumDir);
  // ⚠️ 必须用严格版（isImageFileName）：suffixOf() 会把 .pdf/.json 回退成 '.jpg'，
  //    用它做删除判断会把 PDF 和 metadata.json 一起删掉（实测踩过）。
  const isImage = (name) => engine.isImageFileName(name);
  const isPart = (name) => /\.part\d+of\d+\.[a-z0-9]+$/i.test(name);

  // 先删文件，再自底向上清理空目录
  async function walk(dir, depth = 0) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const target = path.join(dir, e.name);
      // 保险②：必须仍在本子目录之内
      const rel = path.relative(rootResolved, path.resolve(target));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        warn(`跳过可疑路径（不在本子目录内）：${target}`);
        continue;
      }
      if (e.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      // 保险③：只删图片，且分卷文件不动
      if (!isImage(e.name) || isPart(e.name)) continue;
      // 保险④：白名单永不动（万一上面的后缀判定哪天又出错，这一条兜底）
      if (/\.pdf$/i.test(e.name) || e.name.toLowerCase() === 'metadata.json') {
        warn(`跳过受保护文件：${e.name}`);
        continue;
      }
      try {
        const size = (await fsp.stat(target)).size;
        await fsp.unlink(target);
        result.freed += size;
        result.files += 1;
      } catch (error) {
        warn(`删除原图失败（已跳过）：${e.name} — ${error?.message ?? error}`);
      }
    }
    // 目录空了就删掉（最后只留下 PDF 与 metadata.json 所在的根目录）
    if (depth > 0) {
      try {
        if ((await fsp.readdir(dir)).length === 0) {
          await fsp.rmdir(dir);
          result.dirs += 1;
        }
      } catch {
        /* 非空或已被删，忽略 */
      }
    }
  }

  await walk(rootResolved);
  return result;
}

/** 分卷（超过单文件上限时）。 */
function splitForUpload(filePath, maxBytes) {
  const size = fs.statSync(filePath).size;
  const parts = Math.max(2, Math.ceil(size / maxBytes));
  const chunk = Math.ceil(size / parts);
  const ext = (filePath.match(/\.[a-zA-Z0-9]{1,6}$/) || [''])[0];
  const stem = ext ? filePath.slice(0, -ext.length) : filePath;
  const out = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let i = 0; i < parts; i++) {
      const start = i * chunk;
      const len = Math.min(chunk, size - start);
      if (len <= 0) break;
      const target = `${stem}.part${i + 1}of${parts}${ext}`;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.writeFileSync(target, buf);
      out.push(target);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function humanize(msg) {
  const s = String(msg);
  if (/所有禁漫域名都连不上/.test(s)) return s;
  if (/album_missing|本子.*不存在|章节.*不存在/.test(s)) return `这本子不存在或已被删除（原文：${s}）`;
  if (/Restricted Access|ip地区|HTTP 403/.test(s)) return `站点拒绝了本机 IP（可能需要挂代理，或在设置里换域名）。原文：${s}`;
  if (/超时|TimeoutError/.test(s)) return `请求超时（可能是网络慢或被限速）。可以调大「单次请求超时」。原文：${s}`;
  return s;
}

// ───────────────────────── 发消息 ─────────────────────────

async function sendText(sender, onebot, chatKey, text) {
  try {
    if (!chatKey || !text) return;
    if (sender?.sendTextBatch) {
      await sender.sendTextBatch(chatKey, [text]);
      return;
    }
    const [kind, id] = String(chatKey).split(':');
    if (onebot?.sendSegments) await onebot.sendSegments(kind, id, [{ type: 'text', data: { text: String(text) } }]);
  } catch (error) {
    warn(`发消息失败（不影响任务）：${error?.message ?? error}`);
  }
}

// ───────────────────────── 群文件到期删除 ─────────────────────────

const uploadedGroupFiles = new Map(); // `${groupId}:${fileId}` -> { name, at, onebot }

function rememberGroupFile(chatKey, fileId, name) {
  if (!String(chatKey).startsWith('group:') || !fileId) return;
  uploadedGroupFiles.set(`${chatKey}:${fileId}`, { chatKey, fileId, name, at: Date.now() });
}

async function cleanupGroupFiles() {
  const days = cfg().groupFileKeepDays;
  if (!days) return;
  const deadline = Date.now() - days * 86400000;
  for (const [key, item] of uploadedGroupFiles) {
    if (item.at > deadline) continue;
    uploadedGroupFiles.delete(key);
    const onebot = currentOnebotRef;
    if (!onebot) continue;
    const [, groupId] = String(item.chatKey).split(':');
    const r = await deleteGroupFile(onebot, groupId, item.fileId);
    log(`群文件到期清理：${item.name} → ${r.ok ? '已删除' : `删除失败 ${r.error}`}`);
  }
}

// 清理群文件需要一个 onebot 客户端；任务跑完时在上下文里取一个最可靠的
let currentOnebotRef = null;

// ───────────────────────── 本地文件清理 ─────────────────────────

async function cleanupLocal() {
  const days = cfg().keepDays;
  if (!days) return { removed: 0 };
  const root = downloadRoot();
  if (!fs.existsSync(root)) return { removed: 0 };
  const deadline = Date.now() - days * 86400000;
  let removed = 0;
  try {
    const groups = await fsp.readdir(root, { withFileTypes: true });
    for (const g of groups) {
      if (!g.isDirectory() || !/^jm-\d+$/.test(g.name)) continue;
      const gp = path.join(root, g.name);
      for (const item of await fsp.readdir(gp, { withFileTypes: true })) {
        const target = path.join(gp, item.name);
        try {
          const st = await fsp.stat(target);
          if (st.mtimeMs < deadline) {
            await fsp.rm(target, { recursive: true, force: true });
            removed += 1;
          }
        } catch {
          /* 单个失败不影响其它 */
        }
      }
      // 组目录空了就删掉
      try {
        if ((await fsp.readdir(gp)).length === 0) await fsp.rmdir(gp);
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    warn(`本地清理出错（已跳过）：${error?.message ?? error}`);
  }
  return { removed };
}

// ───────────────────────── 指令来源 ─────────────────────────

const callerKey = (ctx) => String(ctx?.sessionId || ctx?.chatKey || '');

function recordCallers(ctx = {}) {
  try {
    const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
    const key = callerKey(ctx);
    if (!key || !entries.length) return;
    const candidates = [];
    for (const e of entries) {
      if (e?.atMe === true) candidates.push({ id: String(e.senderId || ''), name: String(e.senderName || '') });
    }
    const last = entries[entries.length - 1];
    if (last) candidates.push({ id: String(last.senderId || ''), name: String(last.senderName || '') });
    callerLog.set(key, { candidates, at: Date.now() });
  } catch (error) {
    warn(`记录指令来源失败：${error?.message ?? error}`);
  }
}

// ───────────────────────── 生命周期 ─────────────────────────

export function setup(injected) {
  api = injected;
  void loadHistory();
  workerCache = { at: 0, result: null };

  // ── 工具 1：下载 ──────────────────────────────────────────────────────────
  api.registerTool({
    id: 'download_album',
    name: '下载禁漫漫画',
    category: 'media',
    icon: '📚',
    description:
      '把一本禁漫天堂（JMComic）漫画按 ID 下载到机器人本地，并（按设置）还原竖切、合成 PDF、'
      + '上传到「提出请求的这个会话」。'
      + '当群友发来漫画 ID（如 123456、jm123456、JM-123456）或 album 链接并希望下载时使用。'
      + '参数 album_id 传纯数字 ID（从对方消息里取，不要自己编）。'
      + '只在对方明确想下载时调用；消息里随便出现一个数字不要调用，拿不准先问一句。'
      + '这个工具是**异步入队**：调用后立刻返回，下载在后台进行，结果会自动发到群里，'
      + '不要因为看不到结果就重复调用同一个 ID。',
    parameters: {
      type: 'object',
      properties: {
        album_id: {
          type: ['integer', 'string'],
          description: '禁漫漫画 ID，纯数字，例如 123456（6~7 位）。也可传整条链接，工具会自己提取数字。',
        },
      },
      required: ['album_id'],
    },
    async execute(ctx, args) {
      const chatKey = String(ctx?.chatKey || '');
      const albumId = engine.normalizeAlbumId(args?.album_id);
      try {
        const c = cfg();
        if (!c.enabled) {
          return { content: '漫画下载功能被关掉了（技能设置里的「启用下载功能」）。请让管理员打开。', isError: true };
        }
        if (!albumId) {
          return { content: '没有拿到有效的漫画 ID：album_id 必须是纯数字（例如 123456）。请从对方消息里取出数字再试。', isError: true };
        }
        if (activeTasks.has(albumId)) {
          const t = activeTasks.get(albumId);
          return { content: `JM${albumId} 已经在处理中（阶段：${t.stage}，已开始 ${Math.round((Date.now() - t.startedAt) / 1000)} 秒）。不要重复调用。` };
        }
        if (!chatKey) return { content: '拿不到会话信息，无法在群里汇报结果。请在群聊里再试一次。', isError: true };

        // 权限（工具的 ctx 里没有发送者，用钩子记下的 callerLog）
        const perm = await checkPermission(ctx);
        if (!perm.ok) return { content: perm.reason, isError: true };

        // 每个会话同时只跑一本，避免群友连发把机器人带宽/配额打满
        const running = activeByChat.get(chatKey);
        if (running) {
          return { content: `这个会话已经有一本（JM${running}）在处理了，等它结束再发下一本。` };
        }

        const c2 = cfg();
        const task = {
          albumId,
          chatKey,
          kind: String(ctx?.kind || ''),
          who: perm.caller?.id || '',
          stage: 'queued',
          startedAt: Date.now(),
          sender: ctx?.sender ?? null,
          onebot: ctx?.onebot ?? null,
        };
        activeTasks.set(albumId, task);
        activeByChat.set(chatKey, albumId);
        if (ctx?.onebot) currentOnebotRef = ctx.onebot;

        // 后台跑；这里立刻返回，不阻塞模型回合（这是本版最重要的改动）
        void (async () => {
          try {
            await runJob(task);
          } catch (error) {
            warn(`后台任务异常（已记录）：${error?.stack ?? error}`);
          } finally {
            activeTasks.delete(albumId);
            if (activeByChat.get(chatKey) === albumId) activeByChat.delete(chatKey);
            void cleanupGroupFiles();
          }
        })();

        const worker = detectWorker();
        const plan = [
          c2.outputFormat === 'pdf' ? '合成 PDF' : '保留图片',
          c2.restore && worker.ok ? '还原竖切' : '',
          c2.uploadMode === 'off' ? '不上传' : '上传到本会话',
        ].filter(Boolean).join(' + ');

        return {
          content:
            `JM${albumId} 已经排上队开始处理了（${plan}）。`
            + '进度和结果会自动发到群里，你不需要再说什么、更不要重复调用这个工具；'
            + '只用一句话告诉群友「已开始处理，稍等」即可。',
        };
      } catch (error) {
        activeTasks.delete(albumId);
        if (activeByChat.get(chatKey) === albumId) activeByChat.delete(chatKey);
        warn(`入队失败 JM${albumId}：${error?.message ?? error}`);
        return { content: `排任务失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // ── 工具 2：查任务状态 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'task_status',
    name: '查询漫画下载进度',
    category: 'media',
    icon: '⏳',
    description:
      '查询正在处理的漫画下载任务，以及最近的处理记录（成功/失败原因）。'
      + '当群友问「下好了吗」「刚才那个怎么没动静」「为什么失败了」时使用。无参数。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        await loadHistory();
        const chatKey = String(ctx?.chatKey || '');
        const lines = [];

        const mine = [...activeTasks.values()].filter((t) => !chatKey || t.chatKey === chatKey);
        if (mine.length) {
          lines.push(`正在处理 ${mine.length} 本：`);
          for (const t of mine) {
            lines.push(`· JM${t.albumId}（${t.stage}，已 ${Math.round((Date.now() - t.startedAt) / 1000)} 秒）`);
          }
        } else {
          lines.push('当前没有正在处理的下载。');
        }

        const recent = taskHistory.filter((h) => !chatKey || h.chatKey === chatKey).slice(0, 5);
        if (recent.length) {
          lines.push('', '最近记录：');
          for (const h of recent) {
            const when = String(h.at || '').slice(5, 16).replace('T', ' ');
            lines.push(h.ok
              ? `· ${when} JM${h.id}「${h.title || ''}」成功，${h.pagesOk || 0}/${h.pages || 0} 张${h.pdf ? '，PDF 已生成' : ''}`
              : `· ${when} JM${h.id} 失败（${h.stage}）：${h.error || '未知原因'}`);
          }
        }
        const root = downloadRoot();
        lines.push('', `本地目录：${root}`);
        return { content: lines.join('\n') };
      } catch (error) {
        warn(`查询任务状态失败：${error?.message ?? error}`);
        return { content: `查询失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // ── 工具 3：本地收藏 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'library',
    name: '查看本地漫画收藏',
    category: 'media',
    icon: '🗂️',
    description:
      '列出机器人本地已经下载好的禁漫漫画（每本一行：ID、名称、图片数、时间）。'
      + '当群友问「本地有哪几本」「收藏里有没有 xxx」时使用。无参数。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const root = downloadRoot();
        if (!fs.existsSync(root)) return { content: `本地还没有任何漫画（目录 ${root} 还不存在）。` };
        const entries = await scanLibrary(root);
        if (!entries.length) return { content: '本地收藏是空的。群友把漫画 ID 发给我就能下。' };
        entries.sort((a, b) => b.mtime - a.mtime);
        const lines = entries.slice(0, 30).map((e) => {
          const when = new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ');
          return `· JM${e.id}「${e.name}」${e.pages ? `${e.pages} 张 · ` : ''}${e.pdf ? '有 PDF · ' : ''}${when}`;
        });
        return {
          content: `本地收藏共 ${entries.length} 本（列出最近 ${Math.min(30, entries.length)} 本）：\n${lines.join('\n')}\n\n目录：${root}`,
        };
      } catch (error) {
        warn(`读取本地收藏失败：${error?.message ?? error}`);
        return { content: `读取本地收藏失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // ── 工具 4：存储与能力自检 ────────────────────────────────────────────────
  api.registerTool({
    id: 'storage',
    name: '查看存储与能力状态',
    category: 'system',
    icon: '🔧',
    description:
      '查看这个技能的环境状态：下载目录占用、是否具备还原/PDF 能力（Python + Pillow）、'
      + '当前群的群文件配额。当群友问「支持 PDF 吗」「磁盘满了吗」「群文件还有空间吗」时使用。无参数。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const c = cfg();
        const root = downloadRoot();
        const usage = await dirSize(root);
        const worker = detectWorker(true);
        const lines = [
          `下载目录：${root}`,
          `已占用：${humanSize(usage.bytes)}（${usage.files} 个文件）`,
          `清理策略：本地保留 ${c.keepDays || '不'} 天${c.groupFileKeepDays ? `，群文件 ${c.groupFileKeepDays} 天后自动删除` : ''}`,
          `输出格式：${c.outputFormat === 'pdf' ? 'PDF' : '原始图片'}${c.restore ? '（开启竖切还原）' : ''}`,
          `合成 PDF 后删除原图：${c.deleteImagesAfterPdf ? '已开启（PDF 失败时会自动保留原图）' : '未开启'}`,
          `还原/PDF 能力：${worker.ok
            ? `可用（Python ${worker.python.split(/[\\/]/).pop()}，Pillow ${worker.pillow}）`
            : `不可用 —— ${worker.error}。会降级为原样保存图片。`}`,
          `上传模式：${{ off: '不上传', request: '传回提出请求的会话', group: '只传群', private: '只传私聊' }[c.uploadMode]}`,
          `单文件上限：${c.maxUploadMB} MB${c.rejectOversize ? '（超限拒绝）' : '（超限自动分卷）'}`,
          `允许触发：${c.allowIds ? `仅管理员/白名单（${c.allowIds}）` : '所有人'}`,
        ];
        if (String(ctx?.kind) === 'group' && ctx?.onebot) {
          const q = await groupQuota(ctx.onebot, ctx.chatId);
          lines.push(q.ok
            ? `本群群文件：${q.fileCount}/${q.limitCount} 个，已用 ${humanSize(q.usedSpace)} / ${humanSize(q.totalSpace)}`
            : `本群群文件配额查询失败：${q.error}`);
        }
        return { content: lines.join('\n') };
      } catch (error) {
        warn(`存储自检失败：${error?.message ?? error}`);
        return { content: `自检失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // 定时清理（本地 + 群文件）。activate 里起，deactivate 里必须清掉。
  log(`禁漫漫画下载技能已加载（目录：${downloadRoot()}，输出：${cfg().outputFormat}）`);
}

export function activate() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    void cleanupLocal();
    void cleanupGroupFiles();
  }, 6 * 3600 * 1000);
  // 启动时先跑一次，别等 6 小时
  setTimeout(() => {
    void cleanupLocal();
  }, 20000);
  log('已启动：定时清理与任务队列就绪');
}

export function deactivate() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  log('已停用：定时清理已停止（正在进行的下载任务不会被中断）');
}

export function dispose() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
  activeTasks.clear();
  activeByChat.clear();
  callerLog.clear();
  pendingHint.clear();
  uploadedGroupFiles.clear();
  currentOnebotRef = null;
}

// ───────────────────────── 目录统计 / 收藏扫描 ─────────────────────────

async function dirSize(root) {
  let bytes = 0;
  let files = 0;
  async function walk(p) {
    let entries = [];
    try {
      entries = await fsp.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const target = path.join(p, e.name);
      if (e.isDirectory()) {
        await walk(target);
      } else {
        try {
          bytes += (await fsp.stat(target)).size;
          files += 1;
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root);
  return { bytes, files };
}

async function scanLibrary(root) {
  const out = [];
  let groups = [];
  try {
    groups = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const groupPath = path.join(root, g.name);
    let subs = [];
    try {
      subs = await fsp.readdir(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const dir = path.join(groupPath, sub.name);
      let meta = null;
      try {
        meta = JSON.parse(await fsp.readFile(path.join(dir, 'metadata.json'), 'utf8'));
      } catch {
        meta = null;
      }
      let mtime = Date.now();
      let pdf = false;
      try {
        mtime = (await fsp.stat(dir)).mtimeMs;
        pdf = (await fsp.readdir(dir)).some((f) => f.toLowerCase().endsWith('.pdf'));
      } catch {
        /* ignore */
      }
      const m = String(sub.name).match(/^(\d+)-(.*)$/);
      out.push({
        id: meta?.id || (m ? m[1] : String(g.name).replace(/^jm-/, '')),
        name: meta?.name || (m ? m[2] : sub.name),
        pages: Number(meta?.pagesOk || meta?.pages || 0) || 0,
        pdf,
        mtime,
      });
    }
  }
  return out;
}

// ───────────────────────── 钩子 ─────────────────────────
// ⚠️ 只有 5 个钩子名有效；工具的 ctx 里没有 triggerEntries，"谁在下指令"只能在这里记。

export const hooks = {
  async 'before-tool'(ctx = {}) {
    try {
      recordCallers(ctx);
    } catch (error) {
      warn(`before-tool 钩子出错（已跳过）：${error?.message ?? error}`);
    }
  },

  /** 组装提示词前：本轮出现"像漫画 ID"的内容时，记下来并在消息正文里补一句。 */
  async 'before-context'(ctx = {}) {
    try {
      recordCallers(ctx);
      if (!api || cfg().enabled === false) return;
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];

      let hit = null;
      for (const e of entries) {
        if (!e || e.self) continue;
        const text = String(e.text || '');
        // ① 明确写了 jm / JM 前缀，或发了 album/photo 链接 —— 高置信（数字要带边界）
        let m = text.match(/(?:^|[^0-9a-zA-Z])(?:jm|JM|Jm)[\s\-_:：#]*(\d{2,9})(?!\d)/)
          || text.match(/\/(?:album|photo)\/(\d{2,9})(?!\d)/);
        let strong = Boolean(m);
        // ② 只有 @ 了机器人 + 一句纯数字 —— 也认为是"让我下这本"
        if (!m && e.atMe === true) {
          const bare = text.replace(/@\S+\s*/g, '').trim().match(/^#?(\d{2,9})$/);
          if (bare) {
            m = bare;
            strong = true;
          }
        }
        if (m && strong) hit = { id: m[1], who: String(e.senderName || e.senderId || '群友'), entry: e };
      }
      if (!hit) return;

      // 两条路都走：① 直接改本轮消息文本；② 留到 before-llm-messages 补 system 消息
      const note = `（这条消息里的 ${hit.id} 看起来是禁漫漫画 ID，来自 ${hit.who}。）`;
      const target = hit.entry;
      if (target && !String(target.text || '').includes('禁漫漫画 ID')) target.text = `${String(target.text || '')}${note}`;
      pendingHint.set(callerKey(ctx), { id: hit.id, who: hit.who, at: Date.now() });
    } catch (error) {
      warn(`before-context 钩子出错（已跳过）：${error?.message ?? error}`);
    }
  },

  /** 即将发给模型之前：把 ID 提示补成一条 system 消息（messages 是引用，可原地改）。 */
  async 'before-llm-messages'(ctx = {}) {
    try {
      const rec = pendingHint.get(callerKey(ctx));
      if (!rec || Date.now() - rec.at > 120_000) return;
      pendingHint.delete(callerKey(ctx));
      if (!Array.isArray(ctx.messages)) return;
      const content =
        `[jm-comic] 本轮消息里出现了禁漫漫画 ID ${rec.id}（来自 ${rec.who}）。`
        + '如果对方是想让你下载这本漫画（或你上一轮已经答应帮他下），现在就调用工具 '
        + `jm-comic__download_album，album_id 填 ${rec.id}；`
        + '如果只是顺口提到的数字，不要调用，先问一句确认。这个工具是异步的，调用后会立刻返回，不要重复调用。';
      if (ctx.messages.some((m) => String(m?.content || '').includes(`[jm-comic] 本轮消息里出现了禁漫漫画 ID ${rec.id}`))) return;
      ctx.messages.push({ role: 'system', content });
    } catch (error) {
      warn(`before-llm-messages 钩子出错（已跳过）：${error?.message ?? error}`);
    }
  },
};

// ───────────────────────── 可用性自检 ─────────────────────────

export function available() {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: '技能设置里的「启用下载功能」是关的' };
  if (!fetchImpl()) return { ok: false, reason: '当前运行环境没有可用的 fetch，无法联网下载' };
  const root = downloadRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `下载目录不可写（${root}）：${error?.message ?? error}` };
  }
  // Python/Pillow 缺失只是降级，不算不可用 —— 这里把状态说清楚，UI 里能看到
  const worker = detectWorker();
  if (c.outputFormat === 'pdf' && c.restore && !worker.ok) {
    return {
      ok: true,
      reason: '',
      detail: `PDF/还原不可用（${worker.error}），会降级为「原样保存图片」。装好 Pillow 或在设置里填 Python 路径即可启用。`,
    };
  }
  return { ok: true, detail: worker.ok ? `PDF/还原可用（Pillow ${worker.pillow}）` : '' };
}

export function promptSections() {
  const c = cfg();
  const worker = detectWorker();
  const bits = [];
  if (c.outputFormat === 'pdf' && worker.ok) {
    bits.push(`下载完成后会${c.restore ? '还原竖切并' : ''}合成 PDF`);
  } else {
    bits.push('下载完成后保留原始图片（不生成 PDF）');
  }
  if (c.uploadMode === 'off') bits.push('不会上传文件，只保存在机器人本地');
  else bits.push('会把文件上传到提出请求的那个会话（群文件 / 私聊文件）');
  if (c.allowIds) bits.push('只有管理员或白名单 QQ 才能触发下载');

  return [{
    id: 'jm-comic-rules',
    title: '禁漫漫画下载',
    priority: 50,
    content:
      '本群开了「禁漫漫画下载」技能。规则：\n'
      + `1. 有人发来禁漫漫画 ID（纯数字，如 123456，也常写成 jm123456 或 /album/123456）并想下载时，`
      + '调用 jm-comic__download_album，把数字放进 album_id。\n'
      + '2. 只在对方明确想下载时调用；群里随便出现的数字不要调用，拿不准先问一句确认。\n'
      + '3. 这个工具是**异步**的：调用后立刻返回，下载/还原/合成/上传都在后台跑，完成后会自动发消息。'
      + '**不要因为没立刻看到结果就重复调用同一个 ID。**\n'
      + '4. 对方问进度或「怎么没动静」时，调用 jm-comic__task_status；问「本地有哪几本」用 jm-comic__library；'
      + '问「支持 PDF 吗 / 磁盘满了吗 / 群文件还有空间吗」用 jm-comic__storage。\n'
      + '5. 你只需要用一两句话简短回应（本子名 + 页数 + 是否开始处理），**不要复述目录、不要罗列文件名**。\n'
      + '6. 失败时把工具返回的原因如实转达，并给出可照做的下一步，不要编造成功。\n'
      + '7. 这是成人向内容，只在群友主动索要时处理，不要主动推荐、不要描述内容。\n'
      + `当前设置：${bits.join('；')}。`,
  }];
}
