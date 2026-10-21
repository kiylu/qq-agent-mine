// 插件会话桥 · 端到端校验（src/plugin-sessions.js）
//
// 守的不变量（都是"错了不会报错、只会静默不对"的那种）：
//   1. 插件通过 api.sessions.begin/finish 记的运行，**立刻**出现在 /api/sessions
//      （不依赖重启，也不依赖 reconcileInBackground 的一次性闸）；
//   2. 详情页要用的字段齐全（systemPrompt / userPrompt / sent / messages / cost）；
//   3. token 真的进了今日用量（#bumpTodayUsage 要求 messages[].raw 与 usage 同时存在）；
//   4. 插件会话不能被"重试"（它没有触发批，重试会让核心凭空回一遍）；
//   5. loadPlugins / watchPlugins 都真的把桥递给了 setup(api) ——
//      特别是 watchPlugins 内部那次重新 loadPlugins（漏传的话热重载后记录会静默停止）。
//
// 隔离：QQ_AGENT_DATA_DIR / SKILLS_DIR / PLUGINS_DIR 必须在 import src/ 之前设好
// （config.js 与 plugin-loader.js 都在模块顶层固化路径）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ① 先隔离目录 —— 必须早于任何 src/ 的 import
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-sess-'));
const EXT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-sess-ext-'));
process.env.QQ_AGENT_DATA_DIR = DATA_DIR;
process.env.QQ_AGENT_SKILLS_DIR = path.join(EXT_DIR, 'skills');
process.env.QQ_AGENT_PLUGINS_DIR = path.join(EXT_DIR, 'plugins');
fs.mkdirSync(process.env.QQ_AGENT_SKILLS_DIR, { recursive: true });
fs.mkdirSync(process.env.QQ_AGENT_PLUGINS_DIR, { recursive: true });

// ② 之后才能安全 import 源码
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { createApp } = await imp('src/app.js');
const { setRuntimeConfig, getConfig } = await imp('src/config.js');
const { createPluginSessions } = await imp('src/plugin-sessions.js');
const { loadPlugins, watchPlugins } = await imp('src/plugin-loader.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 8000, label = '') => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch { /* 继续等 */ }
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
};

const app = createApp({ log: () => {} });
const port = await app.start(0);
const base = `http://127.0.0.1:${port}`;
console.log('=== 插件会话桥 · 端到端 ===\n');

// 价格：走官方表里的 deepseek-v4-flash，让 cost 可预期（这里只断言"有金额"，不钉具体数字）
{
  const cfg = getConfig();
  setRuntimeConfig({ ...cfg, api: { ...cfg.api, useOfficialPrice: true, modelPrices: {} } });
}

// ── 0. 缺依赖时返回 null（插件据此降级）──
check('createPluginSessions 缺 sessions → null', createPluginSessions({ emit: () => {} }) === null);
check('createPluginSessions 缺 emit → null', createPluginSessions({ sessions: app.sessions }) === null);

// ── 1. begin → update → finish，全程走核心 SessionRegistry ──
const bridge = createPluginSessions({ sessions: app.sessions, emit: app.emit, log: () => {} });
check('桥可用', Boolean(bridge && typeof bridge.begin === 'function'));

const readUsageToday = () => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8').replace(/^﻿/, '')); }
  catch { return {}; }   // 还没写过 = 今天第一次记
};
const usageBefore = readUsageToday();

const run = bridge.begin({
  chatKey: 'private:10001',
  pluginId: 'silence-ping',
  triggerSummary: '主动私信 · 测试对象'
});
check('begin 返回句柄', Boolean(run && run.id));
check('会话键非法时返回 null', bridge.begin({ chatKey: 'not-a-chat', pluginId: 'x' }) === null);

