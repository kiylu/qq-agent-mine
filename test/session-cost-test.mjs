// 会话成本单元测试：src/sessions.js · costOfSession()
//
// 为什么单测这个：会话卡片上的「本次消费」金额直接来自这里，而
// 金额口径一旦错（少算缓存、漏算高峰档、把兜底价当官方价）用户看到的就是
// 假数字，且没有任何报错会提示 —— 只能靠断言钉住。
//
// 不碰真实 data/：用 setRuntimeConfig 在内存里注入配置，全程不落盘。
import { setRuntimeConfig } from '../src/config.js';
import { SessionRegistry, costOfSession } from '../src/sessions.js';

let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

// 注入配置：开官方价（走内置表），并给 deepseek-v4-flash 指定一个可预期的价
function cfg(official, modelPrices) {
  setRuntimeConfig({
    api: { useOfficialPrice: official, modelPrices: modelPrices || {} }
  });
}

console.log('=== costOfSession ===\n');

// ── 无 token / 无模型 → null（UI 显示占位符而不是 ¥0）──
cfg(false, {});
check('无 usage → null', costOfSession({ usage: null, model: 'x' }) === null);
check('0 token → null', costOfSession({ usage: { promptTokens: 0, completionTokens: 0 }, model: 'x' }) === null);
check('缺 usage 字段 → null', costOfSession({ model: 'x' }) === null);

// ── 自定义价：in=10 / out=30 / cached=1（每百万 token）──
cfg(false, { 'm-custom': { in: 10, out: 30, cached: 1 } });
// 输入 1e6，其中命中 4e5 → 未命中 6e5；输出 2e5
// cost = 0.6*10 + 0.4*1 + 0.2*30 = 6 + 0.4 + 6 = 12.4
{
  const r = costOfSession({
    usage: { promptTokens: 1_000_000, cachedTokens: 400_000, completionTokens: 200_000 },
    model: 'm-custom'
  });
  check('自定义价：成本折算正确', r && near(r.cost, 12.4), JSON.stringify(r));
  check('自定义价：source=custom', r && r.source === 'custom', String(r && r.source));
  check('自定义价：命中单价', r && r.matched === true, String(r && r.matched));
  check('自定义价：无峰谷档 hasPeakTiers=false', r && r.hasPeakTiers === false);
}

// ── 缓存命中封顶：cachedTokens > promptTokens 时不得出现负的未命中量 ──
{
  const r = costOfSession({
    usage: { promptTokens: 100_000, cachedTokens: 999_999, completionTokens: 0 },
    model: 'm-custom'
  });
  // fresh 应为 0；cached 被 min() 夹到 1e5 → 0.1*1 = 0.1
  check('缓存命中封顶（不产生负输入）', r && near(r.cost, 0.1), JSON.stringify(r));
}

// ── 官方价：deepseek-v4-flash 闲时 in=1/out=4/cached=0.02（见价格表）──
cfg(true, {});
{
  // 用「凌晨 3 点」这个明确的非高峰时刻，避开当前时间影响
  const atOffPeak = new Date(2026, 0, 5, 3, 0, 0).getTime(); // 周一 03:00
  const r = costOfSession({
    usage: { promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 },
    model: 'deepseek-v4-flash',
    at: atOffPeak
  });
  check('官方价命中（source=official）', r && r.source === 'official', String(r && r.source));
  check('官方价：有峰谷档 hasPeakTiers=true', r && r.hasPeakTiers === true);
  check('官方价闲时：peak=false', r && r.peak === false, JSON.stringify(r));
  check('官方价闲时：1M 输入 = 1 元', r && near(r.cost, 1), JSON.stringify(r));
}

// ── 高峰档：同模型在高峰时刻价格翻倍 ──
{
  const atPeak = new Date(2026, 0, 5, 14, 0, 0).getTime(); // 周一 14:00（高峰）
  const r = costOfSession({
    usage: { promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 },
    model: 'deepseek-v4-flash',
    at: atPeak
  });
  check('高峰档 peak=true', r && r.peak === true, JSON.stringify(r));
  check('高峰档输入翻倍（2 元）', r && near(r.cost, 2), JSON.stringify(r));
}

// ── 兜底价：关官方表 + 设全局价 → source=manual ──
setRuntimeConfig({
  api: { useOfficialPrice: false, priceInputPerM: 5, priceOutputPerM: 20, priceCachedPerM: 1, modelPrices: {} }
});
{
  const r = costOfSession({
    usage: { promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 },
    model: 'unknown-model'
  });
  check('兜底价 source=manual', r && r.source === 'manual', String(r && r.source));
  check('兜底价：1M 输入 = 5 元', r && near(r.cost, 5), JSON.stringify(r));
}

