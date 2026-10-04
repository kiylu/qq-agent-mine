// 思考/推理参数的内置实现（原 thinking-adapters 插件收编进核心）。
//
// 职责与插件时期完全一致，只是不再依赖 skillManager 能力缝：
//   1. 方言检测（同一件事各家的参数名完全不同，发错会被网关 400 拒绝）
//   2. 按用户的思考档位构造要合并进请求体的参数
//   3. 从响应里提取思考内容与思考 token
//   4. 网关拒绝思考参数时给出"摘掉这些字段重发一次"的降级建议
//
// ⚠️ 重试动作仍然由 llm.js 执行（超时预算 / abort / 重试上限 / 计费都在那），
//    这里只返回建议，绝不自己发请求。
//
// 档位口径（用户设置 api.thinkingEffort）：
//   off / low / medium / high / xhigh / max —— off 是"能思考的模型也明确关闭"，
//   其余档位含义上都是"开"：强度递增，渠道只支持低档时向下就近映射。

/** 本地/自建端点：不发花哨参数，避免把自建网关打挂。 */
const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/i;

/**
 * 规则表：从上往下第一个命中的决定方言。
 *   host 命中条件（域名正则，null = 只看模型名）；model 模型正则
 *   dialect 方言名；supports 该方言能表达哪些控制（off/on/effort/budget）
 * 识别必须两轮匹配（先域名、后模型名）落实"域名优先"：
 *   规则表里 host:null 的模型名规则（claude / gemini / qwen）排在具体网关
 *   规则（openrouter）之前，单轮"第一个命中"会把 openrouter.ai 上的
 *   anthropic/claude-3.5-sonnet 判成 anthropic 直连 → 发 thinking:{} 而不是
 *   OpenRouter 的 reasoning:{} → 网关 400，思考模式失效还多打一次降级请求。
 */
const MODEL_RULES = [
  // 本地端点优先（域名命中就不管模型名了）
  { dialect: 'ollama', host: LOCAL_HOSTS, model: null, supports: ['off', 'on'] },
  { dialect: 'local-openai', host: LOCAL_HOSTS, model: null, supports: [] },

  { dialect: 'deepseek', host: /deepseek\.com$/i, model: /deepseek.*(reasoner|thinking|v4|v3\.\d)/i, supports: ['off', 'on'] },
  { dialect: 'deepseek', host: /deepseek\.com$/i, model: /deepseek/i, supports: ['off', 'on'] },
  { dialect: 'qwen', host: /(dashscope|aliyuncs)\.com$/i, model: /qwen/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'qwen', host: null, model: /^(qwen|qwq)/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'glm', host: /bigmodel\.cn$/i, model: /glm/i, supports: ['off', 'on'] },
  { dialect: 'glm', host: null, model: /glm-(z|4|5)/i, supports: ['off', 'on'] },
  { dialect: 'openai-o', host: /openai\.com$/i, model: /^(o[1-9]|gpt-5)/i, supports: ['effort'] },
  { dialect: 'openai-o', host: null, model: /^(o[1-9](-|$)|gpt-5)/i, supports: ['effort'] },
  { dialect: 'anthropic', host: /(anthropic|claude)\./i, model: /claude/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'anthropic', host: null, model: /claude/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'gemini', host: /(googleapis|generativelanguage)\./i, model: /gemini/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'gemini', host: null, model: /gemini/i, supports: ['off', 'on', 'budget'] },
  { dialect: 'openrouter', host: /openrouter\.ai$/i, model: /./, supports: ['effort', 'budget'] },
  { dialect: 'xai', host: /x\.ai$/i, model: /grok/i, supports: ['effort'] },
  // 中转站常见：模型名带 deepseek/qwen 前缀但域名是自己的 —— 上面 host:null 的规则已覆盖
  //
  // ⚠️ deepseek 曾**只有域名规则、没有模型名兜底**（其他方言都有），
  //    于是走任何中转站（域名不匹配）时都落到下面的 generic → 档位静默失效。
  //    实测：market.frostfox.ai + deepseek-v4-pro → generic → 一个思考参数都不发，
  //    而同渠道 claude-opus-4-6 → anthropic 正常。这是唯一的不对称点，已补上。
  { dialect: 'deepseek', host: null, model: /deepseek/i, supports: ['off', 'on'] },
  { dialect: 'generic', host: null, model: /./, supports: [] }
];