run.update({ activity: '正在判断要不要开口…' });
const during = (await (await fetch(`${base}/api/sessions?limit=100`)).json()).sessions.find((s) => s.id === run.id);
check('运行中即出现在列表（无需重启）', Boolean(during), '列表里没有刚创建的会话');
check('运行中状态 = running', during?.status === 'running', String(during?.status));
check('列表摘要带 triggerKind = plugin:silence-ping', during?.triggerKind === 'plugin:silence-ping', String(during?.triggerKind));
check('activity 已刷新到卡片', during?.activity === '正在判断要不要开口…', String(during?.activity));

const FINAL_TEXT = '{"send":true,"message":"在吗"}';
const llmResult = {
  message: { content: FINAL_TEXT },
  usage: { prompt_tokens: 12345, completion_tokens: 67, total_tokens: 12412, prompt_tokens_details: { cached_tokens: 10000 } },
  model: 'deepseek-v4-flash',
  raw: { model: 'deepseek-v4-flash', created: Math.floor(Date.now() / 1000), usage: { prompt_tokens: 12345, completion_tokens: 67, total_tokens: 12412, prompt_tokens_details: { cached_tokens: 10000 } } },
  _usedApi: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com' }
};
const finishedId = run.finish({
  status: 'done',
  text: FINAL_TEXT,
  sent: [{ type: 'text', text: '在吗', at: '20:01:02' }],
  llmResult,
  systemPrompt: '你叫「测试机器人」……',
  userPrompt: '现在要不要主动发私信？按约定的 JSON 输出。'
});
check('finish 返回会话 id', finishedId === run.id, String(finishedId));
check('finish 幂等（重复调用不报错）', run.finish({ status: 'error' }) === null);

// ── 2. 列表 / 详情字段 ──
const list = (await (await fetch(`${base}/api/sessions?limit=100`)).json()).sessions;
const item = list.find((s) => s.id === run.id);
check('结束后仍在列表', Boolean(item));
check('终态 = done', item?.status === 'done', String(item?.status));
check('列表带成本（cost != null）', item?.cost != null, JSON.stringify(item?.costMeta));
check('列表带 usage', item?.usage?.promptTokens === 12345 && item?.usage?.calls === 1, JSON.stringify(item?.usage));

const detail = await (await fetch(`${base}/api/sessions/${run.id}`)).json();
check('详情：systemPrompt 落盘', detail?.systemPrompt === '你叫「测试机器人」……', String(detail?.systemPrompt).slice(0, 20));
check('详情：userPrompt 落盘', String(detail?.userPrompt || '').includes('要不要主动发私信'));
check('详情：sent 落盘', Array.isArray(detail?.sent) && detail.sent[0]?.text === '在吗', JSON.stringify(detail?.sent));
check('详情：messages[0].raw 保留（用量页逐次调用行的来源）', detail?.messages?.[0]?.raw?.usage?.prompt_tokens === 12345);
check('详情：模型已记录', detail?.model === 'deepseek-v4-flash', String(detail?.model));
check('详情与列表成本一致', detail?.cost != null && item?.cost != null && Math.abs(detail.cost - item.cost) < 1e-9);

// ── 3. 今日用量真的增加了（#bumpTodayUsage 生效）──
const usageAfter = readUsageToday();
check('今日用量 runs +1', Number(usageAfter.runs) === Number(usageBefore.runs || 0) + 1, `${usageBefore.runs} -> ${usageAfter.runs}`);
check('今日用量 promptTokens 已累加', Number(usageAfter.promptTokens) >= 12345, String(usageAfter.promptTokens));
check('今日用量 cachedTokens 已累加', Number(usageAfter.cachedTokens) >= 10000, String(usageAfter.cachedTokens));

// ── 4. 插件会话不能重试（否则核心会凭空回一遍）──
const errRun = bridge.begin({ chatKey: 'private:10002', pluginId: 'silence-ping', triggerSummary: '失败用例' });
errRun.finish({ status: 'error', error: '发送失败：模拟' });
const retry = await fetch(`${base}/api/sessions/${errRun.id}/retry`, { method: 'POST' });
const retryBody = await retry.json().catch(() => ({}));
check('插件会话重试被拒（409）', retry.status === 409, String(retry.status));
check('拒绝原因说明是插件会话', /插件/.test(String(retryBody?.error || '')), JSON.stringify(retryBody));

