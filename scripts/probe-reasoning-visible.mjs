// 探测：当前渠道/模型到底会不会把「思考正文」回传给我们
// 2026-10-04
//
// 起因：切到 gpt-6-sol（走中转站 market.frostfox.ai）后，会话详情不显示思考链。
// 已确认请求侧没问题 —— lastRequest.params 里 thinking:{type:'enabled'} 与
// reasoning_effort:'high' 都发出去了，且 usage 里 reasoning_tokens=10
// （**模型确实思考了**），但响应 raw.choices[0].message 里没有任何 reasoning 字段。
//
// 本脚本把**与线上完全相同**的思考参数发出去，用「非流式」「流式」各打一次：
//   · 思考正文有没有回传？字段名叫什么？
//   · 若没有，是"根本没思考"还是"思考了但端点没回传"？
//
// 关键设计：
//   1. 参数**不是手写**的 —— 复用 src/thinking.js 的 resolveThinkingRequest +
//      buildThinkingParams，所以连设置页手动指定的方言也会生效，与线上同源。
//   2. 默认**带上工具定义**（生产永远带 tools，见 orchestrator.js）。首版不带工具
//      被网关判为 "periodic repeated short requests" 直接 403 —— 带上工具不仅更
//      忠实于线上形态，也避免被反滥用规则误杀。
//   3. 两次请求之间**留间隔**（默认 10s），同样是为了不被当成周期性探测。
//
// 用法：
//   node scripts/probe-reasoning-visible.mjs
//   node scripts/probe-reasoning-visible.mjs --model=gpt-6-sol --base=https://market.frostfox.ai/v1
//   node scripts/probe-reasoning-visible.mjs --no-tools --gap=20000
//   Key：优先读 data/config.json 的 api.apiKey，其次环境变量 DEEPSEEK_API_KEY。
//
// 与生产的唯一差异：加了 max_tokens 安全阀、两次调用之间加了间隔。
import fs from 'node:fs';
import {
  resolveThinkingRequest, buildThinkingParams, extractReasoning, extractReasoningTokens
} from '../src/thinking.js';

const FILL_ME = '';

// ── 读配置（与线上同源） ──
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url), 'utf8')); } catch { /* 用默认值 */ }
const api = cfg.api || {};

// 命令行覆盖（--model=... / --base=... / --gap=... / --no-tools）
const argv = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) argv[m[1]] = m[2];
  else if (a === '--no-tools') argv.tools = '0';
}

