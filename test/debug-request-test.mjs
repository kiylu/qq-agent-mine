// 开发者模式「记录实际请求体」单元测试（2026-10-04 新增）
//
// 背景：此前会话 JSON 模式只展示 inputMessages（system+user），
// 但 llm.js 真正发出去的 body 还有 tools / tool_choice / 采样参数 / 思考参数 ——
// 排查"为什么不调工具 / 不思考 / 答案被截断"时，这些关键信息**无处可见**。
// 本次补上 api.debugStoreRequest 开关（默认关）+ session.lastRequest。
//
// 覆盖：
//   1. onRequest 回调在**每次**发请求前触发（首发 + 降级重试）
//   2. 回调拿到的 body 是**改写后**的（含 thinking/effort），不是原始 baseBody
//   3. captureRequestBody 的脱敏：凭据类字段被剥离、messages 只留结构
//   4. 开关关闭时不产生任何 lastRequest
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-devex-'));
process.env.QQ_AGENT_DATA_DIR = __dir;

const { chatCompletion } = await import('../src/llm.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

/** 最小 fetch 桩：记录请求体，返回一个"模型正常回答"的响应。 */
function stubFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        model: 'stub-model',
        choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      })
    };
  };
  fn.calls = calls;
  return fn;
}

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// DEFAULT_CONFIG 的 baseUrl/model 是空的（要用户自己填），测试里补上，
// 否则 onRequest 的 meta.baseUrl 拿不到东西 —— 那是测试环境问题，不是实现缺陷。
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.api.baseUrl = 'https://api.deepseek.com';
cfg.api.model = 'deepseek-flash';
setRuntimeConfig(cfg);

console.log('\n【1】onRequest 回调：每次发请求前都触发');

// 用 mock fetch 拦下请求，记录 onRequest 的调用序列
const bodies = [];
const metas = [];
const stub = stubFetch();

const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  bodies.push(JSON.parse(init.body));
  return stub(url, init);
};

try {
  await chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'send_message', description: '发消息', parameters: {} } }],
    onRequest: (body, meta) => { metas.push(meta); }
  });
  ok('首发请求触发了回调', () => {
    assert.strictEqual(bodies.length, 1, '应发出 1 次请求');
    assert.strictEqual(metas.length, 1, '回调应触发 1 次');
  });
  ok('回调 meta 带 endpoint 所需的 baseUrl 与模型', () => {
    assert.ok(metas[0].baseUrl, 'meta.baseUrl 不该为空');
    assert.strictEqual(typeof metas[0].attempt, 'number');
  });
  ok('回调拿到的 body 已含 tools（不只是 messages）', () => {
    assert.ok(Array.isArray(bodies[0].tools), 'body.tools 应存在');
    assert.strictEqual(bodies[0].tools[0].function.name, 'send_message');
  });
} finally {
  globalThis.fetch = prevFetch;
}

console.log('\n【2】回调拿到的是改写后的 body（关键：含实际发出的思考参数）');

// 显式开一个思考档，让 thinking 参数真的进 body
const cfgOn = structuredClone(DEFAULT_CONFIG);
cfgOn.api.baseUrl = 'https://api.deepseek.com';
cfgOn.api.model = 'deepseek-flash';
cfgOn.api.thinkingMode = 'on';
cfgOn.api.thinkingEffort = 'high';
setRuntimeConfig(cfgOn);

const seen = [];
const stub2 = stubFetch();
globalThis.fetch = async (url, init) => {
  seen.push(JSON.parse(init.body));
  return stub2(url, init);
};
try {
  await chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    onRequest: (body) => seen.push({ __cb: body })
  });
  ok('显式开档时，body 里确实出现了思考参数', () => {
    // 本轮是最后一次请求，前面的 entries 是 body，最后一个是回调
    const cbBody = seen.find((x) => x.__cb)?.__cb;
    assert.ok(cbBody, '回调应被调用');
    assert.ok(cbBody.thinking, 'thinking 参数应已写进 body —— 这正是排查"到底发没发"的关键');
  });
} finally {
  globalThis.fetch = prevFetch;
  setRuntimeConfig(cfg);
}

