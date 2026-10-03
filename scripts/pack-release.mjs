#!/usr/bin/env node
/**
 * 一键发布打包：产出一个**不含任何使用痕迹**的干净压缩包。
 *
 * 用法：
 *   npm run pack:release                 # 默认：带运行时依赖（electron + 生产依赖），出 .zip
 *   npm run pack:release -- --slim       # 不带依赖，接收方自己 npm install（约 4 MB）
 *   npm run pack:release -- --tar        # 强制用 .tar.gz（zip 不可用时自动退化）
 *   npm run pack:release -- --out D:\x   # 指定输出目录（默认 dist/）
 *   npm run pack:release -- --dry-run    # 只打印清单与体积，不复制不压缩
 *
 * ── 为什么不是 sanitize-release.mjs ──────────────────────────────────────
 * sanitize-release.mjs 是**破坏性**的：它直接清空你本机的 data/，且不打包。
 * 本脚本反过来 —— **把项目复制到临时暂存目录 → 在副本里剔除 → 压缩 → 删暂存**，
 * 你的真实 data/、登录态、配置一个字都不动。两个脚本职责不同：
 *   · sanitize-release.mjs  → 就地消毒（想把自己的部署副本直接发出去时用）
 *   · pack-release.mjs      → 另出干净包（推荐，安全、可重复、原项目零改动）
 *
 * ── 隐私红线（绝不允许进包）──────────────────────────────────────────────
 *   data/                    聊天记录/会话/记忆/含 Key 的 config.json/遥测 ID/表情库
 *   runtime/qq-portable-data/ 便携 QQ 的 Electron 缓存 + 登录态
 *   snowluma/config/onebot_*.json  带 accessToken 的登录态（每个登录过的号一份）
 *   snowluma/logs/ *.log     日志（可能含密钥片段与聊天内容）
 *   community.key            社区管理密钥
 *   config.json.corrupt-*    坏配置备份（含清洗前的真实 Key）
 *   .git/ .workbuddy/        版本库 / AI 协作记忆
 *
 * ── 体积红线（默认剔除，接收方自己能重建）───────────────────────────────
 *   runtime/qq-portable/     1.6 GB —— QQ 脱离包本体，README 明确"不随代码分发"
 *   snowluma/                110 MB —— 第三方项目（自带 EULA），且体积大
 *   node_modules/            391 MB —— 默认只保留运行必需（见 --slim 说明）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const SLIM = has('--slim');
const FORCE_TAR = has('--tar');
const DRY = has('--dry-run');
const OUT_DIR = path.resolve(ROOT, val('--out', 'dist'));

const log = (...a) => console.log(...a);
const fmt = (bytes) => {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(2)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
  return `${bytes} B`;
};

// ── 排除清单 ─────────────────────────────────────────────────────────────
// A 类：隐私红线。无论如何都不进包（含 --slim 与默认）。
const EXCLUDE_PRIVATE = [
  'data',                 // 聊天记录/会话/记忆/config.json(含 Key)/遥测/表情库
  '.git',
  '.workbuddy',           // AI 协作记忆与日志
  '.goal-baseline',
  'dist',                 // 打包产物目录（避免包进包）
  'release',
  'community.key',        // 社区管理密钥
];
// node_modules 不在上面 —— 它的去留由 keepNodeModules（包白名单）单独判定。
// 包内 data/ 的残留位置（runtime/ 下的便携 QQ 数据、SnowLuma 登录态）
const EXCLUDE_RUNTIME_DATA = [
  'runtime/qq-portable-data',   // 便携 QQ 的 Electron 缓存 + 登录态
  'runtime/.cache',
  'snowluma/logs',
  'snowluma/config',            // onebot_<QQ号>.json 带 token，整体不带
  'snowluma/data',
];
// B 类：体积大头（默认剔除；接收方跑 npm run setup 自建）
const EXCLUDE_BULK = [
  'runtime',               // 1.6 GB 便携 QQ，README 明确不随代码分发
  'snowluma',              // 110 MB 第三方项目
];
// C 类：开发文件（与 electron-builder 的 build.files 排除规则一致）
const EXCLUDE_DEV = [
  'test',
  'doc',
  'scripts',
  'build',                 // 安装器脚本，随 electron-builder 使用，接收方用不到
];
// 通用垃圾
const EXCLUDE_JUNK = [
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
  '.env', '.env.local',
];
const EXCLUDE_JUNK_EXT = new Set(['.tmp', '.bak', '.swp']);
const EXCLUDE_JUNK_RE = [/^config\.json\.corrupt-/, /\.log$/];

/**
 * 是否排除某相对路径（POSIX 风格，如 'runtime/qq-portable/QQ.exe'）。
 * 返回 null = 保留，否则返回排除原因标签。
 */