/** 用户可在 UI 手动指定的方言（对应 MODEL_RULES 里的 dialect 值）。
 *  空串 = 全自动（按域名/模型名判定）。
 *  'generic' 也在列表里：明知不支持还要显式发时才选它。 */
export const SELECTABLE_DIALECTS = [
  'deepseek', 'anthropic', 'qwen', 'glm', 'openai-o',
  'gemini', 'openrouter', 'xai', 'generic'
];

/** 各方言的可读名称（UI 展示）。 */
export const DIALECT_LABELS = {
  deepseek: 'DeepSeek 思考',
  qwen: '通义千问思考',
  glm: '智谱 GLM 思考',
  'openai-o': 'OpenAI 推理强度',
  anthropic: 'Claude 思考预算',
  gemini: 'Gemini 思考',
  openrouter: 'OpenRouter reasoning',
  xai: 'xAI 推理强度',
  ollama: 'Ollama 本地',
  'local-openai': '自建 OpenAI 兼容端点',
  generic: '通用（不发送思考参数）'
};

/** 用户可选的思考档位（off = 明确关闭，其余 = 开启且强度递增）。 */
export const THINKING_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** OpenAI 系 reasoning_effort 的合法取值（xhigh/max 会被就近映射到 high）。 */
const OPENAI_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/**
 * DeepSeek / GLM 系 reasoning_effort 的**合法取值**。
 *
 * 官方文档只承认 low / high / max 三个值，所以本项目的六档要落到这三个上。
 * 映射依据是官方档位表（minimal→low、medium→high、xhigh→high、max→max），
 * **不是**"档位越大思考越长"—— 见下方 buildThinkingParams 里的实测警告。
 */
const DEEPSEEK_EFFORTS = {
  low: 'low',
  medium: 'high',   // 官方映射：medium → high
  high: 'high',
  xhigh: 'high',    // 本项目的"超高"落到 high（DeepSeek 无此档）
  max: 'max'
};

export function hostOf(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    // 不带协议的写法（127.0.0.1:1234/v1）也尽量解析
    try { return new URL(`http://${raw}`).hostname.toLowerCase(); } catch { return ''; }
  }
}

export function isLocalEndpoint(baseUrl) {
  const host = hostOf(baseUrl);
  return Boolean(host) && LOCAL_HOSTS.test(host);
}

/**
 * 识别方言。返回 { dialect, label, supports, reason, manual }。
 *
 * 判定优先级：
 *   ① **手动指定**（`manual`）—— 用户在设置里显式选的，最高优先级。
 *      存在的理由：自动判定本质是**猜**域名/模型名，而中转站会把两者都改掉
 *      （域名是自家、模型名是 `deepseek/deepseek-v4-pro` 这种带前缀的形式），
 *      猜不中就落 generic → 档位静默失效、用户以为调了其实没调。
 *      对这类渠道，**只有用户知道该用哪个方言**。
 *   ② 域名匹配
 *   ③ 模型名匹配
 *   ④ 都不中 → generic（宁缺勿错，一个参数都不发）
 *
 * @param {string} [opts.manual] 手动方言；空/非法值 = 走自动判定
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.model]
 */
