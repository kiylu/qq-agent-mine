// 发版产物收集的测试（scripts/release.mjs 的 collectArtifacts）。
//
// 为什么值得测：发版是**不可回滚**的对外动作，产物挂错/漏挂的后果都不轻 ——
//   · 漏挂 latest.yml → 已装安装版的用户永远收不到自动更新（updater 报
//     ERR_UPDATER_NO_PUBLISHED_VERSIONS，且要等下一次发版才可能自愈）；
//   · 挂上版本对不上的 latest.yml → electron-updater 会按清单里的版本判断"有没有新版"，
//     可能推出错版或让用户卡在"永远提示有更新"。
// 这两条都不是靠肉眼能稳住的，所以固化成测试。
//
// 解析片段**从源码里原样抽出来**跑（与 test/release-parse.mjs 同一套路），
// 不在这里抄一份 —— 抄一份的话线上改了、测试还绿，等于没测。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'release.mjs'), 'utf8');

let pass = 0; let fail = 0;
const check = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const throwsWith = (fn, re, msg) => {
  try { fn(); fail++; console.log('  ✗ ' + msg + '（本该抛错却没抛）'); }
  catch (e) { check(re.test(String(e?.message ?? e)), msg + ' —— ' + String(e?.message ?? e).split('\n')[0].slice(0, 60)); }
};

/** 抽出 collectArtifacts 函数体（按大括号配对）。 */
function grabFn(name) {
  const start = src.search(new RegExp(`function ${name}\\(`));
  if (start < 0) throw new Error(`源码里找不到 ${name}`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} 花括号不配对`);
}

/** 用给定的 dist 目录 / 版本 / 开关，把 collectArtifacts 跑起来。 */
function makeCollector({ distDir, version, zipOnly = false, installerOnly = false }) {
  const body = grabFn('collectArtifacts');
  const fn = new Function('fs', 'path', 'distDir', 'VERSION', 'ZIP_ONLY', 'INSTALLER_ONLY', 'fail', 'log',
    `${body}\nreturn collectArtifacts();`);
  const errors = [];
  const logs = [];
  const out = fn(fs, path, distDir, version, zipOnly, installerOnly,
    (m) => { errors.push(m); throw new Error(m); },
    (m) => logs.push(m));
  return { out: out.map((p) => path.basename(p)), errors, logs };
}

/** 造一个假的 dist 目录。 */
function fakeDist(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-artifacts-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content ?? '');
  }
  return dir;
}

const V = '1.2.3';
const yml = (v) => `version: ${v}\nfiles:\n  - url: QQ-Agent-${v}-Setup.exe\n    sha512: abc\n    size: 1\npath: QQ-Agent-${v}-Setup.exe\n`;

console.log('\n=== 发版产物收集 ===\n');

console.log('[1] zip + 安装包都在：两类产物都要挂上');
{
  const dir = fakeDist({
    [`qq-agent-${V}-2026-10-20-full.zip`]: 'zip',
    [`QQ-Agent-${V}-Setup.exe`]: 'exe',
    'latest.yml': yml(V),
    [`QQ-Agent-${V}-Setup.exe.blockmap`]: 'bm',
    'some-other-file.txt': 'x'
  });
  const { out } = makeCollector({ distDir: dir, version: V });
  check(out.includes(`qq-agent-${V}-2026-10-20-full.zip`), '挂上压缩包');
  check(out.includes(`QQ-Agent-${V}-Setup.exe`), '挂上安装包');
  check(out.includes('latest.yml'), '挂上 latest.yml（自动更新必需）');
  check(out.includes(`QQ-Agent-${V}-Setup.exe.blockmap`), '挂上 blockmap（差分更新用）');
  check(!out.includes('some-other-file.txt'), '不相关的文件不挂');
}

console.log('\n[2] 版本不符的旧包不能挂');
{
  const dir = fakeDist({
    'qq-agent-1.0.0-2026-01-01-full.zip': 'old',     // 旧版本 zip
    [`QQ-Agent-${V}-Setup.exe`]: 'exe',
    'latest.yml': yml(V)
  });
  const { out } = makeCollector({ distDir: dir, version: V });
  check(!out.includes('qq-agent-1.0.0-2026-01-01-full.zip'), '旧版本 zip 被排除');
  check(out.includes(`QQ-Agent-${V}-Setup.exe`), '当前版本安装包保留');
}

console.log('\n[3] latest.yml 版本与 package.json 不符：必须拒绝发版');
{
  // 这是最危险的一种：exe 名字对得上，但清单里是别的版本 —— 发出去会让
  // electron-updater 按错版本判断，用户可能"永远提示有更新"。
  const dir = fakeDist({
    [`QQ-Agent-${V}-Setup.exe`]: 'exe',
    'latest.yml': yml('9.9.9')
  });
  throwsWith(
    () => makeCollector({ distDir: dir, version: V }),
    /latest\.yml 里的版本是 9\.9\.9/,
    '版本不符时 fail() 并说明原因'
  );
}

console.log('\n[4] 没有 latest.yml：只提示，不阻断');
{
  // 缺 latest.yml 时安装版收不到更新，但 zip 照发 —— 不该让整次发版失败。
  const dir = fakeDist({
    [`qq-agent-${V}-2026-10-20-full.zip`]: 'zip',
    [`QQ-Agent-${V}-Setup.exe`]: 'exe'
  });
  const { out, logs } = makeCollector({ distDir: dir, version: V });
  check(out.includes(`QQ-Agent-${V}-Setup.exe`), '安装包仍然挂上');
  check(logs.some((l) => /latest\.yml/.test(l)), '给出缺 latest.yml 的提示');
}

console.log('\n[5] --zip-only / --installer-only');
{
  const dir = fakeDist({
    [`qq-agent-${V}-2026-10-20-full.zip`]: 'zip',
    [`QQ-Agent-${V}-Setup.exe`]: 'exe',
    'latest.yml': yml(V)
  });
  const zipOnly = makeCollector({ distDir: dir, version: V, zipOnly: true });
  check(zipOnly.out.length === 1 && zipOnly.out[0].endsWith('.zip'), '--zip-only 只出压缩包');

  const instOnly = makeCollector({ distDir: dir, version: V, installerOnly: true });
  check(instOnly.out.includes(`QQ-Agent-${V}-Setup.exe`), '--installer-only 出安装包');
  check(instOnly.out.includes('latest.yml'), '--installer-only 带 latest.yml');
  check(!instOnly.out.some((f) => f.endsWith('.zip')), '--installer-only 不带压缩包');
}

console.log('\n[6] dist 不存在 / 空目录');
{
  const { out } = makeCollector({ distDir: path.join(os.tmpdir(), 'definitely-not-exist-' + Date.now()), version: V });
  check(Array.isArray(out) && out.length === 0, 'dist 不存在时返回空数组而不是崩');

  const empty = fakeDist({});
  const r = makeCollector({ distDir: empty, version: V });
  check(r.out.length === 0, '空 dist 返回空数组');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