// ── 5. 删除可用 ──
const del = await fetch(`${base}/api/sessions/${run.id}`, { method: 'DELETE' });
check('插件会话可删除', del.status === 200, String(del.status));
const afterDel = (await (await fetch(`${base}/api/sessions?limit=100`)).json()).sessions;
check('删除后列表里消失', !afterDel.some((s) => s.id === run.id));

// ── 6. loadPlugins 真的把桥递给 setup(api) ──
const writeFixture = (dir, name, body) => {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({ id: name, name, entry: 'index.js' }), 'utf8');
  fs.writeFileSync(path.join(d, 'index.js'), body, 'utf8');
};
const roots = { skills: process.env.QQ_AGENT_SKILLS_DIR, plugins: process.env.QQ_AGENT_PLUGINS_DIR };
const PROBE_FILE = path.join(EXT_DIR, 'probe.json');
writeFixture(roots.plugins, 'probe', `
  import fs from 'node:fs';
  export function setup(api) {
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(${JSON.stringify(PROBE_FILE)}, 'utf8')); } catch {}
    existing.push({ hasBridge: Boolean(api.sessions && typeof api.sessions.begin === 'function') });
    fs.writeFileSync(${JSON.stringify(PROBE_FILE)}, JSON.stringify(existing));
  }
`);
await loadPlugins({ log: () => {}, roots, sessions: bridge });
let probes = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8'));
check('loadPlugins 带 sessions → setup 拿到桥', probes.at(-1)?.hasBridge === true, JSON.stringify(probes));

await loadPlugins({ log: () => {}, roots });   // 不传 sessions：老调用点/测试环境的形态
probes = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8'));
check('loadPlugins 不带 sessions → api.sessions 为 null（插件可降级）', probes.at(-1)?.hasBridge === false, JSON.stringify(probes));

// ── 7. 热重载：watchPlugins 内部重新 loadPlugins 时也必须带上桥 ──
// （这是本方案最容易踩的坑：漏传 → 改一下插件文件，会话记录就悄悄停了）
const watcher = watchPlugins({ log: () => {}, roots, sessions: bridge });
check('watchPlugins 已建立', Boolean(watcher));
if (watcher) {
  const before = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')).length;
  // 改一下入口文件触发重扫（fs.watch 是异步的，留足时间）
  fs.writeFileSync(path.join(roots.plugins, 'probe', 'index.js'), `
  import fs from 'node:fs';
  export function setup(api) {
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(${JSON.stringify(PROBE_FILE)}, 'utf8')); } catch {}
    existing.push({ hasBridge: Boolean(api.sessions && typeof api.sessions.begin === 'function'), reloaded: true });
    fs.writeFileSync(${JSON.stringify(PROBE_FILE)}, JSON.stringify(existing));
  }
`, 'utf8');
  let reloadProbe = null;
  try {
    reloadProbe = await waitFor(() => {
      const arr = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8'));
      return arr.length > before ? arr.at(-1) : null;
    }, 8000, '热重载后 setup 再次执行');
  } catch (error) { reloadProbe = null; console.log('  (热重载未在 8 秒内触发：' + error.message + ')'); }
  check('热重载后的新实例仍拿得到桥', reloadProbe?.hasBridge === true, JSON.stringify(reloadProbe));
  watcher.close();
}

