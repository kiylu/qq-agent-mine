// Python 桥：探测解释器、调用 jm_worker.py 做「竖切还原 + 合成 PDF」。
//
// 为什么用独立进程而不是在 Node 里做：项目里没有图像库（无 sharp/jimp，也没有 ffmpeg.exe），
// 还原必须"解码 → 重排像素 → 重编码"，Pillow 是最稳的选择。
// 本桥是**可选增强**：探测失败时调用方应降级为"原样下载"，不能因此报错。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_PATH = path.join(HERE, 'jm_worker.py');

/** 额外探测位置（配置里没填 Python 时用）。只探测存在性，不执行。 */
const EXTRA_CANDIDATES = [
  'C:\\Python313\\python.exe',
  'C:\\Python312\\python.exe',
  'C:\\Python311\\python.exe',
  `${process.env.LOCALAPPDATA || ''}\\Programs\\Python\\Python313\\python.exe`,
  `${process.env.LOCALAPPDATA || ''}\\Programs\\Python\\Python312\\python.exe`,
  `${process.env.LOCALAPPDATA || ''}\\Programs\\Python\\Python311\\python.exe`,
  `${process.env.LOCALAPPDATA || ''}\\Microsoft\\WindowsApps\\python.exe`,
].filter((p) => p && !p.startsWith('\\'));

/**
 * 找可用的 Python 解释器。
 * 顺序：配置路径 → py 启动器 → PATH 里的 python → 常见安装位置。
 * ⚠️ 如果**用户明确配置了路径**但它不可用，回退时必须在返回值里标出来（configuredMissing），
 * 否则会出现"设置里填了个错路径，程序悄悄用了另一个解释器"这种查不出来的怪事。
 */
export function findPython(configured = '') {
  const tried = [];
  const conf = String(configured || '').trim();
  const candidates = [];
  if (conf) candidates.push(conf);
  candidates.push('py', 'python', ...EXTRA_CANDIDATES);

  const configuredMissing = Boolean(conf) && !fs.existsSync(conf);

  for (const cand of candidates) {
    if (cand !== 'py' && cand !== 'python' && !fs.existsSync(cand)) {
      tried.push(`${cand}（不存在）`);
      continue;
    }
    const args = cand === 'py' ? ['-3', '-c', 'import sys;print(sys.version)'] : ['-c', 'import sys;print(sys.version)'];
    const r = spawnSync(cand, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.status === 0 && String(r.stdout || '').trim()) {
      const note = configuredMissing
        ? `设置里填的 Python 路径不存在（${conf}），已自动改用 ${cand}`
        : '';
      return { ok: true, exe: cand, version: String(r.stdout).trim().split(/\s+/)[0], configuredMissing, note };
    }
    tried.push(`${cand}（${r.error ? r.error.code || r.error.message : `exit ${r.status}`}）`);
  }
  return { ok: false, configuredMissing, error: `没有找到可用的 Python：${tried.slice(0, 4).join('；')}` };
}