const BASE = String(argv.base || api.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = String(argv.model || api.model || 'deepseek-flash');
const GAP_MS = Math.max(0, Number(argv.gap ?? 10000) || 0);
const USE_TOOLS = argv.tools !== '0';
const ONLY = String(argv.only || 'both').toLowerCase();      // both | nonstream | stream
const TIMEOUT_MS = Math.max(5000, Number(argv.timeout ?? 240000) || 240000);
const KEY = String(FILL_ME || api.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();

if (!KEY) {
  console.error('❌ 没找到 API Key：data/config.json 的 api.apiKey、FILL_ME、DEEPSEEK_API_KEY 都是空。');
  process.exit(1);
}

/** 输出脱敏：任何打印过的东西都过一遍。 */
const mask = (s) => String(s == null ? '' : s).replaceAll(KEY, '***');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 用生产逻辑算出这次要发的思考参数 ──
const resolved = resolveThinkingRequest(api, {});
const built = buildThinkingParams({ effort: resolved.effort, dialect: resolved.dialect, budget: resolved.budget });

console.log('═'.repeat(78));
console.log('探测：渠道 / 模型是否回传「思考正文」');
console.log(`端点   : ${BASE}/chat/completions`);
console.log(`模型   : ${MODEL}`);
console.log(`方言   : ${resolved.dialect}${resolved.manual ? '（手动指定）' : '（自动判定）'} — ${resolved.reason}`);
console.log(`档位   : ${resolved.effort || '(空 = 不指定)'}`);
console.log(`实发参数: ${JSON.stringify(built.params)}${built.omitTemperature ? '  [+ 删掉 temperature]' : ''}`);
console.log(`带工具 : ${USE_TOOLS ? '是（更贴近线上，避开"短请求"判定）' : '否'}      两次间隔: ${GAP_MS}ms`);
console.log('═'.repeat(78));

// 需要"值得思考"的题，否则模型可能一眼出答案、什么都不想。
const PROMPT = '一个水池，进水管单独开 4 小时注满，出水管单独开 6 小时排空。'
  + '现在池子已经有一半水，两管同时开，还要几小时注满？先说推理过程，再给结论。';

// 与线上同形态的最小工具集（不是全部，够让请求体不再"短"即可）。
const TOOLS = [
  { type: 'function', function: { name: 'send_message', description: '发送一条 QQ 消息；传数组可分多条发送。', parameters: { type: 'object', properties: { text: { type: 'string', description: '要说的话' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'web_search', description: '联网搜索最新信息。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'get_recent_messages', description: '往前翻聊天记录。', parameters: { type: 'object', properties: { limit: { type: 'number' } } } } },
  { type: 'function', function: { name: 'finish', description: '结束本次处理。', parameters: { type: 'object', properties: { summary: { type: 'string' } } } } }
];

function makeBody(stream) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    stream,
    tool_choice: 'auto',
    max_tokens: 1024,          // 安全阀
    ...built.params
  };
  if (USE_TOOLS) body.tools = TOOLS;
  if (built.omitTemperature) delete body.temperature;
  return body;
}

/** 逐个候选字段找"思考正文"，顺便记录字段名 —— 端点用哪个名字是关键线索。 */
function findReasoning(message = {}) {
  const hits = [];
  const push = (name, val) => {
    if (typeof val === 'string' && val.trim()) {
      hits.push({ name, note: `${val.length} 字符`, preview: val.trim().slice(0, 50) });
    } else if (val != null) {
      hits.push({ name, note: Array.isArray(val) ? `数组(${val.length})` : typeof val, preview: JSON.stringify(val).slice(0, 50) });
    }
  };
  push('reasoning_content', message.reasoning_content);
  push('reasoning', message.reasoning);
  push('thinking', message.thinking);
  push('thoughts', message.thoughts);
  push('reasoning_details', message.reasoning_details);
  if (Array.isArray(message.content)) {
    const parts = message.content.filter((p) => p?.type === 'thinking' || p?.type === 'reasoning');
    if (parts.length) push('content[type=thinking]', JSON.stringify(parts));
  }
  return hits;
}

const withTimeout = async (fn, ms = TIMEOUT_MS) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(timer); }
};

// ── ① 非流式 ──
async function callNonStream() {
  const t0 = Date.now();
  return withTimeout(async (signal) => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(makeBody(false)),
      signal
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, status: res.status, ms, err: mask(text).slice(0, 400) };
    let json;
    try { json = JSON.parse(text); } catch {
      return { ok: false, status: res.status, ms, err: `无法解析 JSON：${mask(text).slice(0, 200)}` };
    }
    const msg = json?.choices?.[0]?.message ?? {};
    return {
      ok: true, status: res.status, ms,
      msgKeys: Object.keys(msg),
      hits: findReasoning(msg),
      reasoningText: extractReasoning(msg),
      rcTokens: extractReasoningTokens(json.usage) || Number(json?.usage?.completion_tokens_details?.reasoning_tokens) || 0,
      usageDetails: json?.usage?.completion_tokens_details ?? null,
      content: typeof msg.content === 'string' ? msg.content : String(msg.content),
      hasToolCalls: Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0,
      rawMessage: JSON.stringify(msg).slice(0, 900)
    };
  });
}

// ── ② 流式（很多中转站只在流式 delta 里给 reasoning） ──
async function callStream() {
  const t0 = Date.now();
  return withTimeout(async (signal) => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(makeBody(true)),
      signal
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, ms: Date.now() - t0, err: mask(text).slice(0, 400) };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deltaKeys = new Set();
    let reasoning = '';
    let content = '';
    let usage = null;
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        chunks++;
        if (j.usage) usage = j.usage;
        const d = j?.choices?.[0]?.delta ?? {};
        for (const k of Object.keys(d)) deltaKeys.add(k);
        if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
        if (typeof d.reasoning === 'string') reasoning += d.reasoning;
        if (typeof d.content === 'string') content += d.content;
      }
    }
    return {
      ok: true, status: res.status, ms: Date.now() - t0, chunks,
      deltaKeys: [...deltaKeys], reasoning, content,
      rcTokens: usage ? extractReasoningTokens(usage) : 0,
      deltaUsage: usage?.completion_tokens_details ?? null
    };
  });
}

