#!/usr/bin/env node
/**
 * 一键发版：打 tag → 打包 → 发 GitHub Release（产物自动挂上）。
 *
 * 用法：
 *   node scripts/release.mjs --dry-run     # 只演练：校验 + 打印将做什么，不打 tag 不上传
 *   node scripts/release.mjs --notes "修了 XX"   # 带更新说明
 *   node scripts/release.mjs --skip-pack   # 复用 dist/ 里已有的包（跳打包）
 *   node scripts/release.mjs --yes         # 跳过交互确认
 *
 * ── 版本与 tag 的关系（唯一真相是 package.json）────────────────────────────
 *   版本号只写在 package.json 的 version 字段里，**不允许手打 tag**。
 *   本脚本读它 → 生成 v{major}.{minor}.{patch} → 打同名 tag。
 *   反向也校验：tag 必须等于 v + 当前 version，否则直接拒绝发版。
 *
 *   为什么 tag 用 v 前缀：GitHub 惯例，且 Releases 页面会自动识别为 release tag。
 *   为什么**不带日期**：产物名里已经带日期（qq-agent-1.1.1-2026-10-03-full.zip），
 *   tag 再带就是重复；更关键的是 compareSemver 只取前三段数字，
 *   "v1.1.1-2026-10-03" 这种多段串会被误解析。
 *
 * ── 为什么不用 electron-updater ────────────────────────────────────────
 *   它是给 NSIS 安装包做差分更新的，本项目对外分发 zip（解压覆盖式），用不了。
 *   所以这里只负责"把产物挂到 Release 上"，下载与覆盖由用户手动做。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = String(pkg.version || '').trim();
const TAG = `v${VERSION}`;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const DRY = has('--dry-run');
const SKIP_PACK = has('--skip-pack');
const ASSUME_YES = has('--yes');
const NOTES = val('--notes', '');

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };

/** 跑一条 git 命令并取回 stdout。
 *
 *  ⚠️ 为什么绕道临时文件：**受限沙箱里"带管道读输出"的 spawn 会报 EBUSY**
 *  （Windows 管道 spawn 被拒），哪怕是只读的 `git status` 也一样。
 *  `stdio:'ignore'` 不走管道所以没事，但那样拿不到输出。
 *  折中：让 git 自己把输出写文件，我们再读 —— 读文件不受这个限制。
 *  这不是仓库或 git 的问题，正常的终端里直接 execFileSync + encoding 就好。
 */
