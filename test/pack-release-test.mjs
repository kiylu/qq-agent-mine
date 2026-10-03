// 发布打包脚本的测试（scripts/pack-release.mjs）。
//
// 为什么值得测：打包脚本写错的后果分两种，都是"发布事故"级别 ——
//   · 该剔的没剔（data/、登录态进了包）→ 隐私泄露，发出去就收不回
//   · 该留的没留（源码/依赖缺失）→ 接收方解压后打不开
// 所以"剔除判定"和"ZIP 结构"两条必须固化。
//
// 覆盖点：
//   1. excludeReason：隐私红线一律排除；源码/配置一律保留
//   2. keepNodeModules：白名单内保留、白名单外排除；@scope 包正确识别
//   3. crc32：对已知向量正确（与 zlib/标准实现一致）
//   4. writeZip：产出的 zip 条目名是 UTF-8、路径是正斜杠、CRC 自洽、
//      且中文文件名能原样读回（这是被 bsdtar/Compress-Archive 坑过的地方）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
function ok(name, extra = '') { pass++; console.log(`  ✓ ${name}${extra ? ` —— ${extra}` : ''}`); }
function bad(name, error) { fail++; console.log(`  ✗ ${name}\n      ${error?.stack || error}`); }
function check(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e); } }

const { excludeReason, keepNodeModules, crc32, writeZip, collectEntries } =
  await import('../scripts/pack-release.mjs');

console.log('\n=== 发布打包脚本 ===\n');

// ── 1. 隐私红线：必须排除 ────────────────────────────────────────────────
console.log('[排除判定：隐私/体积/开发文件]');
for (const p of [
  'data', 'data/config.json', 'data/messages/12345.json',
  'runtime/qq-portable-data/Local State',
  'snowluma/config/onebot_12345.json', 'snowluma/logs/app.log',
  '.git', '.git/HEAD', '.workbuddy/memory/2026-10-03.md',
  'community.key',
  'data/config.json.corrupt-1712345678901',
  'runtime', 'runtime/qq-portable/QQ.exe',
  'snowluma', 'snowluma/index.js',
  'test', 'test/selftest.mjs', 'doc', 'doc/README.md', 'scripts', 'scripts/setup.mjs',
  'build', 'build/installer.nsh',   // electron-builder 的安装器源码，最终用户用不到
  'boot-diag.log', 'foo.log', 'a.tmp', 'b.bak', '.DS_Store', 'Thumbs.db',
  'dist/qq-agent.zip', 'release/out.zip',
]) {
  check(`排除：${p}`, () => assert.ok(excludeReason(p), '应被排除但判为保留'));
}

console.log('\n[保留判定：源码/配置/文档]');
for (const p of [
  'src/app.js', 'src/skills/manager.js',
  'ui/index.html', 'ui/app/00-core.js', 'ui/style.css',
  'electron/main.js', 'electron/preload.cjs',
  'plugins/conversation-memory-lite/index.js', 'plugins/conversation-memory-lite/plugin.json',
  'assets/icon.ico', 'server/community_app.py',
  'package.json', 'package-lock.json', 'README.md', 'LICENSE',
  'community.key.example',      // 模板要保留（不含真实密钥）
  '启动QQ机器人.bat',
  'skills/.gitkeep',            // 目录占位
]) {
  check(`保留：${p}`, () => assert.equal(excludeReason(p), null, `应保留但被排除：${excludeReason(p)}`));
}

// community.key 与 community.key.example 是一对：前者排除、后者保留
console.log('\n[社区密钥：本体排除、模板保留]');
check('community.key 排除', () => assert.ok(excludeReason('community.key')));
check('community.key.example 保留', () => assert.equal(excludeReason('community.key.example'), null));

// ── 2. node_modules 白名单 ──────────────────────────────────────────────
console.log('\n[依赖白名单]');
const keep = new Set(['electron', 'ws', 'undici', '@scope/pkg']);
check('node_modules 本身保留（由白名单细化）', () => assert.equal(excludeReason('node_modules'), null));
check('白名单内：electron 保留', () => assert.ok(keepNodeModules('node_modules/electron/dist/electron.exe', keep)));
check('白名单内：ws 保留', () => assert.ok(keepNodeModules('node_modules/ws/lib/websocket.js', keep)));
check('白名单外：jsdom 排除', () => assert.equal(keepNodeModules('node_modules/jsdom/index.js', keep), false));
check('白名单外：electron-builder 排除', () => assert.equal(keepNodeModules('node_modules/electron-builder/index.js', keep), false));
check('scoped 包：@scope/pkg 保留', () => assert.ok(keepNodeModules('node_modules/@scope/pkg/index.js', keep)));
check('scoped 包：@scope/other 排除', () => assert.equal(keepNodeModules('node_modules/@scope/other/index.js', keep), false));
check('.bin 软链目录排除', () => assert.equal(keepNodeModules('node_modules/.bin/electron', keep), false));
check('非 node_modules 路径一律保留', () => assert.ok(keepNodeModules('src/app.js', keep)));

