// 思考参数（thinking.js）单元测试：
// 验证 2026-10-04 的两处改动——
//   1. **DeepSeek/GLM 分支补发 `reasoning_effort`**：修复前该分支**完全不发**这个
//      字段，导致六档全部静默失效（无论选哪档，实际都是服务端默认 high）。
//      现在只在**开启**时发 —— 落点条件 `e && e !== 'off'` 与 `on` 恒等，
//      所以 `off` 档不发 effort（官方在 disabled 下未定义该参数语义）。
//   2. **档位映射落到厂商合法值**：DeepSeek 只承认 low/high/max，
//      本项目的 medium/xhigh 必须就近映射。
//
// 纯离线：不发起任何网络请求，只断言 `buildThinkingParams` 的输出形状。
//
// 依据数据：scripts/probe-thinking-effort.mjs（9 组 × 3 次取中位数）——
//   thinking=disabled 时 rc_tok 恒为 0，但 completion 仍随 effort 变化
//   （无 3265 / low 2589 / high 2524 / max 3142）。
import assert from 'node:assert';

const { buildThinkingParams, detectDialect, resolveThinkingRequest, THINKING_EFFORTS,
  THINKING_BODY_KEYS, SELECTABLE_DIALECTS } = await import('../src/thinking.js');
const { effectiveThinkingDialect } = await import('../src/providers.js');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const P = (effort, opts = {}) => buildThinkingParams({ effort, dialect: 'deepseek', budget: 0, ...opts });
const params = (effort, opts) => P(effort, opts).params;

console.log('\n【1】effort 独立于 thinking 开关（本次核心修复）');

ok('off 档：发 disabled，不发 effort', () => {
  const p = params('off');
  assert.deepStrictEqual(p.thinking, { type: 'disabled' });
  // off 的语义是"彻底关闭"，effort 无意义
  assert.strictEqual('reasoning_effort' in p, false, 'off 档不该发 reasoning_effort');
});

ok('enabled 时发 effort（映射为合法值）', () => {
  const p = params('low');
  assert.deepStrictEqual(p.thinking, { type: 'enabled' });
  assert.strictEqual(p.reasoning_effort, 'low');
});

ok('default（空档）：不发任何 thinking 参数 —— 沿用原有行为', () => {
  // 关键回归：用户明确要求"default 沿用现在 default 的效果"
  const r = P('');
  assert.deepStrictEqual(r.params, {}, 'default 必须一个参数都不发');
  assert.strictEqual(r.applied, false, 'default 不应标记为 applied（UI 靠这个显示"未应用"）');
});

console.log('\n【2】档位 → 厂商合法值映射');

ok('low → low（唯一原样保留的档）', () => {
  assert.strictEqual(params('low').reasoning_effort, 'low');
});

ok('medium → high（官方映射表：medium 落 high）', () => {
  assert.strictEqual(params('medium').reasoning_effort, 'high');
});

ok('high → high', () => {
  assert.strictEqual(params('high').reasoning_effort, 'high');
});

ok('xhigh → high（DeepSeek 无此档，就近向下）', () => {
  assert.strictEqual(params('xhigh').reasoning_effort, 'high');
});

ok('max → max（唯一保真的高档）', () => {
  assert.strictEqual(params('max').reasoning_effort, 'max');
});

ok('所有非 off 档都产出 DeepSeek 合法值（不出现非法参数）', () => {
  const legal = new Set(['low', 'high', 'max']);
  for (const e of THINKING_EFFORTS.filter((x) => x !== 'off')) {
    const v = params(e).reasoning_effort;
    assert.ok(legal.has(v), `档位 ${e} 产出了非法值 ${v}`);
  }
});

ok('思考开启时必须删 temperature（与思考参数互斥）', () => {
  assert.strictEqual(P('low').omitTemperature, true, 'thinking 开启时应要求上层删 temperature');
  assert.strictEqual(P('off').omitTemperature, false, 'off 不思考，temperature 可用');
});

console.log('\n【3】降级重试能摘掉新增的 reasoning_effort');

ok('reasoning_effort 在 THINKING_BODY_KEYS 里（网关拒绝时会被自动摘掉）', () => {
  // 不在的话，网关返回 400 时不会重试，会直接失败
  assert.ok(THINKING_BODY_KEYS.includes('reasoning_effort'));
});

console.log('\n【4】方言判定未受影响');

