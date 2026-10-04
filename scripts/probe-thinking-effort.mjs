// DeepSeek thinking / effort 参数行为探测（v2，一次性诊断脚本，2026-10-04）
//
// 目的：定死 Q4 的修法 —— `reasoning_effort` 能不能独立于 `thinking.type` 生效。
// 背景见 doc/todo-2026-10-04.md。跑完把输出贴回给 AI 即可，不用改代码。
//
// ── v2 相对 v1 的修正（v1 结论被自己的数据推翻了）──
//  1. **探针选错**：v1 只测 rc_tok(reasoning_tokens)。但 thinking 关掉后它天生为 0，
//     看不见 effort 对正文的作用 → v2 补上 completion / 正文字数两个探针。
//     （v1 靠这一列缺失漏判了"effort 其实独立于开关"）
//  2. **单次采样**：v1 每组只跑一次且题目太简单（rc_tok 仅 50~113），
//     噪声压过信号，出现 low(64) > 无(50)、max(89) < high(113) 的反常
//     → v2 换更难的题 + 每组重复 3 次取中位数。
//
// ── 判据也一并收紧 ──
//  不再"两个数不等就算有效"，而是要求**中位数严格单调**才认账。
//
// 用法：
//   1. 填下面 FILL_ME（或设环境变量 DEEPSEEK_API_KEY）
//   2. node scripts/probe-thinking-effort.mjs
//
// ⚠️ 约 27 次 API 调用（约 9 组 × 3 次），费用几毛，单次运行 1~2 分钟。
// ⚠️ 若不想把 key 写进文件：把 FILL_ME 留空，改用环境变量
//    DEEPSEEK_API_KEY='sk-xxx' node scripts/probe-thinking-effort.mjs
// ⚠️ 脚本只发请求，不修改任何项目数据。

import fs from 'node:fs';

const FILL_ME = ''; // ← 在这里填 API Key（等号后面写内容，别删这对引号）
//   例如：const FILL_ME = 'sk-abc123...';
//   留空则读环境变量：DEEPSEEK_API_KEY='sk-xxx' node scripts/probe-thinking-effort.mjs
//   ⚠️ 填完记得 Ctrl+S 保存再运行。
const REPEAT = 3;    // 每组重复次数（取中位数，抵消单次波动）

// ── 凭据：优先脚本内填写，其次环境变量 ──
function resolveKey() {
  const key = (FILL_ME || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!key) {
    console.error('');
    console.error('❌ 没找到 API Key —— 无法继续。');
    console.error('');
    console.error('   两种填法（任选一种）：');
    console.error('   1) 编辑本文件第 28 行，把引号里填上 key：');
    console.error("        const FILL_ME = 'sk-你的key';    然后 Ctrl+S 保存");
    console.error('   2) 不改文件，用环境变量运行：');
    console.error("        DEEPSEEK_API_KEY='sk-你的key' node scripts/probe-thinking-effort.mjs");
    console.error('');
    console.error(`   当前状态：FILL_ME=${FILL_ME ? '已填写' : '空'}  DEEPSEEK_API_KEY=${process.env.DEEPSEEK_API_KEY ? '已设置' : '未设置'}`);
    console.error('');
    process.exit(1);
  }
  return key;
}

// ── 尽量复用项目自己的配置与价格表，避免脚本和实际配置脱节 ──
let CFG = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
try {
  const raw = JSON.parse(fs.readFileSync(new URL('../data/config.json', import.meta.url), 'utf8'));
  if (raw?.api?.baseUrl) CFG.baseUrl = raw.api.baseUrl;
  if (raw?.api?.model) CFG.model = raw.api.model;
} catch { /* 用默认值 */ }

const KEY = resolveKey();
const BASE = String(CFG.baseUrl).replace(/\/+$/, '');
const MODEL = CFG.model;

// ── 更难的题：多步推理 + 约束满足 + 自我检查，rc_tok 预计 800~3000 ──
// v1 的题太简单（rc_tok 仅 50~113），噪声压过信号。这次要让信号足够大。
const PROMPT = [
  '有 5 个人 A、B、C、D、E 排成一队。',
  '约束：(1) C 不在两端；(2) A 紧邻 B；(3) D 在 B 的左边（不要求相邻）；',
  '(4) E 不与 A、B 相邻。',
  '请找出所有满足条件的排列，并说明推理过程。',
  '最后请检查一遍答案是否遗漏了任何情况。'
].join('');

