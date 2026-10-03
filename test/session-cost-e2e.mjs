// 会话成本 · 端到端接口校验（test/session-cost-test.mjs 的 --e2e 拆出独立文件）
//
// 守的不变量：列表接口与详情接口的 cost 口径必须一致。
// 关键点：详情走 `sessions.get(id)` 直读磁盘原始文件，而成本**不落盘**
// （价格表会变，落盘就成了过期数字，见 src/sessions.js · #summary 注释）。
// 所以详情路由必须显式调 withCost() 补上 —— 漏掉就是"列表有金额、点进去空白"。
//
// ⚠️ 必须是**独立进程**：QQ_AGENT_DATA_DIR 必须在 import src/config.js 之前设好，
// 而 config.js 在模块顶层就固化了 DATA_DIR。放进 session-cost-test.mjs 里跑会
// 读到用户真实的 data/（已踩过一次，见本文件与主测试的注释）。
//
// 用法：node test/session-cost-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ① 先隔离数据目录 —— 必须早于任何 src/ 的 import
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sesscost-e2e-'));
process.env.QQ_AGENT_DATA_DIR = __dir;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// ② 之后才能安全 import 源码
const { createApp } = await imp('src/app.js');
const { setRuntimeConfig } = await imp('src/config.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

const app = createApp({ log: () => {} });
const port = await app.start(0);
console.log('=== 会话成本 · 端到端（真实服务，无 mock）===\n');

// 开官方价，走内置价格表里 deepseek-v4-flash 的峰谷分时档
setRuntimeConfig({ api: { useOfficialPrice: true, modelPrices: {} } });

const SID = 'e2e-cost-1';
fs.mkdirSync(path.join(__dir, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(__dir, 'sessions', `${SID}.json`), JSON.stringify({
  id: SID,
  chatKey: 'group:1',
  status: 'done',
  model: 'deepseek-v4-flash',
  vendor: 'deepseek',
  // 高峰时刻（周一 14:00）→ 期望按 peak 档计价（in=2 / out=8 / cached=0.04）
  startedAt: new Date(2026, 0, 5, 14, 0, 0).getTime(),
  endedAt: new Date(2026, 0, 5, 14, 1, 0).getTime(),
  usage: { promptTokens: 125000, cachedTokens: 100000, completionTokens: 8000, totalTokens: 133000, calls: 4 },
  messages: [{ role: 'user', content: 'hi' }],
  sent: []
}));

const base = `http://127.0.0.1:${port}`;

// ── 列表接口 ──
const list = await (await fetch(`${base}/api/sessions?limit=100`)).json();
const item = list.sessions.find((s) => s.id === SID);
check('数据目录已隔离（未读用户真实 data/）', path.resolve(__dir) !== path.resolve(ROOT, 'data'));
check('列表接口带 cost', item?.cost != null, JSON.stringify(item?.costMeta));
check('列表 costMeta 含 hasPeakTiers', item?.costMeta?.hasPeakTiers === true, JSON.stringify(item?.costMeta));
check('列表识别为高峰档 peak=true', item?.costMeta?.peak === true, JSON.stringify(item?.costMeta));
// 0.025M×2 + 0.1M×0.04 + 0.008M×8 = 0.05 + 0.004 + 0.064 = 0.118
check('列表金额 = 0.118（高峰档手算一致）', item?.cost != null && near(item.cost, 0.118), String(item?.cost));

// ── 详情接口（本文件的核心：路由必须接 withCost）──
const det = await (await fetch(`${base}/api/sessions/${SID}`)).json();
check('详情接口带 cost（路由已接 withCost）', det?.cost != null, JSON.stringify(det?.costMeta));
check('详情与列表金额一致', det?.cost != null && near(det.cost, item?.cost), `${det?.cost} vs ${item?.cost}`);
check('详情 costMeta 带 hasPeakTiers', det?.costMeta?.hasPeakTiers === true, JSON.stringify(det?.costMeta));
check('详情保留原始字段 messages', Array.isArray(det?.messages) && det.messages.length === 1);
check('详情保留原始字段 usage', det?.usage?.promptTokens === 125000, JSON.stringify(det?.usage));

// ── 闲时：同一模型同一 token，凌晨 3 点应更便宜且 peak=false ──
const SID_OFF = 'e2e-cost-offpeak';
fs.writeFileSync(path.join(__dir, 'sessions', `${SID_OFF}.json`), JSON.stringify({
  id: SID_OFF, chatKey: 'group:1', status: 'done',
  model: 'deepseek-v4-flash', vendor: 'deepseek',
  startedAt: new Date(2026, 0, 5, 3, 0, 0).getTime(),
  endedAt: new Date(2026, 0, 5, 3, 1, 0).getTime(),
  usage: { promptTokens: 125000, cachedTokens: 100000, completionTokens: 8000, totalTokens: 133000, calls: 4 },
  messages: [], sent: []
}));
const off = await (await fetch(`${base}/api/sessions/${SID_OFF}`)).json();
check('闲时 peak=false', off?.costMeta?.peak === false, JSON.stringify(off?.costMeta));
// 0.025M×1 + 0.1M×0.02 + 0.008M×4 = 0.025 + 0.002 + 0.032 = 0.059
check('闲时金额 = 0.059（闲时价更便宜）', off?.cost != null && near(off.cost, 0.059), String(off?.cost));
check('闲时比高峰便宜', off?.cost != null && item?.cost != null && off.cost < item.cost);

// ── 无 token 的会话：两个入口都必须是 null（不是 0）──
const SID_EMPTY = 'e2e-cost-empty';
fs.writeFileSync(path.join(__dir, 'sessions', `${SID_EMPTY}.json`), JSON.stringify({
  id: SID_EMPTY, chatKey: 'group:1', status: 'error', model: 'deepseek-v4-flash',
  startedAt: Date.now(), usage: null, messages: [], sent: []
}));
const empty = await (await fetch(`${base}/api/sessions/${SID_EMPTY}`)).json();
check('无 token：详情 cost=null（不是 0）', empty?.cost === null, JSON.stringify(empty?.cost));
check('无 token：详情 costMeta=null', empty?.costMeta === null, JSON.stringify(empty?.costMeta));

// ── 404 不受影响 ──
const nf = await fetch(`${base}/api/sessions/no-such-session-xyz`);
check('不存在的会话仍返 404', nf.status === 404, String(nf.status));

await app.stop();
fs.rmSync(__dir, { recursive: true, force: true });
console.log(`\n=== ${fail ? 'FAILED' : 'ALL PASSED'} — pass=${pass} fail=${fail} ===`);
process.exit(fail ? 1 : 0);