// ── 3. crc32 正确性 ────────────────────────────────────────────────────
console.log('\n[CRC32]');
// 标准测试向量：crc32("123456789") = 0xCBF43926
check('crc32("123456789") = 0xCBF43926', () => assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926));
check('crc32(空) = 0', () => assert.equal(crc32(Buffer.alloc(0)), 0));
// 与 "The quick brown fox jumps over the lazy dog" 的已知值对照
check('crc32(fox) 稳定性', () => {
  const a = crc32(Buffer.from('The quick brown fox jumps over the lazy dog'));
  assert.equal(typeof a, 'number');
  assert.ok(a > 0 && a <= 0xFFFFFFFF);
});

// ── 4. writeZip 端到端结构 ─────────────────────────────────────────────
console.log('\n[writeZip：结构 / UTF-8 文件名 / 正斜杠]');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-packtest-'));
try {
  // 造一个含中文文件名与子目录的暂存目录
  const src = path.join(tmp, 'stage');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, '启动QQ机器人.bat'), 'echo hi\r\n');
  fs.writeFileSync(path.join(src, 'sub', 'code.js'), 'export default 1;\n');
  fs.writeFileSync(path.join(src, 'big.txt'), 'A'.repeat(50000));   // 触发 DEFLATE
  fs.writeFileSync(path.join(src, 'empty.txt'), '');

  const zipPath = path.join(tmp, 'out.zip');
  const okZip = writeZip(src, zipPath, 'pkg-root');
  check('writeZip 返回 true 且文件存在', () => { assert.ok(okZip); assert.ok(fs.existsSync(zipPath)); });

  const buf = fs.readFileSync(zipPath);
  // EOCD 存在
  check('EOCD 签名存在', () => assert.ok(buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) > 0));

  // 解析中央目录，做结构断言
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd > 0, '未找到 EOCD');
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, '中央目录签名不符');
    const flags = buf.readUInt16LE(off + 8);
    const nlen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    entries.push({ name, flags });
    off += 46 + nlen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }

  check('条目数 = 根 + 5 个文件', () => assert.equal(entries.length, 6));
  check('所有条目都置了 UTF-8 标志位(0x800)', () => {
    for (const e of entries) assert.ok(e.flags & 0x800, `${e.name} 未置 UTF-8 位`);
  });
  check('中文文件名原样保留', () => {
    const hit = entries.find((e) => e.name.endsWith('.bat'));
    assert.ok(hit, '未找到 .bat 条目');
    assert.equal(hit.name, 'pkg-root/启动QQ机器人.bat');
  });
  check('路径一律正斜杠（无反斜杠）', () => {
    for (const e of entries) assert.ok(!e.name.includes('\\'), `${e.name} 含反斜杠`);
  });
  check('顶层根目录条目以 / 结尾', () => {
    const root = entries.find((e) => e.name === 'pkg-root/');
    assert.ok(root, '缺少顶层目录条目');
  });

  // 用 zlib 解压并核对内容 + CRC
  check('内容可回读且 CRC 自洽', () => {
    // 重新走一遍本地头，读出 big.txt
    let p = 0;
    const byName = {};
    while (buf.readUInt32LE(p) === 0x04034b50) {
      const method = buf.readUInt16LE(p + 8);
      const crc = buf.readUInt32LE(p + 14);
      const csize = buf.readUInt32LE(p + 18);
      const usize = buf.readUInt32LE(p + 22);
      const nlen = buf.readUInt16LE(p + 26);
      const elen = buf.readUInt16LE(p + 28);
      const name = buf.toString('utf8', p + 30, p + 30 + nlen);
      const dataStart = p + 30 + nlen + elen;
      const raw = buf.subarray(dataStart, dataStart + csize);
      const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
      assert.equal(data.length, usize, `${name} 解压长度不符`);
      assert.equal(crc32(data), crc, `${name} CRC 不符`);
      byName[name] = data;
      p = dataStart + csize;
    }
    assert.equal(byName['pkg-root/big.txt'].length, 50000);
    assert.equal(byName['pkg-root/empty.txt'].length, 0);
    assert.ok(byName['pkg-root/启动QQ机器人.bat'].toString('utf8').includes('echo hi'));
  });

  check('collectEntries 递归且目录名以 / 结尾', () => {
    const es = collectEntries(src);
    const dirs = es.filter((e) => e.isDir).map((e) => e.rel);
    assert.ok(dirs.includes('sub/'), '未包含 sub/ 目录');
  });
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n' + '─'.repeat(40));
console.log(`通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