// ── 跑 ──
const ranNs = ONLY !== 'stream';
const ranSt = ONLY !== 'nonstream';
const timeoutNote = `超时 ${Math.round(TIMEOUT_MS / 1000)}s`;

function reportNonStream(r) {
  if (!r.ok) {
    console.log(`  ❌ HTTP ${r.status}  ${r.ms}ms`);
    console.log(`     ${String(r.err).replace(/\s+/g, ' ')}`);
    return;
  }
  console.log(`  ✅ HTTP ${r.status}  ${r.ms}ms`);
  console.log(`  message 字段 : ${r.msgKeys.join(', ') || '(空)'}`);
  console.log(`  工具调用     : ${r.hasToolCalls ? '有' : '无'}      思考 token : ${r.rcTokens}`);
  console.log(`  completion_details: ${JSON.stringify(r.usageDetails)}`);
  if (r.hits.length) {
    for (const h of r.hits) console.log(`  🎯 发现思考字段 ${h.name} → ${h.note}  预览：${h.preview}`);
  } else {
    console.log('  ⚪ 响应里没有任何思考正文字段');
  }
  console.log(`  正文预览     : ${JSON.stringify(String(r.content).slice(0, 80))}`);
  console.log(`  message 原文 : ${r.rawMessage}`);
}

function reportStream(r) {
  if (!r.ok) {
    console.log(`  ❌ HTTP ${r.status}  ${r.ms}ms`);
    console.log(`     ${String(r.err).replace(/\s+/g, ' ')}`);
    return;
  }
  console.log(`  ✅ HTTP ${r.status}  ${r.ms}ms  ${r.chunks} 个 chunk`);
  console.log(`  delta 出现过的字段 : ${r.deltaKeys.join(', ') || '(空)'}`);
  console.log(`  思考正文           : ${r.reasoning.trim() ? `🎯 ${r.reasoning.length} 字符` : '⚪ 无'}`);
  if (r.reasoning.trim()) console.log(`  思考预览           : ${r.reasoning.trim().slice(0, 80)}`);
  console.log(`  正文               : ${r.content.trim() ? `${r.content.length} 字符` : '无'}`);
  console.log(`  思考 token         : ${r.rcTokens}   ${JSON.stringify(r.deltaUsage)}`);
}

let ns = null;
let st = null;

if (ranNs) {
  console.log('\n【1】非流式（stream:false，与生产一致）');
  try { ns = await callNonStream(); reportNonStream(ns); }
  catch (e) {
    ns = { ok: false, status: '-', ms: 0, err: e.name === 'AbortError' ? timeoutNote : e.message };
    console.log(`  ❌ 异常：${mask(ns.err)}`);
  }
}

if (ranNs && ranSt && GAP_MS > 0) {
  console.log(`\n… 等 ${GAP_MS}ms（避免被判定为周期性探测）`);
  await sleep(GAP_MS);
}

if (ranSt) {
  console.log('\n【2】流式（stream:true）');
  try { st = await callStream(); reportStream(st); }
  catch (e) {
    st = { ok: false, status: '-', ms: 0, err: e.name === 'AbortError' ? timeoutNote : e.message };
    console.log(`  ❌ 异常：${mask(st.err)}`);
  }
}