function git(...argv) {
  const out = path.join(os.tmpdir(), `rel-git-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    execFileSync('git', [...argv, '> "' + out + '"'], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], shell: true
    });
    return fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '';
  } finally {
    try { fs.unlinkSync(out); } catch { /* 临时文件删不掉不影响主流程 */ }
  }
}

/** git 是否可调用。探测用 stdio:'ignore'（不走管道，见上）。 */
let gitBroken = '';
function gitAvailable() {
  if (gitBroken) return false;
  try { execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, stdio: 'ignore' }); return true; }
  catch (e) { gitBroken = e?.code || String(e?.message ?? e); return false; }
}
function warnGitSkip(what) {
  log('  ⚠ 跳过    : ' + what + '（本机无法调用 git：' + gitBroken + '）');
}

function hasCommand(cmd) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ── 1) 前置校验 ─────────────────────────────────────────────────────────
log('════════════════════════════════════════');
log('发版 ' + TAG);
log('════════════════════════════════════════\n');

if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
  fail(`package.json 的 version 不合规: "${VERSION}"（要求 x.y.z 三段纯数字，如 1.1.1）`);
}
log('  版本号    : ' + VERSION + '（来自 package.json，唯一真相）');

const gitOk = gitAvailable();

// 工作区必须干净：否则打出来的 tag 对应的代码和本地改动对不上
if (!gitOk) {
  warnGitSkip('工作区洁净度检查');
  warnGitSkip('tag 重复检查');
  warnGitSkip('分支检查');
} else {
  const dirty = git('status', '--porcelain').split('\n').filter((l) => l.trim());
  if (dirty.length) {
    log('  工作区    : 有 ' + dirty.length + ' 处未提交改动');
    if (!DRY) {
      console.error('\n  未提交的文件（最多列 10 条）：');
      for (const d of dirty.slice(0, 10)) console.error('    ' + d.slice(3));
      fail('\n请先提交或 stash 再发版 —— tag 应对应一个确定的状态。');
    }
  } else {
    log('  工作区    : 干净');
  }

  // tag 是否已被占用（重复发版是最容易犯的错，先查）
  let tagExists = false;
  try { git('rev-parse', '-q', '--verify', `refs/tags/${TAG}`); tagExists = true; } catch { /* 不存在，正常 */ }
  if (tagExists) fail(`tag ${TAG} 已存在 —— 版本号可能没往上调，或上一次发版已完成。`);

  // 分支必须是默认分支的同步状态，否则 Release 指向的代码不是最新的
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  log('  当前分支  : ' + branch);
  if (!DRY && branch !== 'main' && branch !== 'master') {
    log('  ⚠ 提示    : 当前不在 main/master 上，发出来的 Release 别人未必拉得到');
  }
}

// GitHub 仓库地址：优先用 package.json.repository（已指向本仓库）
const repoUrl = String(pkg.repository?.url || '');
const repoM = repoUrl.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
if (!repoM) fail(`无法从 package.json.repository 解析 GitHub 仓库: "${repoUrl}"`);
const repo = repoM[1];
log('  GitHub 仓库: ' + repo);

// 上传需要 gh CLI
const hasGh = hasCommand('gh');
if (!hasGh && !DRY) {
  fail('未找到 gh 命令。发布 Release 需要它：\n'
    + '    winget install GitHub.cli     （Windows）\n'
    + '    brew install gh                （macOS）\n'
    + '  装完先登录一次： gh auth login');
}
log('  gh 命令   : ' + (hasGh ? '已安装' : '未安装（dry-run 不需要）'));

// ── 2) 打包 ─────────────────────────────────────────────────────────────
let artifacts = [];
if (SKIP_PACK) {
  // 复用 dist/ 里已有的包，但要**核对版本号** —— 用旧包的版本发版是最隐蔽的坑
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) fail('--skip-pack 但 dist/ 不存在');
  artifacts = fs.readdirSync(distDir)
    .filter((f) => f.startsWith(`qq-agent-${VERSION}-`) && /\.(zip|tar\.gz)$/.test(f))
    .map((f) => path.join(distDir, f));
  if (!artifacts.length) {
    fail(`--skip-pack 但 dist/ 里没有匹配当前版本 ${VERSION} 的包：\n  `
      + fs.readdirSync(distDir).join('\n  '));
  }
  log('  打包      : 跳过，复用 dist/');
} else {
  log('  打包      : pack-release.mjs（这一步要一两分钟）…');
  if (DRY) {
    log('             dry-run：跳过实际打包');
  } else {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pack-release.mjs')], {
        cwd: ROOT, stdio: 'inherit'
      });
    } catch (e) {
      fail('打包失败：' + (e?.message ?? e));
    }
    const distDir = path.join(ROOT, 'dist');
    artifacts = fs.readdirSync(distDir)
      .filter((f) => f.startsWith(`qq-agent-${VERSION}-`) && /\.(zip|tar\.gz)$/.test(f))
      .map((f) => path.join(distDir, f));
    if (!artifacts.length) fail(`打包完成但 dist/ 里没找到 qq-agent-${VERSION}-* 的产物`);
  }
}
log('  产物      : ' + (artifacts.length ? artifacts.map((a) => path.basename(a)).join(', ') : '(dry-run 未产出)'));

// ── 3) 执行 ─────────────────────────────────────────────────────────────
console.log('\n将执行：');
console.log(`  1. git tag ${TAG}`);
console.log(`  2. git push origin ${TAG}`);
console.log(`  3. gh release create ${TAG} ${artifacts.map((a) => '"' + a + '"').join(' ')} --title "${TAG}"`);
console.log(`     → https://github.com/${repo}/releases/tag/${TAG}`);
if (NOTES) console.log(`     说明: ${NOTES}`);

if (DRY) {
  console.log('\n演练结束（未打 tag、未上传）。去掉 --dry-run 执行。');
  process.exit(0);
}

if (!ASSUME_YES) {
  // 交互确认：发版对外可见，不想手抖就加 --yes
  const isTty = process.stdin.isTTY;
  if (isTty) {
    const rl = await import('node:readline/promises');
    const ans = await rl.createInterface({ input: process.stdin, output: process.stdout })
      .question(`\n确认发版 ${TAG}？输入 yes 继续：`);
    if (ans.trim().toLowerCase() !== 'yes') { console.log('已取消。'); process.exit(0); }
  } else if (!ASSUME_YES) {
    fail('非交互环境下必须显式加 --yes（或先跑 --dry-run 确认）');
  }
}

log('\n打 tag…');
if (!gitOk) fail('本机无法调用 git（' + gitBroken + '），无法打 tag。请在正常终端里重试。');
git('tag', '-a', TAG, '-m', NOTES || `发布 ${TAG}`);

log('推 tag…');
try {
  git('push', 'origin', TAG);
} catch (e) {
  // tag 推送失败要回滚：留在本地会让下次发版一直撞"tag 已存在"
  console.error('✗ 推送 tag 失败，正在删除本地 tag 以免下次发版被拦：');
  try { git('tag', '-d', TAG); } catch { /* 已尽力 */ }
  fail(String(e?.message ?? e));
}

log('创建 Release…');
const ghArgs = ['release', 'create', TAG, ...artifacts, '--title', TAG, '--repo', repo];
if (NOTES) ghArgs.push('--notes', NOTES);
try {
  execFileSync('gh', ghArgs, { cwd: ROOT, stdio: 'inherit' });
} catch (e) {
  // Release 创建失败**不回滚 tag**：tag 已经推上去了，回滚会让本地远端不一致。
  // 正确做法是告诉用户怎么补：gh release create TAG --repo repo
  console.error(`\n✗ 创建 Release 失败，但 tag ${TAG} 已经推上去了（不要删 tag）。`);
  console.error('  产物还在 dist/，补发命令：');
  console.error(`    gh release create ${TAG} ${artifacts.map((a) => '"' + a + '"').join(' ')} --title "${TAG}" --repo ${repo}`);
  process.exit(1);
}

console.log('\n' + '═'.repeat(40));
console.log('✅ 发版完成：' + TAG);
console.log('   ' + `https://github.com/${repo}/releases/tag/${TAG}`);
console.log('   下载地址就是上面页面里的产物链接，用户点它下载 zip 覆盖安装目录。');
console.log('═'.repeat(40));