function excludeReason(rel) {
  const top = rel.split('/')[0];
  const base = rel.split('/').pop();

  // ⚠️ node_modules 必须最先放行：它的"去留"由 keepNodeModules 的包白名单决定，
  //    不能落进下面的 EXCLUDE_PRIVATE（那会把整棵依赖树一刀切掉）。
  if (rel === 'node_modules' || rel.startsWith('node_modules/')) return null;

  for (const p of EXCLUDE_PRIVATE) if (rel === p || rel.startsWith(p + '/')) return '隐私(' + p + ')';
  for (const p of EXCLUDE_RUNTIME_DATA) if (rel === p || rel.startsWith(p + '/')) return '运行时数据(' + p + ')';
  for (const p of EXCLUDE_BULK) if (rel === p || rel.startsWith(p + '/')) return '体积(' + p + ')';
  for (const p of EXCLUDE_DEV) if (rel === p || rel.startsWith(p + '/')) return '开发文件(' + p + ')';
  for (const p of EXCLUDE_JUNK) if (base === p) return '垃圾文件';
  if (EXCLUDE_JUNK_EXT.has(path.extname(base).toLowerCase())) return '临时文件';
  for (const re of EXCLUDE_JUNK_RE) if (re.test(base)) return '日志/备份';
  if (rel === 'community.key') return '隐私(社区密钥)';
  void top;
  return null;
}

// ── 依赖策略 ─────────────────────────────────────────────────────────────
/**
 * 需要保留的 node_modules 顶层包。
 *
 * 默认（非 --slim）：生产依赖闭包 + electron（桌面端运行时，.bat 直接调它的
 *   dist/electron.exe）。剔除 electron-builder / app-builder-lib / jsdom 等
 *   纯开发工具 —— 它们占了 node_modules 大头却与运行无关。
 * --slim：一个都不带（接收方自己 npm install）。
 *
 * 用 `npm ls --omit=dev` 拿生产闭包而非手写清单 —— 依赖变化时自动跟上，
 * 不会因为漏列某个传递依赖而在接收方启动时报 MODULE_NOT_FOUND。
 */
function runtimeDeps() {
  if (SLIM) return { mode: 'slim', names: new Set() };
  const names = new Set(['electron']);          // 桌面壳必需
  try {
    const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: true
    });
    const j = JSON.parse(out);
    const walk = (deps) => {
      if (!deps) return;
      for (const [k, v] of Object.entries(deps)) { names.add(k); walk(v.dependencies); }
    };
    walk(j.dependencies);
    return { mode: 'full', names };
  } catch {
    // npm 不可用时退化到 package.json 里声明的直接依赖（传递依赖可能缺，
    // 但比"什么都不带"强；打印告警让用户知道）
    const direct = Object.keys(pkg.dependencies || {});
    for (const d of direct) names.add(d);
    log('  ⚠ 无法解析依赖闭包（npm 不可用？），退化为直接依赖：', direct.join(', '));
    return { mode: 'full-fallback', names };
  }
}

/**
 * 是否保留某个 node_modules 下的路径。
 * @param {string} rel 形如 'node_modules/electron/dist/electron.exe'
 * @param {Set<string>} keep 保留的顶层包名
 */
function keepNodeModules(rel, keep) {
  if (rel === 'node_modules') return true;
  const parts = rel.split('/');
  if (parts[0] !== 'node_modules') return true;
  if (parts[1] && parts[1].startsWith('.')) return false;     // .bin/.package-lock.json 等
  if (parts[1] === '.bin') return false;                       // 可执行软链，由 electron 自身提供
  // 支持 scoped 包 @scope/name
  const pkgName = parts[1]?.startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1];
  if (!pkgName) return false;
  if (keep.has(pkgName)) return true;
  if (keep.has(parts[1])) return true;                         // scoped 兜底
  return false;
}

// ── 复制遍历 ─────────────────────────────────────────────────────────────
function walkCopy(srcDir, dstDir, relPrefix, keep, stats) {
  let entries;
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    const src = path.join(srcDir, e.name);
    const dst = path.join(dstDir, e.name);

    const reason = excludeReason(rel);
    if (reason) { stats.excluded.push({ rel, reason }); continue; }

    if (rel === 'node_modules' || rel.startsWith('node_modules/')) {
      if (!keepNodeModules(rel, keep)) { stats.excluded.push({ rel, reason: '开发依赖' }); continue; }
    }

    let st;
    try { st = fs.lstatSync(src); } catch { continue; }
    if (st.isSymbolicLink()) {
      // 不复制软链（Windows 上多为 npm 的 .bin 软链），避免指向包外路径
      stats.excluded.push({ rel, reason: '软链' });
      continue;
    }
    if (st.isDirectory()) {
      if (!DRY) fs.mkdirSync(dst, { recursive: true });
      walkCopy(src, dst, rel, keep, stats);
    } else if (st.isFile()) {
      stats.files++;
      stats.bytes += st.size;
      if (!DRY) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  }
}