/** 探测 Pillow 是否可用（用 worker 的 --check，最强一致性）。 */
export function checkWorker(pythonExe) {
  if (!pythonExe) return { ok: false, error: '没有 Python' };
  if (!fs.existsSync(WORKER_PATH)) return { ok: false, error: `找不到 worker 脚本：${WORKER_PATH}` };
  const r = spawnSync(pythonExe, [WORKER_PATH, '--check'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const out = String(r.stdout || '').trim().split(/\r?\n/).pop() || '';
  try {
    const json = JSON.parse(out);
    if (json.ok) return { ok: true, ...json };
    return { ok: false, error: json.error || 'Pillow 不可用' };
  } catch {
    return {
      ok: false,
      error: `worker 自检输出无法解析（exit ${r.status}）：${(out || String(r.stderr || '')).slice(0, 160)}`,
    };
  }
}

/**
 * 切块数（N）计算口径的回归自检。
 * ⚠️ 这个测试存在的唯一目的：防止再把**带扩展名**的文件名喂进哈希。
 * 那次事故里 JM1465595 第 1 页被算成 N=12（正确是 4），"还原"反而把图弄花。
 */
export function checkSegmentation(pythonExe) {
  if (!pythonExe) return { ok: false, error: '没有 Python' };
  const r = spawnSync(pythonExe, [WORKER_PATH, '--selftest'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const out = String(r.stdout || '').trim().split(/\r?\n/).pop() || '';
  try {
    const json = JSON.parse(out);
    return json.ok ? { ok: true, cases: json.cases } : { ok: false, error: `切块数用例失败：${JSON.stringify(json.failed)}` };
  } catch {
    return { ok: false, error: `自检输出无法解析（exit ${r.status}）` };
  }
}

/** 一次到位的探测：解释器 + Pillow。 */
export function detect(configuredPython = '') {
  const py = findPython(configuredPython);
  if (!py.ok) return { ok: false, configuredMissing: py.configuredMissing, error: py.error };
  const worker = checkWorker(py.exe);
  if (!worker.ok) {
    return { ok: false, python: py.exe, configuredMissing: py.configuredMissing, note: py.note, error: worker.error };
  }
  return {
    ok: true,
    python: py.exe,
    pillow: worker.pillow,
    webp: worker.webp,
    jpeg: worker.jpeg,
    configuredMissing: py.configuredMissing,
    note: py.note,
  };
}

/**
 * 跑一次 PDF 任务，边跑边回报进度。
 * @param {object} opts
 * @param {string} opts.python  解释器
 * @param {object} opts.task    worker 任务 JSON
 * @param {Function} opts.onProgress  ({stage, done, total, ok, fail}) => void
 * @param {number}  opts.timeoutMs    超时（大本子要放宽）
 * @returns {Promise<{ok:boolean, output?:string, bytes?:number, pages?:number, pagesOk?:number, restored?:number, failed?:Array, error?:string, raw?:string}>}
 */
export function runTask({ python, task, onProgress, timeoutMs = 300000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, [WORKER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (error) {
      resolve({ ok: false, error: `无法启动 Python：${error?.message ?? error}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `处理超时（${Math.round(timeoutMs / 1000)} 秒），已中止` });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      // 逐行解析协议；最后一行是 result
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        let msg;
        try {
          msg = JSON.parse(s);
        } catch {
          continue; // 半行/脏行直接跳过，不打断流程
        }
        if (msg.t === 'progress') {
          try {
            onProgress?.(msg);
          } catch {
            /* 进度回调出错不影响任务 */
          }
        } else if (msg.t === 'result') {
          finish({
            ok: msg.ok === true,
            output: msg.output,
            bytes: msg.bytes,
            pages: msg.pages,
            pagesOk: msg.pagesOk,
            restored: msg.restored,
            failed: msg.failed || [],
            warnings: msg.warnings || [],
            error: msg.ok === true ? undefined : msg.error || '未知错误',
            trace: msg.trace,
          });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on('error', (error) => finish({ ok: false, error: `Python 进程错误：${error?.message ?? error}` }));
    child.on('close', (code) => {
      // 收尾：把残留的 result 行也解析一次
      const rest = stdout.trim();
      if (rest.startsWith('{')) {
        try {
          const msg = JSON.parse(rest);
          if (msg.t === 'result') {
            finish({
              ok: msg.ok === true,
              output: msg.output,
              bytes: msg.bytes,
              pages: msg.pages,
              pagesOk: msg.pagesOk,
              restored: msg.restored,
              failed: msg.failed || [],
              error: msg.ok === true ? undefined : msg.error || '未知错误',
            });
            return;
          }
        } catch {
          /* fallthrough */
        }
      }
      finish({
        ok: false,
        error: `Python 进程退出（code ${code}）而没有返回结果${stderr ? `：${stderr.slice(-300)}` : ''}`,
      });
    });

    try {
      child.stdin.write(JSON.stringify(task), 'utf8');
      child.stdin.end();
    } catch (error) {
      finish({ ok: false, error: `写入任务失败：${error?.message ?? error}` });
    }
  });
}