// ── 8. 真实插件：silence-ping 的 runCycle 真的会建会话 ──
// 这一节守的是"插件接线对不对"：上面验证的是桥本身，这里验证插件真的调了它。
//
// ⚠️ silence-ping 是**开发者本机的示例插件**，不在版本库里（plugins/ 下只提交了
//    conversation-memory-lite）。所以这一节在干净检出上必然找不到它 ——
//    以前是直接 import 崩掉整个测试链，现在改成"缺失就跳过并说明原因"。
//    想跑这一节：把 silence-ping 放进 plugins/ 即可自动启用。
{
  const pluginEntry = path.join(ROOT, 'plugins/silence-ping/index.js');
  if (!fs.existsSync(pluginEntry)) {
    console.log('  ⚠ 跳过：plugins/silence-ping/ 不存在（该示例插件不随仓库分发）');
  } else {
    const pluginUrl = pathToFileURL(pluginEntry).href;
    const plugin = await import(pluginUrl);

  // 造两条私聊存档（插件读 data/messages，不依赖钩子）
  fs.mkdirSync(path.join(DATA_DIR, 'messages'), { recursive: true });
  const writeChat = (qq, text) => fs.writeFileSync(
    path.join(DATA_DIR, 'messages', `private_${qq}.json`),
    JSON.stringify({
      chatKey: `private:${qq}`,
      nextLocalId: 2,
      messages: [{
        id: 1, mid: null, ts: Date.now() - 3600_000,
        senderId: qq, senderName: `对象${qq}`, text, self: false, read: true, reply: null, media: []
      }]
    }),
    'utf8'
  );
  writeChat('10001', '在吗');
  writeChat('10002', '在吗');

  // 白名单放行这两个私聊
  {
    const cfg = getConfig();
    setRuntimeConfig({ ...cfg, allow: { ...(cfg.allow || {}), private: ['10001', '10002'] } });
  }

  // 让闸门全开：不限时段、不冷却、不防重复
  const settingsFor = (recordSessions) => ({
    enabled: true, dryRun: false,
    targets: '10001,10002',
    targetIdleMinMinutes: 1,
    cooldownMinutes: 1,
    quietRange: '',
    liangwenfengEnabled: false,
    maxPerDay: 100,
    targetSendRange: '1-1',
    noRepeatWhenUnreplied: false,
    resendGuardMinutes: 0,
    replyGuardMinutes: 0,
    sendGapSec: 0,
    recordSessions
  });

  // 假 api：只提供插件真正会用到的那几项（sessions 用真桥）
  const fakeApi = (recordSessions) => ({
    config: () => settingsFor(recordSessions),
    log: () => {}, warn: () => {}, error: () => {},
    // 发送能力：返回成功，避免走 OneBot HTTP
    capability: (name) => (name === 'chat.send' ? { ok: true, via: 'test' } : undefined),
    sessions: bridge
  });

  // 模型替身：永远说"发"，内容固定
  plugin.internals.aiOverride = () => ({ send: true, message: '在吗' });

  const sessionsOf = async () => (await (await fetch(`${base}/api/sessions?limit=200`)).json()).sessions
    .filter((s) => String(s.triggerKind || '') === 'plugin:silence-ping');

  plugin.setup(fakeApi(true));
  const before = (await sessionsOf()).length;
  const r1 = await plugin.internals.runCycle();
  const after1 = await sessionsOf();
  check('silence-ping runCycle 返回 sent', r1?.decided === 'sent', JSON.stringify(r1)?.slice(0, 120));
  check('silence-ping 主动发送 → 会话页新增一条', after1.length === before + 1, `${before} -> ${after1.length}`);
  const rec = after1[0];
  check('插件会话 chatKey 正确', rec?.chatKey === 'private:10001', String(rec?.chatKey));
  check('插件会话终态 = done', rec?.status === 'done', String(rec?.status));

  // 关掉 recordSessions → 不再新增（另一条私聊，避免被个人冷却拦住）
  plugin.setup(fakeApi(false));
  const before2 = (await sessionsOf()).length;
  const r2 = await plugin.internals.runCycle();
  const after2 = (await sessionsOf()).length;
  check('关闭 recordSessions 后照常发送', r2?.decided === 'sent', JSON.stringify(r2)?.slice(0, 120));
  check('关闭 recordSessions 后不再新增会话', after2 === before2, `${before2} -> ${after2}`);
  }
}

await app.stop();
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(EXT_DIR, { recursive: true, force: true });
console.log(`\n=== ${fail ? 'FAILED' : 'ALL PASSED'} — pass=${pass} fail=${fail} ===`);
process.exit(fail ? 1 : 0);
