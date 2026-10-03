// 验证 update-check 的 Release 解析逻辑（各种边界）。
// 不联网：把 fetch 换成桩，喂假的 GitHub API 响应，断言解析结果。
//
// ⚠️ 关键：解析片段**从 src/app.js 与 src/routes.js 里原样抽出来**再跑，
//    不是在这里抄一份。抄一份的话线上代码一改、测试还绿，就等于没测。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const routesSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');

/** 从源码里精确抽出一个 const/function。
 *  函数按大括号配对；const 按**首个分号**截断 —— 正则字面量里也有括号/分号，
 *  按配对抽会把 /qq-agent-(\d+...)-/ 这种截断成非法的正则。 */
function grab(src, name) {
  if (new RegExp(`function ${name}\\(`).test(src)) {
    const start = src.search(new RegExp(`function ${name}\\(`));
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error(`${name} 花括号不配对`);
  }
  const start = src.search(new RegExp(`const ${name} =`));
  if (start < 0) throw new Error(`源码里找不到 ${name}`);
  return src.slice(start, src.indexOf(';', start) + 1);
}

// 真实源码（不是抄的）
const UPDATE_RELEASE_PAGE = new Function(`${grab(appSrc, 'UPDATE_RELEASE_PAGE')}\nreturn UPDATE_RELEASE_PAGE;`)();
const UPDATE_ASSET_VERSION_RE = new Function(`${grab(appSrc, 'UPDATE_ASSET_VERSION_RE')}\nreturn UPDATE_ASSET_VERSION_RE;`)();
const normalizeVersion = new Function(`${grab(appSrc, 'normalizeVersion')}\nreturn normalizeVersion;`)();
const compareSemver = new Function(`${grab(appSrc, 'compareSemver')}\nreturn compareSemver;`)();

/** 直接跑 src/routes.js 里 /api/update-check 的**真实 handler**。
 *  用假的 fetch 桩喂 GitHub API 响应，handler 写出的 res.json 即结果 ——
 *  这样测的是线上那条代码路径，不是复述。 */