// ── 判读 ──
console.log('\n' + '─'.repeat(78));
console.log('判读：');

const parts = [];
if (ranNs) parts.push({ name: '非流式', r: ns, has: !!(ns?.ok && ns.hits.length), mode: 'nonstream' });
if (ranSt) parts.push({ name: '流式', r: st, has: !!(st?.ok && st.reasoning.trim()), mode: 'stream' });
const okParts = parts.filter((p) => p.r?.ok);
const tokens = Math.max(ns?.rcTokens ?? 0, st?.rcTokens ?? 0);
const otherMode = ranNs ? 'stream' : 'nonstream';

if (!okParts.length) {
  console.log('  · ⚠️ 请求都没成功 —— **无法判定**，不要当成"没有思考"。');
  for (const p of parts) console.log(`    ${p.name}: HTTP ${p.r?.status ?? '-'}`);
  const blocked = parts.some((p) => /probe_denied|not permitted|forbidden|403/i.test(String(p.r?.err || '')));
  if (blocked) {
    console.log('    网关把这次调用当成"自动化探测"拒了（错误码 periodic_probe_denied）。');
    console.log('    → 该渠道有反探测策略，独立探针可能一直跑不通。');
    console.log('    → 改用**真实会话里落盘的 raw** 判断更可靠（开发者模式下会存请求/响应）。');
  }
} else if (okParts.length === 1) {
  const p = okParts[0];
  console.log(`  · 本次只测了 ${p.name}：`);
  if (p.has) {
    console.log('    该模式**能**拿到思考正文 → 端点回传正常。');
    console.log('    UI 不显示要另查渲染侧（ui/app/02-sse-sessions.js:728：正文与思考都空则跳过该轮）。');
  } else if (tokens > 0) {
    console.log(`    **没有**思考正文，但 usage 报告了 ${tokens} 个思考 token`);
    console.log('    → 模型确实思考了，端点只转发计数、不转发正文。');
    console.log(`    → 另一模式是否不同需实测：node scripts/probe-reasoning-visible.mjs --only=${otherMode} --gap=0`);
  } else {
    console.log('    **没有**思考正文，思考 token 也是 0 → 该模型/渠道对当前参数没产生思考。');
  }
} else {
  const nsHas = parts.find((p) => p.mode === 'nonstream')?.has;
  const stHas = parts.find((p) => p.mode === 'stream')?.has;
  if (nsHas && stHas) {
    console.log('  · 两种模式都能拿到思考正文 → 端点正常。');
    console.log('    那 UI 不显示的原因在别处（ui/app/02-sse-sessions.js:728），需另查渲染条件。');
  } else if (nsHas && !stHas) {
    console.log('  · 非流式有、流式没有 → 少见，端点流式实现可能不完整，按非流式为准。');
  } else if (!nsHas && stHas) {
    console.log('  · 只有流式有、非流式没有 → **中转站只在流式下回传思考**。');
    console.log('    本项目当前用 stream:false（lastRequest.params 里可见），所以思考拿不到。');
    console.log('    对策：换非流式也回传的渠道/模型；或对该渠道在 llm.js 里改走流式。');
  } else if (tokens > 0) {
    console.log(`  · 两种模式都没有思考正文，但 usage 报告了思考 token（${tokens} 个）`);
    console.log('    → **模型思考了，端点把正文吞了**（只转发计数、不转发内容）。');
    console.log('    这属网关侧行为，本项目无法绕过（除非换渠道）。');
  } else {
    console.log('  · 两种模式都没有思考正文，思考 token 也是 0');
    console.log('    → 该模型/渠道对当前参数**没产生思考**。');
    console.log(`    当前实发参数 ${JSON.stringify(built.params)}；`);
    console.log('    若模型是 OpenAI 系，它只认 reasoning_effort，不认 thinking。');
  }
}
console.log('─'.repeat(78));
