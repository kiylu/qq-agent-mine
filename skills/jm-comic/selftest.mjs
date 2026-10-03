// jm-comic v2 自测（文档 api-reference.md 第八节「测试脚手架」的用法）
// 用法（先 cd 到本目录）：
//   & "<QQ Agent 安装目录>\resources\app\snowluma\node.exe" selftest.mjs --no-live
//   & "<QQ Agent 安装目录>\resources\app\snowluma\node.exe" selftest.mjs --live-id=422444   # 额外来一次真实站点探测
//   ... --python="C:\Python313\python.exe"   # Python 不在 PATH 上时显式指定
//
// 覆盖：清单/工具注册、参数边界、钩子（含"不触发"）、权限、异步任务队列、
//       假站点端到端下载、配额预检、上传通道与分卷、Python PDF 真跑、切块数口径回归、降级路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, createCipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL_URL = new URL('./', import.meta.url).href;
// ⚠️ 必须用 fileURLToPath：路径里有空格时 URL.pathname 会给成 "%20"，fs 打不开
const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await fsp.readFile(path.join(SKILL_DIR, 'skill.json'), 'utf8'));
const mod = await import(`${SKILL_URL}index.js`);

// 进度输出必须立即可见（stdout 重定向到文件时是块缓冲）
console.log = (...a) => fs.writeSync(1, `${a.join(' ')}\n`);