// ── 完全无价可匹配：单价 0，成本 0（不瞎估）──
cfg(false, {});
{
  const r = costOfSession({
    usage: { promptTokens: 1_000_000, completionTokens: 0 },
    model: 'no-price-anywhere'
  });
  check('无单价：source=none', r && r.source === 'none', String(r && r.source));
  check('无单价：成本 0', r && near(r.cost, 0), JSON.stringify(r));
}

// ── 渠道价优先：可为「渠道：模型」单独定价（分隔符是全角冒号，见 modelLabel）──
setRuntimeConfig({
  api: {
    useOfficialPrice: false,
    modelPrices: {
      'openai：gpt-x': { in: 100, out: 200, cached: 10 },
      'gpt-x': { in: 1, out: 2, cached: 0.1 }
    }
  }
});
{
  const r = costOfSession({
    usage: { promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 },
    model: 'gpt-x',
    vendor: 'openai'
  });
  check('渠道价优先（命中 渠道:模型 的 100）', r && near(r.cost, 100), JSON.stringify(r));
}

// ── 渠道无自定义价时退回裸模型 id ──
setRuntimeConfig({
  api: {
    useOfficialPrice: false,
    modelPrices: { 'gpt-y': { in: 7, out: 8, cached: 0.7 } }
  }
});
{
  const r = costOfSession({
    usage: { promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 },
    model: 'gpt-y',
    vendor: 'somechannel'
  });
  check('渠道无价 → 退回裸模型自定义价', r && near(r.cost, 7), JSON.stringify(r));
}

// ── withCost：详情接口补成本（列表/详情口径必须一致）──
// 背景：列表走 #summary（有 cost），详情走 get(id) 直读磁盘原始文件（**没有** cost，
// 因为成本不落盘 —— 价格表会变）。若不补，详情页「本次消费」永远空白。
console.log('\n=== withCost（详情补成本）===');
{
  cfg(false, { 'm-x': { in: 2, out: 6, cached: 0.2 } });
  const reg = new SessionRegistry(0);
  const raw = {
    id: 's1',
    usage: { promptTokens: 1_000_000, cachedTokens: 250_000, completionTokens: 100_000 },
    model: 'm-x',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    messages: [{ role: 'user', content: 'hi' }]
  };
  const out = reg.withCost(raw);
  // fresh=0.75M*2=1.5, cached=0.25M*0.2=0.05, out=0.1M*6=0.6 → 2.15
  check('withCost：成本算对', out.cost != null && near(out.cost, 2.15), JSON.stringify(out.cost));
  check('withCost：带 costMeta.source=custom', out.costMeta?.source === 'custom', JSON.stringify(out.costMeta));
  check('withCost：带 hasPeakTiers 字段', out.costMeta?.hasPeakTiers === false, JSON.stringify(out.costMeta));
  check('withCost：不改动原对象（不污染 current 里的活会话）', raw.cost === undefined);
  check('withCost：保留原有字段 messages', Array.isArray(out.messages) && out.messages.length === 1);

  // 没有 token 的会话：cost 必须是 null（UI 显占位符），不是 0
  const empty = reg.withCost({ id: 's2', usage: null, model: 'm-x' });
  check('withCost：无 token → cost=null', empty.cost === null, JSON.stringify(empty.cost));
  check('withCost：无 token → costMeta=null', empty.costMeta === null);

  // 入参不是对象时原样返回，不炸
  check('withCost：null 入参安全', reg.withCost(null) === null);
  check('withCost：undefined 入参安全', reg.withCost(undefined) === undefined);
}

// ─────────────────────────────────────────────────────────────────────────
// 端到端接口校验在**独立文件** test/session-cost-e2e.mjs，不在本文件里做。
// 原因：src/config.js 在模块顶层就固化 DATA_DIR，而本文件顶部已静态 import
// 了它 —— 同一进程内再设 QQ_AGENT_DATA_DIR 已经来不及，e2e 会去读**用户真实
// 的 data/**。独立进程才能保证环境变量在 import 之前生效。
// ─────────────────────────────────────────────────────────────────────────

console.log(`\n=== ${fail ? 'FAILED' : 'ALL PASSED'} — pass=${pass} fail=${fail} ===`);
process.exit(fail ? 1 : 0);