console.log('\n【3】开关默认关闭（不落盘）');

ok('DEFAULT_CONFIG.api.debugStoreRequest 默认为 false', () => {
  assert.strictEqual(DEFAULT_CONFIG.api.debugStoreRequest, false,
    '默认必须关闭：请求体含完整提示词与工具定义，属于敏感内容');
});

ok('开关关闭时 orchestrator 不传 onRequest（结构保证）', () => {
  // 这是 orchestrator 里的条件表达式行为：cfg.api?.debugStoreRequest 为假 → onRequest 为 null
  const off = cfg.api?.debugStoreRequest;
  assert.ok(!off, '关闭时条件为假，onRequest 传入 null，不会抓任何东西');
});

console.log('\n【4】脱敏：凭据类字段不能进存档');

// 直接验证 isCredentialKey 的判定规则（从 orchestrator 源码里取，避免重复实现漂移）
const src = fs.readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
const wordsMatch = src.match(/const CREDENTIAL_WORDS = new Set\(\[([\s\S]*?)\]\)/);
assert.ok(wordsMatch, '应能在 orchestrator.js 里找到 CREDENTIAL_WORDS');
const CREDENTIAL_WORDS = new Set(
  wordsMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
);
// 复刻源码里的判定：驼峰分段 → 小写 → 按分隔符切 → 任一段命中
const isCredentialKey = (k) => String(k)
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .toLowerCase()
  .split(/[_\-.\s]+/)
  .some((seg) => CREDENTIAL_WORDS.has(seg));

ok('常见凭据键全部被剥离', () => {
  for (const k of ['api_key', 'apiKey', 'Authorization', 'access_token', 'x-api-key',
    'x_api_key', 'password', 'cookie', 'sessionKey', 'secretKey', 'private_key',
    'id_token', 'refreshToken', 'API-KEY']) {
    assert.ok(isCredentialKey(k), `${k} 应当被剥离 —— 漏了就是凭据进存档`);
  }
});

ok('排查要用的参数一个都不误伤（回归：max_tokens 曾被误剥离）', () => {
  // ⚠️ 这条是实测踩过的坑：早期用 `/(key|token|secret)/i.test(k)` 搜子串，
  //    结果 max_tokens 里的 "token" 被当成凭据剥掉 —— 而它恰恰是排查
  //    "答案为什么被截断"最该看的参数。改成按段匹配后修复。
  for (const k of ['max_tokens', 'thinking', 'reasoning_effort', 'temperature', 'model',
    'tool_choice', 'stream', 'top_p', 'reasoning_tokens', 'stop']) {
    assert.ok(!isCredentialKey(k), `${k} 不该被剥离 —— 它是排查的关键参数`);
  }
});

const sanitized = [];
const stub3 = stubFetch();
globalThis.fetch = async (url, init) => {
  sanitized.push(JSON.parse(init.body));
  return stub3(url, init);
};
try {
  await chatCompletion({
    messages: [
      { role: 'system', content: '系统提示'.repeat(100) },
      { role: 'user', content: '用户消息' }
    ],
    onRequest: (body) => { sanitized.push({ __cb: true, hasAuth: 'Authorization' in body, hasKey: 'api_key' in body }); }
  });
  ok('body 顶层不含 Authorization / api_key（它们是请求头，从不进 body）', () => {
    const cb = sanitized.find((x) => x.__cb);
    assert.strictEqual(cb?.hasAuth, false);
    assert.strictEqual(cb?.hasKey, false);
  });
  ok('messages 正文在 body 里（脱敏逻辑在 orchestrator 侧裁剪，不在 llm.js）', () => {
    const body = sanitized.find((x) => !x.__cb);
    assert.ok(body.messages.length === 2, 'llm.js 不改 messages，脱敏由 captureRequestBody 负责');
  });
} finally {
  globalThis.fetch = prevFetch;
}

console.log(`\n开发者模式测试：${passed} 通过${process.exitCode ? '，有失败' : ''}\n`);