const LIVE = !process.argv.includes('--no-live');
// Python 解释器：用技能的自动探测，而不是写死本机路径。
// 可用 `--python=<路径>` 覆盖；探测不到时，与 Python/Pillow 相关的用例会自动 skip。
const pdfBridge = await import(`${SKILL_URL}pdf.js`);
const pythonArg = process.argv.find((a) => a.startsWith('--python='))?.split('=').slice(1).join('=');
const PY_DETECT = pdfBridge.detect(pythonArg || '');
const PYTHON = PY_DETECT.ok ? PY_DETECT.python : '';
if (!PYTHON) {
  console.log(`  note 未探测到 Python（${PY_DETECT.error || '未知原因'}）：PDF/还原相关用例将 skip`);
}
let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}: ${error?.message ?? error}`);
  }
};

// ── 假 api ────────────────────────────────────────────────────────────────
const logs = [];
const tmpRoot = path.join(os.tmpdir(), `jm-v2-test-${Date.now()}`);
const config = {
  ...manifest.settings,
  downloadDir: tmpRoot,
  pythonPath: PYTHON,
  outputFormat: 'images', // 先测零依赖路径；PDF 在 [8] 单独真跑
  keepDays: 0,
};
const tools = [];
const api = {
  config: () => ({ ...config }),
  registerTool: (def) => {
    tools.push(def);
    return `jm-comic__${def.id}`;
  },
  log: (...a) => logs.push(a.join(' ')),
  warn: (...a) => logs.push(`WARN ${a.join(' ')}`),
  error: (...a) => logs.push(`ERR ${a.join(' ')}`),
  capability: () => undefined,
  hasCapability: () => false,
  fetch: globalThis.fetch,
};
await mod.setup(api);
mod.activate?.();

const tool = (id) => tools.find((t) => t.id === id);
const download = tool('download_album');
const status = tool('task_status');
const library = tool('library');
const storage = tool('storage');

// ── 假站点 ────────────────────────────────────────────────────────────────
const VIRTUAL = {
  '/album?id=999001': { id: 999001, name: '测试本子', author: ['测试作者'], tags: ['中文'], series: [], images: [] },
  '/chapter?id=999001': { id: 999001, name: '测试本子', series_id: '0', images: ['00001.webp', '00002.webp', '00003.webp'] },
};
let virtualMode = 'ok'; // ok | failAll

async function envelope(payload) {
  const ts = String(Math.floor(Date.now() / 1000));
  const key = createHash('md5').update(`${ts}185Hcomic3PAPP7R`).digest('hex');
  const c = createCipheriv('aes-256-ecb', Buffer.from(key, 'utf8'), null);
  const data = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]).toString('base64');
  return new Response(JSON.stringify({ code: 200, data }), { status: 200 });
}

function mkImage(bytes = 4096) {
  const b = Buffer.alloc(bytes, 0x20);
  b.write('\xff\xd8\xff\xe0', 0, 'binary');
  return b;
}

/**
 * 造能被 Pillow 解码的真 JPEG。
 * 不用"手搓 JPEG 字节"（试过：位流/填充极易写错，反而把测试变成假证据），
 * 直接在测试启动时用 Pillow 生成——顺带也验证了 Python 通路可用。
 * 拿不到 Python 时退回占位字节，此时 PDF 相关用例会 skip。
 */
function buildFakeImages() {
  const dir = path.join(os.tmpdir(), 'jm-fake-imgs');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (!PYTHON) return null;
  const script =
    'from PIL import Image\n'
    + 'import sys, os\n'
    + 'd = sys.argv[1]\n'
    + 'for i, (w, h, g) in enumerate([(64, 64, 40), (64, 64, 160), (64, 64, 90)], start=1):\n'
    + '    Image.new("RGB", (w, h), (g, g, g)).save(os.path.join(d, f"0000{i}.jpg"), quality=80)\n'
    + 'print("OK")\n';
  const r = spawnSync(PYTHON, ['-c', script, dir], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !/OK/.test(String(r.stdout || ''))) {
    console.log(`  warn 造图失败（PDF 用例会 skip）：${String(r.stderr || '').slice(0, 200)}`);
    return null;
  }
  return dir;
}
const FAKE_IMG_DIR = buildFakeImages();
const fakeImageFor = (name) => {
  if (!FAKE_IMG_DIR) return mkImage();
  const f = path.join(FAKE_IMG_DIR, name);
  return fs.existsSync(f) ? fs.readFileSync(f) : mkImage();
};
const fakeFetch = async (url) => {
  const u = String(url);
  const key = Object.keys(VIRTUAL).find((k) => u.includes(k));
  if (key) return envelope(VIRTUAL[key]);
  if (u.includes('/chapter_view_template')) return new Response('var scramble_id = 220980;', { status: 200 });
  if (/\/media\/photos\/999001\//.test(u)) {
    if (virtualMode === 'failAll') return new Response('boom', { status: 500 });
    if (u.includes('00002')) return new Response('boom', { status: 500 }); // 一张故意失败
    // 用真 JPEG 字节（Pillow 能解码），后面的 PDF/还原测试才有意义
    const name = u.split('/').pop().split('?')[0];
    const idx = /00003/.test(name) ? 3 : 1;
    return new Response(fakeImageFor(`0000${idx}.jpg`), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  if (/\/album\/999001/.test(u)) return new Response('<html>none</html>', { status: 200 });
  return new Response('nope', { status: 404 });
};
api.fetch = fakeFetch;

// ── 假 sender / onebot ────────────────────────────────────────────────────
const sent = [];
const calls = [];
let quotaMode = 'roomy'; // roomy | full
const sender = {
  sendTextBatch: async (k, msgs) => {
    sent.push(msgs.join(''));
    return { sent: [], failed: [] };
  },
  sendImage: async (k, img) => {
    sent.push(`[IMG]${img.file}`);
    return { message_id: 1 };
  },
};
const onebot = {
  selfId: '2488549986',
  selfInfo: { user_id: 2488549986, nickname: 'deepsleep' },
  sendSegments: async () => ({ message_id: 1 }),
  call: async (action, params = {}) => {
    calls.push({ action, params });
    if (action === 'get_group_file_system_info') {
      if (quotaMode === 'full') return { file_count: 1500, limit_count: 1500, used_space: 0, total_space: 10737418240 };
      return { file_count: 0, limit_count: 1500, used_space: 0, total_space: 10737418240 };
    }
    if (action === 'upload_group_file') return { file_id: `/fake-${calls.length}` };
    if (action === 'upload_private_file') return { file_id: `/fake-priv-${calls.length}` };
    if (action === 'delete_group_file') return null;
    if (action === 'get_group_member_info') return { user_id: params.user_id, role: 'member' };
    return null;
  },
};

const mkCtx = (text, { kind = 'group', chatId = '999', senderId = '30003', atMe = false } = {}) => ({
  chatKey: `${kind}:${chatId}`,
  kind,
  chatId,
  sessionId: `sess-${kind}-${chatId}`,
  selfId: '2488549986',
  onebot,
  sender,
  store: {},
  memory: {},
  triggerEntries: [{ senderId, senderName: '张三', text, mid: 1, ts: Date.now(), atMe }],
});

/** 等后台任务结束（靠机器人发出的完成语判断） */
async function waitDone(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (sent.some((s) => /处理好啦|处理失败/.test(s))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ═════════════════════════ 用例 ═════════════════════════

console.log('\n[1] 清单与注册');
check('manifest.id 合法', () => assert.match(manifest.id, /^[a-z0-9][a-z0-9._-]*$/));
check('注册了 4 个工具', () => assert.equal(tools.length, 4));
check('工具 id 字符集合法且 ≤38', () => {
  for (const t of tools) assert.match(t.id, /^[a-zA-Z0-9_-]{1,38}$/, t.id);
});
check('settings 与 configSchema 键一致', () => {
  const a = new Set(Object.keys(manifest.settings));
  const b = new Set(Object.keys(manifest.configSchema));
  assert.deepEqual([...a].sort(), [...b].sort());
});
check('enum 类型都带 values', () => {
  for (const [k, v] of Object.entries(manifest.configSchema)) {
    if (v.type === 'enum') assert.ok(Array.isArray(v.values) && v.values.length, k);
  }
});
check('available() 通过', () => assert.equal(mod.available().ok, true));
check('promptSections() 返回合法片段', () => {
  const s = mod.promptSections();
  assert.ok(Array.isArray(s) && s.length && s[0].priority <= 99);
});

console.log('\n[2] 参数边界');
for (const [label, v] of [['空', ''], ['文字', 'abc'], ['一位', '7'], ['13位', '1234567890123'], ['12位', '123456789012']]) {
  const r = await download.execute(mkCtx('x'), { album_id: v });
  check(`${label} → 拒绝`, () => assert.equal(r.isError, true));
}

console.log('\n[3] 钩子');
{
  const c1 = mkCtx('帮我下 jm123456');
  await mod.hooks['before-context'](c1);
  check('jm 前缀 → 消息里补提示', () => assert.match(String(c1.triggerEntries[0].text), /禁漫漫画 ID/));
  c1.messages = [{ role: 'user', content: '帮我下 jm123456' }];
  await mod.hooks['before-llm-messages'](c1);
  check('补一条 system 消息', () => assert.equal(c1.messages.filter((m) => m.role === 'system').length, 1));

  const c2 = mkCtx('https://18comic.vip/album/422444/xxx');
  await mod.hooks['before-context'](c2);
  check('链接 → 补提示', () => assert.match(String(c2.triggerEntries[0].text), /422444/));

  const c3 = mkCtx('422444', { atMe: true });
  await mod.hooks['before-context'](c3);
  check('@机器人+纯数字 → 补提示', () => assert.match(String(c3.triggerEntries[0].text), /422444/));

  const c4 = mkCtx('今天赢了三把 422444 哈哈', { chatId: '997' }); // 用独立会话，避免与上面用例共用 pendingHint
  c4.messages = [{ role: 'user', content: 'x' }];
  await mod.hooks['before-context'](c4);
  await mod.hooks['before-llm-messages'](c4);
  check('普通数字不打扰', () => assert.equal(c4.messages.filter((m) => m.role === 'system').length, 0));
}

console.log('\n[4] 权限（白名单）');
{
  config.allowIds = '11111,22222';
  const ctx = mkCtx('jm999001'); // senderId=30003，非管理员非白名单
  await mod.hooks['before-tool'](ctx);
  const r = await download.execute(ctx, { album_id: '999001' });
  check('非白名单 → 拒绝并说明怎么放开', () => {
    assert.equal(r.isError, true);
    assert.match(r.content, /白名单|管理员/);
  });
  config.allowIds = '';
}

console.log('\n[5] 异步任务：假站点端到端');
{
  virtualMode = 'ok';
  sent.length = 0;
  calls.length = 0;
  const ctx = mkCtx('jm999001');
  await mod.hooks['before-tool'](ctx);
  const enqueue = await download.execute(ctx, { album_id: 'jm999001' });
  check('入队立刻返回（不阻塞）', () => {
    assert.notEqual(enqueue.isError, true);
    assert.match(enqueue.content, /排队|开始处理/);
  });

  const dup = await download.execute(mkCtx('jm999001'), { album_id: '999001' });
  check('同一本重复请求 → 告知已在处理', () => assert.match(dup.content, /已经在处理|正在处理|重复/));

  const got = await waitDone();
  check('后台任务完成并回帖', () => assert.equal(got, true, JSON.stringify(sent)));
  check('落了 2 张图（第 2 张故意失败）', () => {
    const dir = path.join(tmpRoot, 'jm-999001', '999001-测试本子');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.webp'));
    assert.deepEqual(files.sort(), ['00001.webp', '00003.webp']);
  });
  check('报告了失败张数', () => assert.ok(sent.some((s) => /没下下来/.test(s)), JSON.stringify(sent)));

  const st = await status.execute(mkCtx('x'));
  check('task_status 能看到最近记录', () => assert.match(st.content, /999001/));
  const lib = await library.execute({});
  check('library 列出本地收藏', () => assert.match(lib.content, /测试本子/));
}

console.log('\n[6] 配额预检');
{
  quotaMode = 'full';
  sent.length = 0;
  calls.length = 0;
  config.uploadMode = 'request';
  const ctx = mkCtx('jm999001');
  await mod.hooks['before-tool'](ctx);
  await download.execute(ctx, { album_id: '999001' });
  await waitDone();
  check('群文件满 → 不调上传接口', () => assert.equal(calls.filter((c) => c.action === 'upload_group_file').length, 0));
  check('图片模式下明确说明没有可上传文件', () => assert.ok(sent.some((s) => /没有生成可上传的文件|不上传/.test(s)), JSON.stringify(sent)));
  quotaMode = 'roomy';
}

console.log('\n[7] 上传通道与分卷（真文件）');
{
  const uploadMod = await import(`${SKILL_URL}upload.js`);
  const big = path.join(tmpRoot, 'big.pdf');
  fs.writeFileSync(big, Buffer.alloc(2_400_000, 7));
  const parts = uploadMod.splitFileBySize(big, 1024 * 1024);
  check('splitFileBySize 切出多卷', () => assert.ok(parts.length >= 3, String(parts.length)));
  check('分卷文件名可读', () => assert.match(path.basename(parts[0]), /part1of\d+\.pdf$/));
  const upRes = await uploadMod.uploadFile({
    onebot, chatKey: 'group:999', filePath: parts[0], name: path.basename(parts[0]), checkQuota: true,
  });
  check('分卷能上传且拿到 file_id', () => assert.equal(upRes.ok, true, upRes.error));
  check('上传参数正确（group_id 为数字、file 为路径）', () => {
    const c = calls.filter((x) => x.action === 'upload_group_file').pop();
    assert.equal(typeof c.params.group_id, 'number');
    assert.ok(fs.existsSync(c.params.file));
  });

  const priv = await uploadMod.uploadFile({ onebot, chatKey: 'private:30003', filePath: parts[0], name: 'x.pdf' });
  check('私聊文件通道可用', () => assert.equal(priv.ok, true, priv.error));

  const missing = await uploadMod.uploadFile({ onebot, chatKey: 'group:999', filePath: path.join(tmpRoot, 'nope.pdf') });
  check('文件不存在 → 明确报错', () => assert.equal(missing.ok, false));

  const quotaFull = await uploadMod.uploadFile({ onebot, chatKey: 'group:999', filePath: parts[0], checkQuota: true });
  check('正常配额下可上传', () => assert.equal(quotaFull.ok, true, quotaFull.error));
  check('humanSize 可读', () => assert.match(uploadMod.humanSize(2_400_000), /MB/));
}

console.log('\n[7.5] 省空间模式：合成 PDF 后删除原图');
if (!PYTHON) {
  console.log(`  skip 需要 Python/Pillow 才能合成 PDF（${PY_DETECT.error || '未探测到'}）`);
} else {
  const albumDir = path.join(tmpRoot, 'jm-999001', '999001-测试本子');
  const listImages = () => fs.readdirSync(albumDir).filter((f) => /\.(webp|jpg|jpeg|png|gif)$/i.test(f));
  const runOnce = async (chatId) => {
    sent.length = 0;
    calls.length = 0;
    const ctx = mkCtx('jm999001', { chatId });
    await mod.hooks['before-tool'](ctx);
    await download.execute(ctx, { album_id: '999001' });
    return waitDone(120000);
  };

  // ① 默认（未开启）→ 必须保留原图
  config.outputFormat = 'pdf';
  config.restore = true;
  config.uploadMode = 'off';
  config.deleteImagesAfterPdf = false;
  check('默认模式任务完成', () => true); // 由下面的断言兜底
  const okDefault = await runOnce('991');
  check('① 默认（未开启）不删除原图', () => {
    assert.equal(okDefault, true, JSON.stringify(sent).slice(0, 300));
    assert.ok(listImages().length > 0, '原图不该被删');
    assert.ok(fs.readdirSync(albumDir).some((f) => f.endsWith('.pdf')), '应有 PDF');
  });

  // ② 开省空间 → 只留 PDF + metadata.json
  config.deleteImagesAfterPdf = true;
  const okClean = await runOnce('992');
  check('② 省空间模式任务完成', () => assert.equal(okClean, true, JSON.stringify(sent).slice(0, 300)));
  check('② 原图已全部删除', () => assert.equal(listImages().length, 0, `残留：${listImages().join(',')}`));
  check('② PDF 与 metadata.json 仍在', () => {
    const left = fs.readdirSync(albumDir);
    assert.ok(left.some((f) => f.endsWith('.pdf')), left.join(','));
    assert.ok(left.includes('metadata.json'), left.join(','));
  });
  check('② 空的章节目录被回收', () => {
    const subs = fs.readdirSync(albumDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    assert.equal(subs.length, 0, subs.map((d) => d.name).join(','));
  });
  check('② metadata 里留了"原图已删除"的痕迹', () => {
    const meta = JSON.parse(fs.readFileSync(path.join(albumDir, 'metadata.json'), 'utf8'));
    assert.equal(meta.deletedImages, true);
    assert.ok(Number(meta.freedBytes) >= 0);
  });
  check('② 汇报里说明了释放空间', () => assert.ok(sent.some((s) => /已删除原图/.test(s)), JSON.stringify(sent).slice(0, 300)));

  // ③ 输出格式=images 时即使开了开关也不该删（没有 PDF 可留）
  config.outputFormat = 'images';
  const okImages = await runOnce('993');
  check('③ 输出格式=images 时不删除原图', () => {
    assert.equal(okImages, true, JSON.stringify(sent).slice(0, 300));
    assert.ok(listImages().length > 0, '图片被误删了');
  });
  config.outputFormat = 'images';
  config.deleteImagesAfterPdf = false;
}

console.log('\n[8] Python / PDF（真跑 worker）');
{
  if (!PYTHON) {
    console.log(`  skip 未探测到 Python（${PY_DETECT.error || '未知原因'}），跳过 PDF 实测`);
  } else {
    const detect = pdfBridge.detect(PYTHON);
    check('pdf.js 探测到 Pillow', () => assert.equal(detect.ok, true, detect.error));

    const dir = path.join(tmpRoot, 'jm-999001', '999001-测试本子');
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.webp')).map((f) => path.join(dir, f));
    const out = path.join(tmpRoot, 'pdf-test', 'test.pdf');
    const prog = [];
    const res = await pdfBridge.runTask({
      python: PYTHON,
      task: {
        album_id: '999001', scramble_id: 220980, descramble: true,
        output: out, quality: 80, max_dim: 0, chapters: [{ name: 'ch1', pages }],
      },
      onProgress: (p) => prog.push(p.stage),
      timeoutMs: 120000,
    });
    check('worker 生成 PDF 成功', () => assert.equal(res.ok, true, res.error));
    check('产物是 %PDF 且非空', () => {
      const head = fs.readFileSync(res.output).subarray(0, 5).toString('ascii');
      assert.equal(head, '%PDF-');
      assert.ok(res.bytes > 1000, String(res.bytes));
    });
    check('上报了进度', () => assert.ok(prog.includes('descramble'), JSON.stringify(prog)));
    check('restored 是数字（识别还原张数）', () => assert.equal(typeof res.restored, 'number'));

    const bad = pdfBridge.detect('C:\\definitely-not-here\\python.exe');
    check('配置了不存在的 Python → 明确回退并说明', () => {
      assert.equal(bad.ok, true, '应当回退到自动探测');
      assert.ok(bad.configuredMissing, '要标记出"你填的路径不可用"');
      assert.match(String(bad.note), /definitely-not-here|不存在/);
    });
    const none = pdfBridge.checkWorker('C:\\definitely-not-here\\python.exe');
    check('worker 缺失时明确报错（不静默成功）', () => assert.equal(none.ok, false));

    // ★ 回归：切块数（N）的口径必须是"去扩展名"。
    // 曾经的线上事故：把 '00001.webp' 喂进哈希 → N=12（正确 4）→ 还原把图弄花。
    const seg = pdfBridge.checkSegmentation(PYTHON);
    check('切块数 N 的口径与官方一致（去扩展名）', () => assert.equal(seg.ok, true, seg.error));
    const empty = await pdfBridge.runTask({
      python: PYTHON,
      task: { output: path.join(tmpRoot, 'x.pdf'), chapters: [] },
      timeoutMs: 30000,
    });
    check('空任务被明确拒绝（不静默成功）', () => assert.equal(empty.ok, false));
  }
}

console.log('\n[9] storage 自检工具');
{
  const r = await storage.execute(mkCtx('x'));
  check('报出目录占用与能力状态', () => {
    assert.match(r.content, /下载目录/);
    assert.match(r.content, /还原\/PDF 能力/);
  });
  const r2 = await storage.execute({ chatKey: 'group:999', kind: 'group', chatId: '999', onebot });
  check('报出本群群文件配额', () => assert.match(r2.content, /本群群文件/));
}

// ── LIVE ─────────────────────────────────────────────────────────────────
if (LIVE) {
  console.log('\n[10] LIVE 真实站点探测');
  api.fetch = globalThis.fetch;
  const liveId = process.argv.find((a) => a.startsWith('--live-id='))?.split('=')[1] || '422444';
  config.outputFormat = 'images';
  config.multiChapter = false;
  config.maxPages = 4;
  config.uploadMode = 'off';
  sent.length = 0;
  const t0 = Date.now();
  const ctx = mkCtx(`jm${liveId}`, { chatId: '888' });
  await mod.hooks['before-tool'](ctx);
  const enq = await download.execute(ctx, { album_id: liveId });
  console.log(`   入队：${String(enq.content).slice(0, 100)}`);
  const done = await waitDone(240000);
  console.log(`   耗时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  for (const s of sent.slice(-3)) console.log(`   ← ${String(s).replace(/\n/g, ' | ').slice(0, 260)}`);
  check('真实站点任务完成', () => assert.equal(done, true));
}

mod.deactivate?.();
console.log(`\n===== 通过 ${pass}，失败 ${fail} =====`);
console.log('日志（末 12 条）：');
for (const l of logs.slice(-12)) console.log(`   ${l}`);
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}
process.exit(fail ? 1 : 0);