function makeHandler() {
  // 抽出该路由的 handler 体。
  // ⚠️ 函数体的 `{` 要从 `=>` **之后**找：`handler: async ({ res, json }) => {`
  //    那个解构参数里也有花括号，直接 indexOf('{') 会抓到参数上，
  //    抽出来的片段语法非法（表现为 handler "没写响应"）。
  const at = routesSrc.indexOf("pattern: '/api/update-check'");
  if (at < 0) throw new Error('routes.js 里找不到 /api/update-check 路由');
  const arrow = routesSrc.indexOf('=>', routesSrc.indexOf('handler: async', at));
  if (arrow < 0) throw new Error('找不到 handler 的箭头函数');
  const bodyStart = routesSrc.indexOf('{', arrow);
  let depth = 0;
  let end = -1;
  for (let j = bodyStart; j < routesSrc.length; j++) {
    const c = routesSrc[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) throw new Error('handler 花括号不配对');
  return new Function('fetch', 'UPDATE_RELEASE_API', 'UPDATE_RELEASE_PAGE',
    'UPDATE_ASSET_VERSION_RE', 'normalizeVersion', 'compareSemver', 'localVersion',
    `return async ({ res, json }) => {${routesSrc.slice(bodyStart, end + 1)}}`);
}

function parseRelease(current, status, rel) {
  const handler = makeHandler();
  // 假 fetch：只认 latest release API，其余一律 404
  const fakeFetch = async (url, opts) => {
    if (!String(url).includes('/releases/latest')) return { ok: false, status: 404, json: async () => ({}) };
    if (opts?.headers && !opts.headers['user-agent']) {
      // 真实 GitHub 缺 User-Agent 会 403 —— 顺便守住这个头别被删掉
      return { ok: false, status: 403, json: async () => ({}) };
    }
    return { ok: status >= 200 && status < 300, status, json: async () => rel };
  };
  const fn = handler(fakeFetch, 'https://api.github.com/repos/kiylu/qq-agent-mine/releases/latest',
    UPDATE_RELEASE_PAGE, UPDATE_ASSET_VERSION_RE, normalizeVersion, compareSemver,
    () => current);
  let out = null;
  // handler 签名是 `async ({ res, json })` —— res/json 都是**解构出来的**参数，
  // 所以要作为单个对象传入。json() 必须返回点什么，因为 handler 里是 `return json(...)`。
  const json = (r, code, data) => { out = { status: code, data }; return data; };
  return fn({ res: {}, json }).then(() => {
    if (out?.status !== 200) throw new Error('handler 没写响应');
    // 失败时 handler 返回 {ok:false,error}，测试用 throws() 断言
    if (out.data?.ok === false) throw new Error(out.data.error);
    return out.data;
  });
}

const main = async () => {
let pass = 0; let fail = 0;
const check = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const throws = async (fn, m) => {
  try { await fn(); fail++; console.log('  ✗ ' + m + '（本该抛错却没抛）'); }
  catch { pass++; console.log('  ✓ ' + m); }
};

console.log('\n[1] 无 Release（当前状态，GitHub 返回 404）');
{
  const r = await parseRelease('1.1.1', 404, null);
  check(r.ok === true, '降级为 ok:true 而不是报错');
  check(r.hasUpdate === false, 'hasUpdate=false');
  check(r.latest === r.current, 'latest 回落到 current（不提示有更新）');
  check(r.url === UPDATE_RELEASE_PAGE, '指向自己的 Release 页');
  check(r.url.includes('Kondius') === false, '不再引用前作者的域名');
}

console.log('\n[2] 有新 Release，且产物名带日期后缀（真实产物形态）');
{
  const rel = {
    tag_name: 'v1.2.0',
    body: '修了若干问题',
    html_url: 'https://github.com/kiylu/qq-agent-mine/releases/tag/v1.2.0',
    assets: [{
      name: 'qq-agent-1.2.0-2026-10-05-full.zip',
      browser_download_url: 'https://github.com/kiylu/qq-agent-mine/releases/download/v1.2.0/qq-agent-1.2.0-2026-10-05-full.zip'
    }]
  };
  const r = await parseRelease('1.1.1', 200, rel);
  check(r.latest === '1.2.0', '剥掉 tag 的 v 前缀');
  check(r.hasUpdate === true, '判定有更新');
  check(r.url.endsWith('qq-agent-1.2.0-2026-10-05-full.zip'), '靠版本段匹配到带日期的产物');
  check(r.assetMissing === false, 'assetMissing=false');
  check(r.notes === '修了若干问题', 'Release 说明透传到 notes');
}

console.log('\n[3] 产物名版本与 tag 不一致时不能错配');
{
  const rel = {
    tag_name: 'v1.2.0',
    assets: [
      { name: 'qq-agent-1.1.0-2026-09-01-full.zip', browser_download_url: 'https://x/old.zip' },
      { name: 'qq-agent-1.2.0-2026-10-05-full.zip', browser_download_url: 'https://x/new.zip' }
    ]
  };
  const r = await parseRelease('1.1.1', 200, rel);
  check(r.url === 'https://x/new.zip', '选中与 tag 同版本的那个，而不是第一个 zip');
}

console.log('\n[4] tag 版本比本地旧（用户手动装过新版）');
{
  const rel = { tag_name: 'v1.0.0', assets: [{ name: 'qq-agent-1.0.0-2026-01-01-full.zip', browser_download_url: 'https://x/old.zip' }] };
  const r = await parseRelease('1.1.1', 200, rel);
  check(r.hasUpdate === false, '已更新到最新 → 不提示');
  check(r.latest === '1.0.0', 'latest 仍如实反映线上版本');
}

console.log('\n[5] Release 没上传任何产物');
{
  const r = await parseRelease('1.1.1', 200, { tag_name: 'v1.2.0', assets: [] });
  check(r.assetMissing === true, 'assetMissing=true，UI 可提示去 Release 页手动下载');
  check(r.url === UPDATE_RELEASE_PAGE, '退回 Release 页而不是给 404 链接');
  check(r.hasUpdate === true, '仍然告知有新版');
}

console.log('\n[6] 异常输入');
{
  throws(() => parseRelease('1.1.1', 403, null), '403（限流）抛出可读错误');
  throws(() => parseRelease('1.1.1', 429, null), '429（限流）抛出可读错误');
  throws(() => parseRelease('1.1.1', 500, null), '500 抛出可读错误');
  throws(() => parseRelease('1.1.1', 200, { tag_name: '' }), '缺 tag_name 抛错（不静默当成有更新）');
  const r = await parseRelease('1.1.1', 200, { tag_name: 'v1.2.0', assets: null });
  check(r.assetMissing === true, 'assets 为 null 不崩');
}

console.log('\n[7] 版本号归一化');
{
  check(normalizeVersion('v1.1.1') === '1.1.1', '小写 v');
  check(normalizeVersion('V1.1.1') === '1.1.1', '大写 V');
  check(normalizeVersion(' 1.1.1 ') === '1.1.1', '带空格');
  check(normalizeVersion('1.1.1') === '1.1.1', '本来就没 v');
  check(compareSemver('1.2.0', '1.1.1') === 1, '1.2.0 > 1.1.1');
  check(compareSemver('1.1.1', '1.1.1') === 0, '相同版本相等');
  check(compareSemver('1.1.0', '1.1.1') === -1, '1.1.0 < 1.1.1');
  check(compareSemver('2.0.0', '1.9.9') === 1, '主版本号大的更新');
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
};

main();