ok('api.deepseek.com 判为 deepseek 方言', () => {
  assert.strictEqual(detectDialect({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }).dialect, 'deepseek');
});

ok('resolveThinkingRequest：空 effort 原样返回空（不擅自兜底成 high）', () => {
  const r = resolveThinkingRequest({ thinkingMode: 'auto', thinkingEffort: '' }, {});
  assert.strictEqual(r.effort, '', '空档必须保持空 —— 这就是 default 的语义');
  assert.strictEqual(r.on, false);
});

console.log('\n【5】回归：其他方言的 effort 行为未被本次改动影响');

ok('openai-o 方言仍只发 reasoning_effort（不发 thinking）', () => {
  const p = buildThinkingParams({ effort: 'high', dialect: 'openai-o', budget: 0 }).params;
  assert.strictEqual(p.reasoning_effort, 'high');
  assert.strictEqual('thinking' in p, false);
});

ok('anthropic 方言仍用 thinking.type（本次没动它）', () => {
  const p = buildThinkingParams({ effort: 'high', dialect: 'anthropic', budget: 0 }).params;
  assert.deepStrictEqual(p.thinking, { type: 'enabled' });
  // 本次只改 deepseek/glm，anthropic 的 effort 仍走 output_config（若支持）
});

ok('generic 方言不发任何思考参数（宁缺勿错）', () => {
  const r = buildThinkingParams({ effort: 'high', dialect: 'generic', budget: 0 });
  assert.deepStrictEqual(r.params, {});
  assert.strictEqual(r.applied, false);
});

console.log(`\n思考参数测试：${passed} 通过${process.exitCode ? '，有失败' : ''}\n`);

console.log('\n【6】方言手动覆盖（2026-10-04：中转站静默失效的修复）');

ok('中转站 + deepseek 系：模型名兜底规则已补上（此前落 generic）', () => {
  // 回归：deepseek 曾只有域名规则、没有 host:null 的模型名规则，
  // 导致走任何中转站都判成 generic → 档位静默失效、参数一个都不发。
  for (const m of ['deepseek-v4-pro', 'deepseek-flash', 'deepseek/deepseek-v4-pro']) {
    const d = detectDialect({ baseUrl: 'https://market.example.com/v1', model: m });
    assert.strictEqual(d.dialect, 'deepseek', `中转站 + ${m} 应判成 deepseek`);
  }
});