async function once(extraBody) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: PROMPT }],
    max_tokens: 8192,
    stream: false,
    ...extraBody
  };

  let res, text;
  // ⚠️ 必须带超时：难题 + max_tokens 8192，单次可能几十秒。
  //    没有 AbortSignal 的话，fetch 挂住就会**永久卡死**（v2 实测症状）——
  //    症状是"脚本不动、后台无调用、也不报错"。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  const t1 = Date.now();
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    text = await res.text();
  } catch (e) {
    const secs = Math.round((Date.now() - t1) / 1000);
    return { err: e.name === 'AbortError' ? `超时 120s 未返回` : `网络错误 ${e.message}（${secs}s）` };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 错误体可能很长，只取前 200 字，并过滤掉可能回显的 key
    return { err: `HTTP ${res.status} ${text.slice(0, 200).replaceAll(KEY, '***')}` };
  }

  let json;
  try { json = JSON.parse(text); } catch { return { err: '响应非 JSON' }; }

  const msg = json?.choices?.[0]?.message ?? {};
  const u = json?.usage ?? {};
  const rc = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  return {
    rcTok: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    completion: u?.completion_tokens ?? 0,
    rcChars: rc.length,
    contentChars: typeof msg.content === 'string' ? msg.content.length : 0
  };
}

/** 中位数 —— 比平均值更抗单次离群值干扰。 */
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GROUPS = [
  // ── off 组（v1 漏判的正是这里）──
  { key: 'off_none', label: '② off（无 effort）', body: { thinking: { type: 'disabled' } } },
  { key: 'off_low',  label: '③ off + low',  body: { thinking: { type: 'disabled' }, reasoning_effort: 'low' } },
  { key: 'off_high', label: '④ off + high', body: { thinking: { type: 'disabled' }, reasoning_effort: 'high' } },
  { key: 'off_max',  label: '④b off + max',  body: { thinking: { type: 'disabled' }, reasoning_effort: 'max' } },

  // ── on 组 ──
  { key: 'on_none',  label: '⑧ on（无 effort）', body: { thinking: { type: 'enabled' } } },
  { key: 'on_low',   label: '⑤ on + low',   body: { thinking: { type: 'enabled' }, reasoning_effort: 'low' } },
  { key: 'on_med',   label: '⑤b on + medium', body: { thinking: { type: 'enabled' }, reasoning_effort: 'medium' } },
  { key: 'on_high',  label: '⑥ on + high',  body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } },
  { key: 'on_max',   label: '⑦ on + max',   body: { thinking: { type: 'enabled' }, reasoning_effort: 'max' } }
];

console.log('═'.repeat(88));
console.log('DeepSeek thinking / effort 行为探测 v2');
console.log(`端点: ${BASE}    模型: ${MODEL}    每组重复 ${REPEAT} 次取中位数`);
console.log('═'.repeat(88));

const agg = {};
const errs = [];
const t0 = Date.now();

for (const [gi, g] of GROUPS.entries()) {
  const runs = [];
  // 实时进度：每次调用都打一行，避免"看起来卡住"（v2 的教训：无输出的等待最让人焦虑）
  process.stdout.write(`[${gi + 1}/${GROUPS.length}] ${g.label.padEnd(20)} `);
  for (let i = 0; i < REPEAT; i++) {
    const r = await once(g.body);
    if (r.err) {
      if (errs.length < 3) errs.push(`${g.label}: ${r.err}`);
      runs.push(null);
      process.stdout.write(`✗${i + 1} `);
    } else {
      runs.push(r);
      process.stdout.write(`${r.rcTok}/${r.completion} `);
    }
    if (i < REPEAT - 1) await sleep(800);
  }
  const ok = runs.filter(Boolean);
  if (ok.length) {
    agg[g.key] = {
      label: g.label,
      rcTok: median(ok.map((r) => r.rcTok)),
      completion: median(ok.map((r) => r.completion)),
      contentChars: median(ok.map((r) => r.contentChars)),
      n: ok.length
    };
  }
  process.stdout.write(`  ← 中位数 rc=${agg[g.key]?.rcTok ?? 'N/A'} comp=${agg[g.key]?.completion ?? 'N/A'}  [${Math.round((Date.now() - t0) / 1000)}s]\n`);
  await sleep(800);
}