export function detectDialect({ baseUrl = '', model = '', manual = '' } = {}) {
  const host = hostOf(baseUrl) || String(baseUrl || '').toLowerCase();
  const id = String(model || '');
  const match = (rule) => {
    if (rule.host && !rule.host.test(host)) return false;
    if (rule.model && !rule.model.test(id)) return false;
    return true;
  };

  // ① 手动指定优先。supports 从 MODEL_RULES 里**该方言的第一条规则**取，
  //    保证与 buildThinkingParams 用的是同一张表（两处若各写一份，迟早漂移）。
  //    ⚠️ 不能只找 host:null 的规则 —— openrouter / xai / ollama / local-openai
  //    都**只有域名规则**（它们本身就是靠域名识别的，本就不该按模型名匹配），
  //    限定 !r.host 会让这些方言"手动指定了却判成 generic"。
  const wanted = String(manual || '').trim();
  if (wanted) {
    const rule = MODEL_RULES.find((r) => r.dialect === wanted);
    if (rule) {
      return {
        dialect: rule.dialect,
        label: DIALECT_LABELS[rule.dialect] || rule.dialect,
        supports: [...rule.supports],
        manual: true,
        reason: `手动指定为 ${rule.dialect}`
      };
    }
    // 非法值不静默吞掉 —— 落 generic 并在 reason 里说明，便于 UI 提示"没生效"
    return {
      dialect: 'generic',
      label: DIALECT_LABELS.generic,
      supports: [],
      manual: true,
      reason: `手动指定「${wanted}」不是已知方言，已回退为通用（不发送思考参数）`
    };
  }

  const hit = MODEL_RULES.find((r) => r.host && match(r))     // ② 域名优先
    ?? MODEL_RULES.find((r) => !r.host && match(r));          // ③ 再看模型名
  if (hit) {
    return {
      dialect: hit.dialect,
      label: DIALECT_LABELS[hit.dialect] || hit.dialect,
      supports: [...hit.supports],
      manual: false,
      reason: `${hit.host ? `域名 ${host}` : '模型名'} 命中规则 ${hit.dialect}`
    };
  }
  return {
    dialect: 'generic',
    label: DIALECT_LABELS.generic,
    supports: [],
    manual: false,
    reason: '未命中任何方言规则（可在设置里手动指定）'
  };
}

/** 明确列出会往请求体里加的键（降级重试时要把它们摘掉）。 */
export const THINKING_BODY_KEYS = ['thinking', 'enable_thinking', 'thinking_budget', 'reasoning_effort', 'reasoning', 'think', 'extra_body'];

/** 从请求体里摘掉思考相关字段（降级重试用）。 */
export function stripThinkingParams(body = {}) {
  const out = { ...body };
  for (const k of THINKING_BODY_KEYS) delete out[k];
  return out;
}

/** 档位归一：非法/空值回落 ''（= 跟随模型默认）。 */
function normalizeEffort(effort) {
  const e = String(effort ?? '').trim().toLowerCase();
  return THINKING_EFFORTS.includes(e) ? e : '';
}

/**
 * 求解本次请求生效的思考配置。
 * 输入是 config 的 api 段（thinkingMode/thinkingEffort/thinkingBudget）+
 * 渠道信息（baseUrl/model）。返回 { effort, on, dialect, ... }：
 *   effort  归一后的档位（'' 表示用户没设 → 跟随默认）
 *   on      是否处于"明确开启"状态（effort 非空且非 off）
 *
 * 兼容历史口径：旧配置只有 thinkingMode: off/auto/on 三态（effort 为空时，
 * mode=on 映射为"开、不指定强度"，mode=off 映射为 off 档）。
 */
export function resolveThinkingRequest(api = {}, context = {}) {
  // 按次覆盖（context.thinkingMode，如裁判类调用传 'off' 表示"这次别思考"）
  // 优先于设置页的 api.thinkingEffort/thinkingMode。
  const perCall = String(context.thinkingMode ?? '').trim().toLowerCase();
  let effort = normalizeEffort(api.thinkingEffort);
  if (!effort) {
    // 旧三态迁移：effort 为空时看 thinkingMode
    const mode = String(api.thinkingMode ?? '').trim().toLowerCase();
    if (perCall === 'off' || mode === 'off') effort = 'off';
    else if (mode === 'on') effort = 'high';   // 明确开启、未指定强度 → 中高档
  }
  if (perCall === 'off') effort = 'off';
  // manual = 用户在设置里显式指定的方言（api.thinkingDialect）。空 = 全自动。
  // 中转站把域名和模型名都改了，自动判定本质是猜；猜不中落 generic 时
  // 档位会静默失效，所以留这个手动出口。
  const det = detectDialect({
    baseUrl: api.baseUrl || '',
    model: api.model || '',
    manual: api.thinkingDialect || ''
  });
  const budget = Number(api.thinkingBudget) > 0 ? Number(api.thinkingBudget) : 0;
  return {
    effort,
    on: Boolean(effort) && effort !== 'off',
    budget,
    dialect: det.dialect,
    dialectLabel: det.label,
    supports: det.supports,
    manual: det.manual,
    reason: det.reason
  };
}

