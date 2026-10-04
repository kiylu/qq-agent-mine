// DeepSeek thinking 模式「不回传 reasoning_content 是否报 400」探测
// 2026-10-04
//
// 起因：官方文档说「带 tools 时必须回传 reasoning_content，否则 400」，
// 但本项目开 thinking + 带 tools + 不回传，**实际没报 400**。
// 三种可能，必须实测分辨（不能靠推理下结论 —— 今天已经栽过几次）：
//   A. 端点其实不校验（文档过时 / 只在别的模型上校验）
//   B. 端点校验但阈值宽松（只在校验失败时才 400，本项目恰好没触发）
//   C. 根本原因是别的东西（比如它只在"模型实际返回了 reasoning"时才要求）
//
// 用法：填 FILL_ME 或设 DEEPSEEK_API_KEY，然后 node scripts/probe-reasoning-passback.mjs
import fs from 'node:fs';

const FILL_ME = '';
const REPEAT = 2;

const KEY = (FILL_ME || process.env.DEEPSEEK_API_KEY || '').trim();
if (!KEY) {
  console.error('❌ 没找到 API Key。填 FILL_ME 或设 DEEPSEEK_API_KEY。');
  process.exit(1);
}

let CFG = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
try {
  const raw = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url), 'utf8'));
  if (raw?.api?.baseUrl) CFG.baseUrl = raw.api.baseUrl;
  if (raw?.api?.model) CFG.model = raw.api.model;
} catch { /* 默认值 */ }
const BASE = String(CFG.baseUrl).replace(/\/+$/, '');
const MODEL = CFG.model;

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather of a location',
    parameters: {
      type: 'object',
      properties: { location: { type: 'string', description: 'city name' } },
      required: ['location']
    }
  }
}];

const PROMPT = 'What is the weather in Hangzhou? Use the tool.';

async function call(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) {
      return { ok: false, status: res.status, err: text.slice(0, 400).replaceAll(KEY, '***'), ms };
    }
    const json = JSON.parse(text);
    const msg = json?.choices?.[0]?.message ?? {};
    return {
      ok: true, ms,
      hasReasoning: Boolean(msg.reasoning_content),
      rcLen: String(msg.reasoning_content || '').length,
      hasToolCalls: Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0,
      msg
    };
  } catch (e) {
    return { ok: false, err: e.name === 'AbortError' ? '超时 120s' : String(e.message), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个 assistant 条目，回传或丢弃 reasoning_content。 */
function assistantEntry(msg, withReasoning) {
  const e = { role: 'assistant', content: msg.content ?? '' };
  if (msg.tool_calls) e.tool_calls = msg.tool_calls;
  if (withReasoning) e.reasoning_content = msg.reasoning_content;
  return e;
}

console.log('═'.repeat(80));
console.log('DeepSeek：thinking 模式下不回传 reasoning_content 是否报 400');
console.log(`端点: ${BASE}    模型: ${MODEL}`);
console.log('═'.repeat(80));

// ── 阶段一：单轮（无工具结果回流），看模型是否返回 reasoning ──
console.log('\n【1】单轮请求：确认模型确实在思考');
let single = null;
for (let i = 0; i < REPEAT; i++) {
  const r = await call({
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    tools: TOOLS,
    max_tokens: 4096,
    stream: false,
    reasoning_effort: 'high',
    thinking: { type: 'enabled' }
  });
  if (i === 0) console.log('  第1次:', JSON.stringify({ ok: r.ok, status: r.status, hasReasoning: r.hasReasoning, rcLen: r.rcLen, hasToolCalls: r.hasToolCalls, err: r.err }));
  if (r.ok && r.hasReasoning) { single = r; break; }
  if (i < REPEAT - 1) await sleep(800);
}

if (!single) {
  console.log('  ❌ 模型没返回 reasoning_content，无法继续测回传行为');
  console.log('     （可能：没开思考 / 该模型不支持 / 端点异常）');
  process.exit(0);
}
console.log(`  ✅ 模型返回了 reasoning_content（${single.rcLen} 字符）`);

// ── 阶段二：工具轮，第 2 发**不回传** reasoning_content ──
console.log('\n【2】工具轮：第2发【不回传】reasoning_content');
for (let i = 0; i < REPEAT; i++) {
  const messages = [
    { role: 'user', content: PROMPT },
    assistantEntry(single.msg, false),          // ← 不带 reasoning_content
    { role: 'tool', tool_call_id: single.msg.tool_calls[0].id, content: 'Cloudy 7~13°C' }
  ];
  const r = await call({
    model: MODEL, messages, tools: TOOLS, max_tokens: 4096, stream: false,
    reasoning_effort: 'high', thinking: { type: 'enabled' }
  });
  console.log(`  第${i + 1}次:`, JSON.stringify({ ok: r.ok, status: r.status, err: r.err, hasReasoning: r.hasReasoning, rcLen: r.rcLen }));
  if (!r.ok && i === 0) {
    console.log('\n  → ❌ 确实报错了！文档成立。错误详情：');
    console.log('    ' + String(r.err).replace(/\s+/g, ' ').slice(0, 300));
  }
  if (i < REPEAT - 1) await sleep(800);
}

// ── 阶段三：对照 —— 第 2 发【回传】 ──
console.log('\n【3】对照：工具轮第2发【回传】reasoning_content');
for (let i = 0; i < REPEAT; i++) {
  const messages = [
    { role: 'user', content: PROMPT },
    assistantEntry(single.msg, true),           // ← 带 reasoning_content
    { role: 'tool', tool_call_id: single.msg.tool_calls[0].id, content: 'Cloudy 7~13°C' }
  ];
  const r = await call({
    model: MODEL, messages, tools: TOOLS, max_tokens: 4096, stream: false,
    reasoning_effort: 'high', thinking: { type: 'enabled' }
  });
  console.log(`  第${i + 1}次:`, JSON.stringify({ ok: r.ok, status: r.status, err: r.err, rcLen: r.rcLen }));
  if (i < REPEAT - 1) await sleep(800);
}

console.log('\n判读：');
console.log('  · 【2】成功而【3】也成功 → 端点**不校验**回传（文档与实际不符）');
console.log('  · 【2】报 400 而【3】成功   → 文档成立，项目有真实风险');
console.log('  · 【2】报 400 且【3】也 400 → 可能是别的原因（如 tool_call_id 配对）');
console.log('把整段输出贴回给 AI 即可。');