if (errs.length) {
  console.log(`\n⚠️ 部分请求失败（最多显示 3 条）：\n   ${errs.join('\n   ')}`);
  console.log('   下面结论基于不完整数据，仅供参考。\n');
}

console.log('组'.padEnd(22) + 'rc_tok'.padStart(8) + 'completion'.padStart(12) + '正文'.padStart(9) + '   样本');
console.log('─'.repeat(88));
for (const g of GROUPS) {
  const a = agg[g.key];
  if (!a) { console.log(g.label.padEnd(20) + '   （全部失败）'); continue; }
  console.log(
    a.label.padEnd(22) +
    String(a.rcTok).padStart(8) +
    String(a.completion).padStart(12) +
    String(a.contentChars).padStart(9) +
    `     ${a.n}/${REPEAT}`
  );
}

// ── 判据（比 v1 严格：要求中位数单调，不再"两个数不等就算有效"）──
console.log('\n' + '═'.repeat(88));
console.log('结论判读');
console.log('═'.repeat(88));

const A = (k) => agg[k] ?? null;

const offNone = A('off_none'), onNone = A('on_none');
if (offNone && onNone) {
  console.log(`\n【A】thinking 开关有效？`);
  console.log(`    off → rc_tok=${offNone.rcTok}   on → rc_tok=${onNone.rcTok}`);
  console.log(offNone.rcTok === 0 && onNone.rcTok > 0
    ? '    → ✅ 开关有效（关掉归零、开启有思考）'
    : '    → ⚠️ 不符合预期，检查模型/渠道是否支持 thinking');
}

const bLow = A('off_low'), bHigh = A('off_high'), bMax = A('off_max');
if (offNone && bLow && bHigh) {
  console.log(`\n【B】thinking 关掉后，effort 还生效吗？（关键 —— 看 completion 与正文，不看 rc_tok）`);
  console.log(`    off 无 effort : completion=${offNone.completion}  正文=${offNone.contentChars}字`);
  console.log(`    off + low     : completion=${bLow.completion}  正文=${bLow.contentChars}字`);
  console.log(`    off + high    : completion=${bHigh.completion}  正文=${bHigh.contentChars}字`);
  if (bMax) console.log(`    off + max     : completion=${bMax.completion}  正文=${bMax.contentChars}字`);
  const mono = bHigh.completion > bLow.completion;
  const differs = bHigh.completion !== offNone.completion;
  console.log(`    high(=${bHigh.completion}) > low(=${bLow.completion}) ? ${mono ? '是' : '否'}`);
  console.log(`    high 与无 effort(=${offNone.completion}) 有差异 ? ${differs ? '是' : '否'}`);
  console.log(
    mono && differs
      ? '    → ✅ effort 独立于开关（与 Claude Code 观察一致）\n       → 修法：effort 提到 if(on) 外面，off 档也发'
      : '    → ❌ 未观测到独立效应\n       → 修法：effort 留在 if(on) 内'
  );
}

const cLow = A('on_low'), cMed = A('on_med'), cHigh = A('on_high'), cMax = A('on_max');
if (onNone && cLow && cHigh) {
  console.log(`\n【C】开启时 effort 的强度阶梯（rc_tok 与 completion 两个指标都看）`);
  const chain = [['无', onNone], ['low', cLow], ['medium', cMed], ['high', cHigh], ['max', cMax]].filter((x) => x[1]);
  for (const [n, a] of chain) {
    console.log(`    ${n.padEnd(7)} rc_tok=${String(a.rcTok).padStart(6)}   completion=${String(a.completion).padStart(6)}   正文=${a.contentChars}字`);
  }
  const rcMono = cHigh.rcTok >= cLow.rcTok && (!cMax || cMax.rcTok >= cHigh.rcTok);
  const cpMono = cHigh.completion >= cLow.completion && (!cMax || cMax.completion >= cHigh.completion);
  console.log(`    rc_tok 单调（low ≤ high ≤ max）? ${rcMono ? '是' : '否'}`);
  console.log(`    completion 单调（low ≤ high ≤ max）? ${cpMono ? '是' : '否'}`);
  console.log(rcMono && cpMono
    ? '    → ✅ 强度阶梯成立，档位可直接映射'
    : '    → ❌ 仍不单调：可能不按档位控思考量，或该模型不区分档位\n       → 修法只做"结构并列"，档位映射另议');
}

console.log('\n把上面整段贴回给 AI 即可。');