/**
 * 构造要合并进请求体的参数。
 * 返回 { params, omitTemperature, applied }：
 *   params          直接 Object.assign 进 body
 *   omitTemperature 该方言下思考与 temperature 互斥（OpenAI o 系 / DeepSeek 思考），
 *                   调用方需要删掉 temperature，否则被 400 顶回来
 *   applied         本次是否真的加了参数（false 时 UI 显示"未应用"）
 */
export function buildThinkingParams({ effort = '', dialect = 'generic', budget = 0 } = {}) {
  const supports = (MODEL_RULES.find((r) => r.dialect === dialect)?.supports) || [];
  const e = normalizeEffort(effort);
  const on = Boolean(e) && e !== 'off';
  const params = {};
  let omitTemperature = false;
  let applied = false;
  const b = Math.max(0, Number(budget) || 0);

  // OpenAI 系 effort 值就近映射：xhigh/max → high（OpenAI 只认到 high）
  const openaiEffort = (e === 'xhigh' || e === 'max') ? 'high' : e;
  const eff = supports.includes('effort') && OPENAI_EFFORTS.includes(openaiEffort) ? openaiEffort : '';

  switch (dialect) {
    case 'deepseek':
    case 'glm': {
      if (on) { params.thinking = { type: 'enabled' }; applied = true; omitTemperature = true; }
      else if (e === 'off') { params.thinking = { type: 'disabled' }; applied = true; }
      // effort 与开关**并列**，不塞进 if(on) 里。
      // 依据（2026-10-04 实测 scripts/probe-thinking-effort.mjs，9 组 × 3 次取中位数）：
      //   thinking=disabled 时 rc_tok 恒为 0，但 effort 仍在改变 completion/正文
      //   （无 3265 / low 2589 / high 2524 / max 3142）→ 它作用在正文投入上，
      //   与思考开关是两条独立的轴。所以关掉思考时也照发 effort。
      // ⚠️ 两条实测结论，都不要在注释里简化成"档位越大思考越长"：
      //   1) 档位**非单调**：on 组 rc 中位数 无 7588 / low 4521 / medium 5841 /
      //      high 5585 / max 8192 —— low 明显低于"不指定"，medium 甚至高于 high。
      //   2) **不指定 effort 反而思考最多**（7588，仅次于 max）。这可能是
      //      "模型自行决定思考量"的路径，与用户显式指定时的行为不同。
      //   所以这里只做"映射到合法值"，不声称任何单调关系。
      if (e && e !== 'off') {
        const mapped = DEEPSEEK_EFFORTS[e] ?? null;
        if (mapped) { params.reasoning_effort = mapped; applied = true; }
      }
      break;
    }
    case 'qwen': {
      if (on) { params.enable_thinking = true; applied = true; }
      else if (e === 'off') { params.enable_thinking = false; applied = true; }
      if (applied && b > 0) params.thinking_budget = b;
      break;
    }
    case 'openai-o': {
      if (on) { params.reasoning_effort = eff || 'medium'; applied = true; omitTemperature = true; }
      else if (e === 'off') { params.reasoning_effort = 'minimal'; applied = true; }
      break;
    }
    case 'xai': {
      if (on) { params.reasoning_effort = eff || 'medium'; applied = true; }
      break;
    }
    case 'anthropic': {
      if (on) {
        params.thinking = { type: 'enabled' };
        if (b > 0) params.thinking.budget_tokens = b;
        applied = true;
      } else if (e === 'off') {
        params.thinking = { type: 'disabled' };
        applied = true;
      }
      break;
    }
    case 'gemini': {
      const cfg = {};
      if (on) cfg.thinking_budget = b > 0 ? b : -1;      // -1 = 动态思考
      else if (e === 'off') cfg.thinking_budget = 0;
      if (Object.keys(cfg).length) {
        params.extra_body = { google: { thinking_config: cfg } };
        applied = true;
      }
      break;
    }
    case 'openrouter': {
      if (on) {
        params.reasoning = b > 0 ? { max_tokens: b } : { effort: eff || 'medium' };
        applied = true;
      } else if (e === 'off') {
        params.reasoning = { effort: 'minimal' };
        applied = true;
      }
      break;
    }
    case 'ollama': {
      // Ollama 的 think 参数只在新版本支持，且网关常拒绝未知字段 ——
      // 只在明确要求开启时才发
      if (on) { params.think = true; applied = true; }
      break;
    }
    default:
      // generic / local-openai：不发任何思考参数。宁可没有思考，
      // 也不要因为多发一个未知字段把用户的网关打 400。
      break;
  }

  return { params, omitTemperature, applied };
}