ok('官方域名仍走域名规则（补兜底没有破坏原有判定）', () => {
  const d = detectDialect({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
  assert.strictEqual(d.dialect, 'deepseek');
  assert.match(d.reason, /域名/, '应仍由域名命中，而不是模型名');
});

ok('openai-o 覆盖到 gpt-6 及以后（此前只到 gpt-5，gpt-6 落 generic）', () => {
  // 回归（2026-10-04）：用户切到 gpt-6-sol 走中转站时判成 generic → 思考参数一个都不发。
  // 旧规则 /^(o[1-9](-|$)|gpt-5)/ 只认到 gpt-5。
  for (const m of ['gpt-6-sol', 'gpt-6', 'gpt-7-turbo', 'gpt-10-x']) {
    const d = detectDialect({ baseUrl: 'https://market.frostfox.ai/v1', model: m });
    assert.strictEqual(d.dialect, 'openai-o', `中转站 + ${m} 应判成 openai-o`);
  }
});

ok('放宽到 gpt-6 没有误伤 gpt-4 这类非推理模型', () => {
  // 若写成 gpt-\\d 会把 gpt-4 也吞进来 → 给它发 reasoning_effort 会被 400
  for (const m of ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo']) {
    const d = detectDialect({ baseUrl: 'https://market.frostfox.ai/v1', model: m });
    assert.strictEqual(d.dialect, 'generic', `${m} 不该被认成 openai-o`);
  }
});

ok('手动指定优先于自动判定', () => {
  // 场景：中转站把模型名改成了判断不出来的样子，只能靠手动
  const d = detectDialect({
    baseUrl: 'https://market.example.com/v1',
    model: 'my-private-model-x',
    manual: 'deepseek'
  });
  assert.strictEqual(d.dialect, 'deepseek');
  assert.strictEqual(d.manual, true);
  assert.match(d.reason, /手动/);
});

ok('手动指定的 supports 与 buildThinkingParams 用的是同一张表', () => {
  // 两处若各写一份表，迟早漂移 → 手动选了某个方言却构造不出对应参数
  const d = detectDialect({ baseUrl: 'https://x.com', model: 'y', manual: 'anthropic' });
  const b = buildThinkingParams({ effort: 'high', dialect: d.dialect, budget: 0 });
  assert.deepStrictEqual(b.params, { thinking: { type: 'enabled' } }, 'anthropic 应只发 thinking.type');
});

ok('非法手动值不静默吞掉：回退 generic 并在 reason 里说明', () => {
  const d = detectDialect({ baseUrl: 'https://x.com', model: 'y', manual: '瞎写的' });
  assert.strictEqual(d.dialect, 'generic', '未知方言必须回退 generic（宁缺勿错）');
  assert.match(d.reason, /不是已知方言/, 'reason 要能解释为什么没生效');
});

ok('SELECTABLE_DIALECTS 里的每一项都能被手动指定接受', () => {
  for (const d of SELECTABLE_DIALECTS) {
    const r = detectDialect({ baseUrl: 'https://x.com', model: 'y', manual: d });
    assert.strictEqual(r.dialect, d, `手动指定 ${d} 却判成了 ${r.dialect}`);
  }
});

ok('api.thinkingDialect 透传：resolveThinkingRequest 读到手动值', () => {
  const api = {
    baseUrl: 'https://market.example.com/v1', model: 'weird-name',
    thinkingMode: 'on', thinkingEffort: 'max', thinkingDialect: 'deepseek'
  };
  const r = resolveThinkingRequest(api, {});
  assert.strictEqual(r.manual, true);
  assert.strictEqual(r.dialect, 'deepseek');
  const b = buildThinkingParams({ effort: r.effort, dialect: r.dialect, budget: r.budget });
  assert.deepStrictEqual(b.params, { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
});

ok('档位=default 时无论方言如何都不发参数（default 语义不被手动指定破坏）', () => {
  for (const manual of ['', 'deepseek', 'anthropic']) {
    const api = { baseUrl: 'https://x.com', model: 'y', thinkingMode: 'auto', thinkingEffort: '', thinkingDialect: manual };
    const r = resolveThinkingRequest(api, {});
    const b = buildThinkingParams({ effort: r.effort, dialect: r.dialect, budget: r.budget });
    assert.deepStrictEqual(b.params, {}, `手动=${manual || '无'} 时 default 档不该发参数`);
  }
});

console.log(`\n补充断言完成\n`);

// ── 【7】思考方言按供应商绑定（2026-10-04）──────────────────────────────
// 背景：方言原是全局单值（开发者菜单），切供应商时必须跑回去改，且会错配。
// 现在存 providers[].thinkingDialect，api.thinkingDialect 降级为
// "新供应商的预选值 + 未显式设置时的兜底"。
// ⚠️ 传 cfg 显式参数就不碰 getConfig()，本用例保持纯离线。
console.log('【7】思考方言按供应商绑定');

ok('供应商自己的方言优先于默认值', () => {
  const cfg = {
    api: { provider: 'p1', thinkingDialect: 'qwen' },
    providers: [{ id: 'p0', thinkingDialect: 'glm' }, { id: 'p1', thinkingDialect: 'deepseek' }]
  };
  assert.strictEqual(effectiveThinkingDialect(cfg), 'deepseek', '应取 p1 自己的值，而不是默认或别的供应商的');
});

ok('供应商没设方言 → 空串（自动判定）；**没有全局默认值兜底**', () => {
  // 2026-10-04：全局默认值那一层被去掉了（用户反馈"设为默认值不生效、还容易误导"）。
  // api.thinkingDialect 现在完全不参与解析，留着只是历史字段。
  const cfg = { api: { provider: 'p1', thinkingDialect: 'glm' }, providers: [{ id: 'p1' }] };
  assert.strictEqual(effectiveThinkingDialect(cfg), '', 'api.thinkingDialect 不该再生效');
});

ok('未选中 / 选中不存在的供应商 → 空串（不报错）', () => {
  const none = { api: { provider: '', thinkingDialect: 'xai' }, providers: [{ id: 'p1', thinkingDialect: 'deepseek' }] };
  assert.strictEqual(effectiveThinkingDialect(none), '');
  const missing = { api: { provider: 'not-exist' }, providers: [] };
  assert.strictEqual(effectiveThinkingDialect(missing), '');
});

console.log('');