// ── 压缩：内置 ZIP writer（保证 UTF-8 文件名）────────────────────────────
//
// ⚠️ 为什么不用系统工具：
//   · Windows `tar.exe`（bsdtar）写中文文件名时用**系统 ANSI 码页（GBK）**且
//     **不设 UTF-8 标志位（0x800）** → 在非中文系统解压成乱码
//     （实测：`启动QQ机器人.bat` 变成 `╞⌠╢»QQ╗·╞≈╚╦.bat`）。
//   · PowerShell `Compress-Archive` 写**反斜杠路径**，非 Windows 解压器解析失败。
//   两者都会破坏"双击 .bat 启动"的体验。所以这里直接用 Node 内置 zlib 手写 ZIP：
//   文件名一律 UTF-8 + 置 0x800 标志位，路径一律正斜杠 —— 跨平台解压都不乱码。
//
// 只实现 STORE(0) 与 DEFLATE(8) 两种方法（DEFLATE 用 zlib.deflateRawSync），
// 这是 zip 规范里最通用的一对。CRC32 自行计算（zlib 不直接暴露）。

/** CRC32 查表（zip 规范用标准多项式 0xEDB88320）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 收集暂存目录下所有文件（相对路径用正斜杠，保持稳定排序便于可复现）。
 * @returns {Array<{abs:string, rel:string, isDir:boolean}>}
 */