/**
 * 判断错误文本是否在抱怨"思考参数不被支持"。
 * 要兼容三种字段写法：reasoning_effort / ReasoningEffort / "reasoning effort"
 * （商汤就是回 `field ReasoningEffort invalid` 的驼峰写法，只认下划线会漏判）。
 *
 * ⚠️ 判据不能太宽：早先用「只要文本里出现 thinking 且出现 invalid」，
 * 于是 `invalid model name: deepseek-thinking` 这种**模型名错误**也会被当成
 * "思考参数被拒" → 白白多打一次 API（还会把有用的错误信息掩盖掉）。
 * 现在要求字段名与拒绝词出现在**同一个片段**里，且片段看起来在说"参数/字段"。
 */
export function looksLikeThinkingRejection(text) {
  const t = String(text || '');
  if (!t) return false;

  // (?<![-\w]) —— 字段名必须是**独立词**。
  // 这条挡住的正是 `invalid model name: deepseek-thinking`：那里的 thinking
  // 是模型名的一部分（前面是连字符），不是参数名，不该触发降级重试。
  const FIELD = '(?<![-\\w])(?:thinking|reasoning[\\s_-]*effort|reasoning[\\s_-]*content|enable[\\s_-]*thinking|budget[\\s_-]*tokens|include[\\s_-]*thoughts|extra_body|思考)';
  const REFUSAL = '(?:invalid|unknown|unrecognized|unsupported|not\\s+support(?:ed)?|unexpected|unused|未知|不支持|无效|无法识别|多余)';

  // 1) 「字段 X 不合法」/「X 是未知参数」——字段名与拒绝词在同一小段内
  const near = new RegExp(`${FIELD}[^。.\\n]{0,24}${REFUSAL}|${REFUSAL}[^。.\\n]{0,24}${FIELD}`, 'i');
  if (near.test(t)) return true;

  // 2) 引号形态：「'thinking' is not supported」——字段名被引号包起来
  const quoted = new RegExp(`["'\`]${FIELD}["'\`][^。.\\n]{0,24}${REFUSAL}`, 'i');
  return quoted.test(t);
}

/** 提取思考内容。各家的字段名与结构都不一样。 */
export function extractReasoning(message) {
  if (!message || typeof message !== 'object') return '';
  const candidates = [
    message.reasoning_content,
    message.reasoning,
    message.thinking,
    message.thoughts
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  // OpenRouter：reasoning_details 是数组，元素可能是字符串或对象
  if (Array.isArray(message.reasoning_details)) {
    const joined = message.reasoning_details
      .map((d) => (typeof d === 'string' ? d : (d?.text ?? d?.summary ?? '')))
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined;
  }
  // 部分网关把思考塞进 content 的 details 数组
  if (Array.isArray(message.content)) {
    const joined = message.content
      .filter((p) => p?.type === 'thinking' || p?.type === 'reasoning')
      .map((p) => p?.thinking ?? p?.text ?? '')
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined;
  }
  return '';
}

/** 思考消耗的 token（各家的上报位置不同）。 */
export function extractReasoningTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const n = usage.completion_tokens_details?.reasoning_tokens
    ?? usage.reasoning_tokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? 0;
  return Number(n) || 0;
}