function collectEntries(root) {
  const out = [];
  const walk = (dir, prefix) => {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) {
        out.push({ abs, rel: rel + '/', isDir: true });
        walk(abs, rel);
      } else if (st.isFile()) {
        out.push({ abs, rel, isDir: false });
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * 手写一个 zip。
 * @param {string} srcDir 待打包目录（其内容作为归档根的下一层子目录）
 * @param {string} zipPath 输出 zip 路径
 * @param {string} rootName 归档内顶层目录名（如 qq-agent-0.4.0-...-full）
 */
function writeZip(srcDir, zipPath, rootName) {
  const { deflateRawSync } = zlib;
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // 归档根目录条目（显式写出，解压器才能建出顶层文件夹）
  const all = [
    { abs: srcDir, rel: rootName + '/', isDir: true },
    ...collectEntries(srcDir).map((e) => ({ ...e, rel: `${rootName}/${e.rel}` }))
  ];

  const DOS_TIME = 0; // 时间戳固定为 0：让同内容产物字节可复现（不受打包时刻影响）
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01

  for (const e of all) {
    // 目录：名字以 / 结尾、内容为空
    const nameBuf = Buffer.from(e.rel, 'utf8');   // ⚠️ 关键：UTF-8
    const data = e.isDir ? Buffer.alloc(0) : fs.readFileSync(e.abs);

    // 小文件/已压缩文件用 STORE 更省事；其余 DEFLATE。这里统一尝试 DEFLATE，
    // 若压缩后反而更大则退化为 STORE。
    let method = 8;
    let payload = deflateRawSync(data, { level: 9 });
    if (payload.length >= data.length) { method = 0; payload = data; }

    const crc = crc32(data);
    const nameLen = nameBuf.length;
    const flags = 0x0800; // ⚠️ bit 11 = 文件名是 UTF-8（跨平台不乱码的关键）

    // 本地文件头
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameLen, 26);
    local.writeUInt16LE(0, 28);          // extra len
    localParts.push(local, nameBuf, payload);

    // 中央目录项
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameLen, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk number
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(e.isDir ? 0x10 : 0, 38); // external attrs（目录置目录位）
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const localBuf = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(all.length, 8);      // 本盘条目数
  eocd.writeUInt16LE(all.length, 10);     // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([localBuf, centralBuf, eocd]));
  return fs.existsSync(zipPath);
}

function makeTar(srcDir, tarPath) {
  // tar.gz 兜底：-C 切目录避免绝对路径进归档。
  // 若外面的 tar 是 bsdtar 也能出 tar.gz；GNU tar 亦可。
  execFileSync('tar', ['-czf', tarPath, '-C', path.dirname(srcDir), path.basename(srcDir)], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  return fs.existsSync(tarPath);
}

// ── 主流程 ───────────────────────────────────────────────────────────────
function main() {
  const STAMP = new Date().toISOString().slice(0, 10);
  const name = `qq-agent-${pkg.version}-${STAMP}${SLIM ? '-slim' : '-full'}`;

  log('════════════════════════════════════════');
  log(DRY ? '发布打包 —— 演练模式（只报清单，不产出文件）' : '发布打包 —— 执行模式');
  log('════════════════════════════════════════');
  log('项目根：', ROOT);
  log('依赖模式：', SLIM ? 'slim（不带 node_modules）' : 'full（带运行时依赖 + electron）');
  log('');

  const deps = runtimeDeps();
  const keep = deps.names;
  if (!SLIM) log(`  保留运行时依赖 ${keep.size} 个包（生产依赖闭包 + electron）`);

  // 复制的顶层条目（跳过排除项；node_modules 由 keep 策略细化）
  const topSkip = new Set([...EXCLUDE_PRIVATE, ...EXCLUDE_BULK, ...EXCLUDE_DEV, ...EXCLUDE_JUNK]);
  const stats = { files: 0, bytes: 0, excluded: [] };

  const stageRoot = path.join(os.tmpdir(), `qq-agent-pack-${Date.now()}`);
  const stage = path.join(stageRoot, name);

  if (!DRY) {
    fs.mkdirSync(stage, { recursive: true });
    // 先复制顶层（跳过排除项）
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (topSkip.has(e.name)) {
        stats.excluded.push({ rel: e.name, reason: '顶层排除' });
        continue;
      }
      const rel = e.name;
      const reason = excludeReason(rel);
      if (reason) { stats.excluded.push({ rel, reason }); continue; }
      if (rel === 'node_modules') continue;   // 交给 keep 策略
      const src = path.join(ROOT, e.name);
      const dst = path.join(stage, e.name);
      const st = fs.lstatSync(src);
      if (st.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        walkCopy(src, dst, rel, keep, stats);
      } else if (st.isFile()) {
        stats.files++; stats.bytes += st.size;
        fs.copyFileSync(src, dst);
      }
    }
    // 再处理 node_modules（按 keep 白名单）
    if (!SLIM && fs.existsSync(path.join(ROOT, 'node_modules'))) {
      const dstNM = path.join(stage, 'node_modules');
      fs.mkdirSync(dstNM, { recursive: true });
      walkCopy(path.join(ROOT, 'node_modules'), dstNM, 'node_modules', keep, stats);
    }
  } else {
    // 演练：只统计，不复制
    const dry = { files: 0, bytes: 0, excluded: [] };
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      const rel = e.name;
      // node_modules 交给下面的 keep 策略单独统计，这里跳过（否则会被计两次）
      if (rel === 'node_modules') continue;
      const reason = excludeReason(rel);
      if (reason || topSkip.has(rel)) { dry.excluded.push({ rel, reason: reason || '顶层排除' }); continue; }
      const src = path.join(ROOT, e.name);
      const st = fs.lstatSync(src);
      if (st.isDirectory()) walkCopy(src, '', rel, keep, dry);
      else if (st.isFile()) { dry.files++; dry.bytes += st.size; }
    }
    if (!SLIM && fs.existsSync(path.join(ROOT, 'node_modules'))) {
      walkCopy(path.join(ROOT, 'node_modules'), '', 'node_modules', keep, dry);
    }
    Object.assign(stats, dry);
  }

  // 输出排除摘要（按原因聚合）
  const byReason = new Map();
  for (const x of stats.excluded) {
    const key = x.reason.replace(/\(.*\)/, '');
    byReason.set(key, (byReason.get(key) || 0) + 1);
  }
  log('排除摘要：');
  for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) log(`  · ${k}：${v} 项`);
  log('');
  log(`将打包：${stats.files} 个文件，原始体积约 ${fmt(stats.bytes)}`);
  log('');

  if (DRY) {
    log('演练结束。确认清单无误后去掉 --dry-run 执行。');
    return;
  }

  // 压缩
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let outPath = path.join(OUT_DIR, `${name}.zip`);
  let ok = false;
  if (!FORCE_TAR) {
    try { ok = writeZip(stage, outPath, name); } catch (e) { log('  zip 失败：', e.message); ok = false; }
  }
  if (!ok) {
    outPath = path.join(OUT_DIR, `${name}.tar.gz`);
    log('  改用 tar.gz …');
    makeTar(stage, outPath);
  }

  // 清理暂存
  try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  log('════════════════════════════════════════');
  log('完成');
  log('产物：', outPath);
  log('体积：', fmt(size), `（源 ${fmt(stats.bytes)}）`);
  log('');
  log('接收方使用：解压 → 双击「启动QQ机器人.bat」→ 首次需跑一次 npm run setup 装 SnowLuma 与便携 QQ。');
  log('（发布包不含 runtime/ 与 snowluma/ —— 那是第三方/超大件，setup 会自动下载。）');
}

// 仅在直接执行时跑主流程（被测试 import 时不跑）。
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

// ── 供测试使用的导出（纯函数，无副作用）─────────────────────────────────
export {
  excludeReason, keepNodeModules, crc32, EXCLUDE_PRIVATE, EXCLUDE_RUNTIME_DATA,
  EXCLUDE_BULK, EXCLUDE_DEV, EXCLUDE_JUNK, writeZip, collectEntries
};
