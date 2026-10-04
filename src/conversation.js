// 会话缓冲（"沉默为界"的思考链延续，2026-10-03 ②P1）。
//
// 背景：本项目原本是"每次触发 = 全新会话"，LLM 层面零历史 —— 单次成本恒定，
// 但机器人**自己的思考/私有状态**也随每轮蒸发（海龟汤这类"暗牌"任务完全不可用）。
//
// 本模块提供一个按 chatKey 维护的"活跃会话缓冲"：
//   · 群里消息连续（两次交互间隔 < 沉默阈值）→ 继续同一会话：在已存 messages 上
//     **追加**增量，思考链天然留在上下文里；成本靠前缀缓存压住（追加 = 前缀
//     字节不变，命中缓存的部分按缓存价计费）。
//   · 沉默超阈值 / 系统提示或工具集变化 / 超轮次或体积上限 → 关闭缓冲，下次走
//     fresh（全新会话，行为与改动前完全一致）。
//
// ⚠️ 必须落盘：不能像 activeTopics 那样只放内存 —— 重启即丢会让"沉默为界"
//    在每次重启后退化成"每次全新会话"，白做。
//
// ⚠️ 前缀稳定的四个前提（任何一个破了，缓存收益就没了，甚至更贵）：
//    1. systemPrompt **逐字节复用**（存字符串、重发同一份）；
//    2. 工具集不变（工具定义在请求体里排在 messages 之前，一变全废）；
//    3. 只在数组尾部追加，绝不改写历史字节；
//    4. 历史条目里不带 `raw` 这类每轮都变的字段（见 orchestrator 的剥离逻辑）。
//
// ⚠️ reasoning（模型的私有推理 / reasoning_content）**存在旁路数组 `reasonings` 里**，
//    与 messages 下标一一对应，绝不混进 messages —— 它不该发回上游（会重复上传、
//    干扰缓存），但必须留在本地：会话关闭那一刻是唯一能读到"机器人真正想过什么"
//    的时刻（蒸馏的输入、UI 的思维链展示都靠它）。见 collectAssistantText。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { detectDialect } from './thinking.js';

const CONV_DIR = path.join(DATA_DIR, 'conversations');
// 关闭的会话归档到这里（②P3：buffer 归档回溯）。供 UI/排障回看"上一个会话长什么样"。
const ARCHIVE_DIR = path.join(CONV_DIR, 'archive');
// 每个会话最多保留几份归档（按时间倒序，超出的删掉）。
const ARCHIVE_KEEP = 10;
// 陈旧缓冲的兜底清理：超过这个时长没有任何交互就直接丢弃（防文件无限堆积）。
// 注意这与"沉默阈值"是两回事 —— 沉默阈值决定"下次触发时是否续用"，这里只是
// 把永远不会再被用到的文件删掉。
const STALE_MS = 24 * 60 * 60 * 1000;
// sweep 的最小间隔（避免每轮都 readdir）。
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// 单条 reasoning 的存储上限（字符）。模型的私有推理可以非常长（甚至上万字），
// 而蒸馏预算默认才 12000 字符 —— 逐条截断既够用，又防止缓冲文件无限膨胀。
const REASONING_PER_MSG_MAX = 4000;
// 整个缓冲里 reasoning 的总量上限（字符）。超了从**最早**的开始丢 —— 越近的
// 思考越贴近"这段会话刚发生了什么"，对关闭蒸馏越有价值。
const REASONING_TOTAL_MAX = 48000;

/**
 * 各家前缀缓存的 TTL 口径（2026-10 查证），单位：分钟。
 * 沉默阈值应当贴着它取 —— 超过 TTL 之后缓存已经失效，"继续扛长上下文"严格劣于
 * "关会话重开"，所以阈值给到 TTL 就够，再长只是烧钱。
 *   Anthropic 5 分钟（命中刷新）、Qwen 显式 5 分钟、OpenAI ~5–10 分钟、
 *   DeepSeek 官方"数小时到数天"（不承诺固定 TTL，第三方实测报 ~10 分钟）、
 *   Gemini 隐式 24 小时（不保证命中）。
 * anthropic 取 4 而不是 5：TTL 从"发起请求"起算、**生成耗时也计入**，
 * 留 1 分钟余量才不会在长回复后刚好踩空。
 */
const SILENCE_MIN_BY_DIALECT = {
  anthropic: 4,
  qwen: 5,
  'openai-o': 8,
  deepseek: 60,
  gemini: 60
};
const DEFAULT_SILENCE_MIN = 5;   // 兜底：贴住最保守的主流 TTL

/**
 * 求本次生效的沉默阈值（毫秒）。
 *   continuation.silenceMinutes === 0      → 0（不按沉默切分，只靠轮次/体积上限兜底）
 *   continuation.silenceMinutes > 0        → 强制该值（分钟）
 *   未设 / null                            → 按渠道自动取值（见上表）
 */
export function resolveSilenceMs(cont = {}, api = {}) {
  const raw = cont?.silenceMinutes;
  if (raw === 0 || raw === '0') return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n * 60_000;
  const det = detectDialect({ baseUrl: api?.baseUrl || '', model: api?.model || '' });
  const min = SILENCE_MIN_BY_DIALECT[det.dialect] ?? DEFAULT_SILENCE_MIN;
  return min * 60_000;
}

function safeName(chatKey) {
  return String(chatKey ?? '').replace(/[^a-z0-9_]/gi, '_');
}

function fileOf(chatKey) {
  return path.join(CONV_DIR, `${safeName(chatKey)}.json`);
}

/** 消息序列的字符数（体积预算的近似口径 —— 不引 tokenizer，够用）。 */
function countChars(messages) {
  let n = 0;
  for (const m of messages || []) {
    const c = m?.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part?.text === 'string') n += part.text.length;
        else if (part?.image_url) n += 200;    // 图片按固定成本粗估
      }
    }
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) n += String(tc?.function?.arguments ?? '').length;
    }
  }
  return n;
}

/**
 * 规整 reasonings 旁路数组：与 messages **下标一一对应**，长度严格相同。
 * 对不齐就毫无意义（缓冲里只会尾部追加，位置是稳定的），所以宁可补空也不留错位。
 * 非字符串一律视为空。
 */
function normalizeReasonings(reasonings, len) {
  const n = Math.max(0, Number(len) || 0);
  const out = new Array(n).fill('');
  if (!Array.isArray(reasonings)) return out;
  for (let i = 0; i < Math.min(n, reasonings.length); i++) {
    const v = reasonings[i];
    if (typeof v === 'string' && v) out[i] = v;
  }
  return out;
}

/**
 * 裁剪 reasonings：逐条截到 REASONING_PER_MSG_MAX，总量超 REASONING_TOTAL_MAX
 * 时从最早的开始丢。只留尾部 —— 越近的思考越贴近"这段会话刚发生了什么"。
 */
function trimReasonings(reasonings, len) {
  const out = normalizeReasonings(reasonings, len);
  for (let i = 0; i < out.length; i++) {
    if (out[i].length > REASONING_PER_MSG_MAX) out[i] = out[i].slice(0, REASONING_PER_MSG_MAX);
  }
  let total = 0;
  for (let i = 0; i < out.length; i++) total += out[i].length;
  for (let i = 0; i < out.length && total > REASONING_TOTAL_MAX; i++) {
    total -= out[i].length;
    out[i] = '';
  }
  return out;
}

export class ConversationStore {
  constructor() {
    /** chatKey -> buffer */
    this.cache = new Map();
    this.lastSweepAt = 0;
    try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch { /* 目录建不出来就算了 */ }
  }

  #load(chatKey) {
    try {
      const raw = JSON.parse(fs.readFileSync(fileOf(chatKey), 'utf8'));
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.messages)) return null;
      return {
        chatKey,
        systemPrompt: String(raw.systemPrompt ?? ''),
        toolNames: Array.isArray(raw.toolNames) ? raw.toolNames.map(String) : [],
        messages: raw.messages,
        reasonings: normalizeReasonings(raw.reasonings, raw.messages.length),
        turns: Number(raw.turns) || 0,
        chars: Number(raw.chars) || countChars(raw.messages),
        startedAt: Number(raw.startedAt) || 0,
        lastTurnAt: Number(raw.lastTurnAt) || 0
      };
    } catch {
      return null;   // 文件不存在 / 读坏 → 视为无缓冲
    }
  }

  /** 取某会话的活跃缓冲（没有则 null）。 */
  get(chatKey) {
    const key = String(chatKey ?? '');
    if (!key) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    const loaded = this.#load(key);
    if (loaded) this.cache.set(key, loaded);
    return loaded;
  }

  /**
   * 写入/更新缓冲。
   * @param {string} chatKey
   * @param {object} p
   * @param {string} p.systemPrompt  本轮实际使用的系统提示（下一轮要逐字节比对）
   * @param {string[]} p.toolNames   本轮实际可用的工具 id 列表
   * @param {Array} p.messages       **不含 system** 的消息序列（已剥 raw）
   * @param {Array} [p.reasonings]   与 messages 下标对应的私有推理（旁路，不发上游）
   * @param {number} p.turns         累计的用户轮数
   */
  save(chatKey, { systemPrompt, toolNames, messages, reasonings, turns }) {
    const key = String(chatKey ?? '');
    if (!key) return null;
    const prev = this.cache.get(key) || this.#load(key);
    const msgs = Array.isArray(messages) ? messages : [];
    const buf = {
      chatKey: key,
      systemPrompt: String(systemPrompt ?? ''),
      toolNames: Array.isArray(toolNames) ? toolNames.map(String) : [],
      messages: msgs,
      reasonings: trimReasonings(reasonings, msgs.length),
      turns: Math.max(0, Number(turns) || 0),
      chars: countChars(msgs),
      startedAt: Number(prev?.startedAt) || Date.now(),
      lastTurnAt: Date.now()
    };
    this.cache.set(key, buf);
    try {
      fs.mkdirSync(CONV_DIR, { recursive: true });
      const tmp = `${fileOf(key)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(buf), 'utf8');
      fs.renameSync(tmp, fileOf(key));
    } catch (error) {
      // 落盘失败不能让聊天主流程挂掉：内存里还有，只是重启后不续
      console.warn('[conversation] 会话缓冲落盘失败:', error?.message ?? error);
    }
    this.sweep();
    return buf;
  }

  /**
   * 丢弃某会话的缓冲（手动「重开会话」/ 沉默关闭 / 任一前提不满足时调用）。
   * @param {string} chatKey
   * @param {object} [opts]
   * @param {boolean} [opts.archive=true] 先归档一份再删（②P3，供回溯）
   * @param {string}  [opts.reason='']    归档时记下的关闭原因
   */
  clear(chatKey, { archive = true, reason = '' } = {}) {
    const key = String(chatKey ?? '');
    if (!key) return false;
    const buf = this.cache.get(key) || this.#load(key);
    if (archive && buf) this.#archive(buf, reason);
    this.cache.delete(key);
    try {
      fs.rmSync(fileOf(key), { force: true });
      return true;
    } catch {
      return !!buf;
    }
  }

  /** 把一份缓冲写进归档目录，并裁剪到 ARCHIVE_KEEP 份。 */
  #archive(buf, reason = '') {
    try {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const stamp = new Date(Number(buf.lastTurnAt) || Date.now())
        .toISOString().replace(/[:.]/g, '-');
      // 同毫秒内多次关闭会撞名 → 加一个自增序号，保证"每份归档一个文件"
      const seq = (this.archiveSeq = (this.archiveSeq || 0) + 1);
      const name = `${safeName(buf.chatKey)}.${stamp}.${seq}.json`;
      const payload = { ...buf, closedReason: String(reason || ''), closedAt: Date.now() };
      const tmp = path.join(ARCHIVE_DIR, `${name}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, path.join(ARCHIVE_DIR, name));
      this.#trimArchives(buf.chatKey);
    } catch (error) {
      console.warn('[conversation] 归档会话缓冲失败:', error?.message ?? error);
    }
  }

  /** 每个会话只留最近 ARCHIVE_KEEP 份归档。 */
  #trimArchives(chatKey) {
    try {
      const prefix = `${safeName(chatKey)}.`;
      const mine = fs.readdirSync(ARCHIVE_DIR)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
        .sort();   // 文件名里的 ISO 时间戳 → 字典序即时间序
      for (const f of mine.slice(0, Math.max(0, mine.length - ARCHIVE_KEEP))) {
        try { fs.rmSync(path.join(ARCHIVE_DIR, f), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* 目录不存在 */ }
  }

  /** 列出某会话（或全部）的归档摘要，新的在前。 */
  listArchives(chatKey = '', { limit = 50 } = {}) {
    const out = [];
    try {
      const prefix = chatKey ? `${safeName(chatKey)}.` : '';
      for (const f of fs.readdirSync(ARCHIVE_DIR)) {
        if (!f.endsWith('.json') || !f.startsWith(prefix)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'));
          out.push({
            file: f,
            chatKey: raw.chatKey,
            turns: Number(raw.turns) || 0,
            chars: Number(raw.chars) || 0,
            messages: Array.isArray(raw.messages) ? raw.messages.length : 0,
            startedAt: Number(raw.startedAt) || 0,
            lastTurnAt: Number(raw.lastTurnAt) || 0,
            closedAt: Number(raw.closedAt) || 0,
            closedReason: String(raw.closedReason || '')
          });
        } catch { /* 单份读坏跳过 */ }
      }
    } catch { /* 目录不存在 */ }
    out.sort((a, b) => (b.closedAt || b.lastTurnAt) - (a.closedAt || a.lastTurnAt));
    return out.slice(0, limit);
  }

  /** 列出全部活跃缓冲（供 UI / 排障）。只读缓存 + 磁盘，不建索引。 */
  list() {
    const out = [];
    const seen = new Set();
    for (const [key, buf] of this.cache.entries()) {
      seen.add(key);
      out.push(this.#summary(buf));
    }
    try {
      for (const f of fs.readdirSync(CONV_DIR)) {
        if (!f.endsWith('.json')) continue;
        const key = f.replace(/\.json$/, '');
        if (seen.has(key)) continue;
        const buf = this.#load(key);
        if (buf) out.push(this.#summary(buf));
      }
    } catch { /* 目录不存在 */ }
    out.sort((a, b) => b.lastTurnAt - a.lastTurnAt);
    return out;
  }

  #summary(buf) {
    return {
      chatKey: buf.chatKey,
      turns: buf.turns,
      chars: buf.chars,
      messages: buf.messages.length,
      startedAt: buf.startedAt,
      lastTurnAt: buf.lastTurnAt
    };
  }

  /** 清理长时间未交互的缓冲文件（节流：最多每 SWEEP_INTERVAL_MS 跑一次）。 */
  sweep(now = Date.now(), maxIdleMs = STALE_MS) {
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return 0;
    this.lastSweepAt = now;
    let removed = 0;
    try {
      for (const f of fs.readdirSync(CONV_DIR)) {
        if (!f.endsWith('.json')) continue;
        const key = f.replace(/\.json$/, '');
        const buf = this.cache.get(key) || this.#load(key);
        if (!buf) continue;
        if (now - (Number(buf.lastTurnAt) || 0) < maxIdleMs) continue;
        this.cache.delete(key);
        try { fs.rmSync(path.join(CONV_DIR, f), { force: true }); removed += 1; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return removed;
  }
}

/** 工具集是否一致（顺序无关，但集合必须完全相同）。 */
export function sameToolNames(a, b) {
  const x = Array.isArray(a) ? a.map(String).slice().sort() : [];
  const y = Array.isArray(b) ? b.map(String).slice().sort() : [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// ── 媒体瘦身（②P3）──────────────────────────────────────────────────
// 延续轮会把上一轮的 messages 原样重发。若历史里带着 base64 图片/视频，这些字节
// 每轮都要重传：既按 token 计费（图片往往是大头），又让前缀缓存收益被吃光
// （同一张图在不同的轮次里会被重新计费）。
//
// 做法：把历史条目里的 image_url / video_url **换成一行文字占位**（保留伴随的
// 说明文字），模型仍知道"这里看过一张图"，只是不再重复"看"它。
//
// ⚠️ 只瘦身**历史**（作为前缀复用的旧 messages）。本轮新产生的图片不能动 ——
//    模型正是要看它；本轮图片会在它变成"历史"后的下一轮被自动瘦身。

const MEDIA_PLACEHOLDER = '[此前看过的一张图片/视频（已省略，避免重复计费）]';

/**
 * 返回一份"媒体已瘦身"的消息序列副本（不改原数组）。
 * 只有 parts 形态的 content（数组）才可能带媒体；字符串 content 原样保留。
 */
export function slimHistoricalMedia(messages) {
  let changed = false;
  const out = [];
  for (const m of messages || []) {
    const c = m?.content;
    if (!Array.isArray(c)) { out.push(m); continue; }
    let hit = false;
    const parts = [];
    for (const p of c) {
      if (p && (p.type === 'image_url' || p.type === 'video_url')) {
        hit = true;
        // 折叠连续媒体：只在没有紧邻占位时插一条，避免"3 张图"变成 3 行占位
        if (parts[parts.length - 1]?.text !== MEDIA_PLACEHOLDER) {
          parts.push({ type: 'text', text: MEDIA_PLACEHOLDER });
        }
      } else {
        parts.push(p);
      }
    }
    if (!hit) { out.push(m); continue; }
    changed = true;
    // 瘦身后只剩纯文本 → 退回字符串形态（更省字节，也更好比对前缀）
    const onlyText = parts.every((p) => p?.type === 'text');
    out.push(onlyText
      ? { ...m, content: parts.map((p) => p.text).join('\n') }
      : { ...m, content: parts });
  }
  return changed ? out : (messages || []);
}

// ── 会话关闭时的蒸馏（②P2）────────────────────────────────────────────
// 关闭那一刻是唯一真正握有完整思考链的时刻。调一次小模型，把它提炼成
// "需要跨会话记住的私有状态"，写进自身记忆（_self.json）的【自身状态】段。
//
// 为什么必须做：延续期间思考天然留在上下文里；一旦关闭（沉默/超限），
// 那些思考就永久蒸发。海龟汤这类"暗牌"任务，谜底就在机器人的 CoT 里 ——
// 不蒸馏 = 下次重开时它把自己的谜底忘了。

/**
 * 从会话缓冲里抽出 assistant 的"私有推理"文本 —— 这是蒸馏的输入。
 *
 * ⚠️ 素材来源的优先级（2026-10-04 修正）：
 *   很多模型（deepseek 系、qwen thinking、gemini 等）**正文 content 是空的**，
 *   真正的思考在 reasoning_content 里。而 content 为空恰恰也是"这一轮只调了
 *   工具"的常态 —— 于是原实现（只读 content）在真实运行中几乎恒返回空串，
 *   蒸馏永远产不出东西（用户点「重开并蒸馏」后什么都没有）。
 *   现在改为：reasoning 优先，content 作为补充（两者都有时都收）。
 *
 * 工具调用参数**不算**思考内容，仍然跳过。
 *
 * @param {Array} messages 会话缓冲的消息序列
 * @param {object} [opts]
 * @param {Array} [opts.reasonings] 与 messages 下标对应的 reasoning（旁路数组）
 * @param {number} [opts.maxChars]   字符预算
 */
export function collectAssistantText(messages, { maxChars = 12000, reasonings = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const chunks = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m?.role !== 'assistant') continue;
    // 兼容两种来源：旁路数组优先，其次条目自带（raw 里嵌套的老形态也能取到）。
    const r = (Array.isArray(reasonings) ? reasonings[i] : null)
      ?? m?.reasoning_content
      ?? m?.reasoning
      ?? m?.raw?.choices?.[0]?.message?.reasoning_content
      ?? '';
    const c = m?.content;
    const body = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('')
        : '';
    // reasoning 在前、正文在后：思考是主体，正文常只是它决定"说出口"的部分。
    const parts = [String(r ?? '').trim(), String(body ?? '').trim()].filter(Boolean);
    if (!parts.length) continue;
    const t = parts.join('\n');
    chunks.push(t);
    total += t.length;
    if (total >= maxChars) break;
  }
  let out = chunks.join('\n---\n');
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return out;
}

export const DISTILL_SYSTEM_PROMPT = [
  '你在帮一个群聊 AI 机器人做"会话关闭前的记忆归档"。',
  '下面会给你这个机器人在刚刚结束的一段群聊会话中**没有发送到群里**的内部思考与正文。',
  '请从中提炼出**需要跨会话记住的私有状态**，只包括：',
  '1. 未完成的目标 / 正在做的事（例如"我在和群友玩海龟汤，还在猜"）；',
  '2. 机器人自己定下的规则 / 承诺 / 约定；',
  '3. 答案 / 关键事实（例如它其实知道自己出的谜底是什么）；',
  '4. 明确写下的待办。',
  '要求：',
  '- 每条用一句简明中文，客观陈述，不要用"我"以外的第一人称口吻解释。',
  '- 只写**确实存在于思考里**的内容，禁止脑补、禁止写与人设/群友印象无关的废话。',
  '- 最多 5 条。没有值得跨会话记住的内容时，只回复一个空 JSON 数组。',
  '- **只输出 JSON 数组**，形如 ["...","..."]，不要任何额外文字、不要 markdown 代码块。'
].join('\n');

/**
 * 解析蒸馏结果。返回 string[]（最多 5 条，去空、去重）。
 * 容错：模型可能包 markdown 代码块、可能给对象数组 —— 都尽量捞出来。
 */
export function parseDistillResult(text, { max = 5 } = {}) {
  let s = String(text ?? '').trim();
  if (!s) return [];
  // 剥 markdown 代码围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  // 截取第一个 '[' 到最后一个 ']'
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let arr = null;
  try { arr = JSON.parse(s); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const content = typeof item === 'string' ? item : (item && typeof item.content === 'string' ? item.content : '');
    const t = String(content).trim().slice(0, 400);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 蒸馏一次并写入自身记忆。
 *
 * ⚠️ 返回值不是 string[]，而是一个**可观测的结果摘要**（2026-10-04）：
 *   之前返回的 string[] 无法区分"蒸馏跑了但没提炼出东西"和"压根没跑"——
 *   而这两种在 UI 上长得一模一样（都没有 _self.json），用户点了"重开并蒸馏"
 *   之后完全看不到反馈。改成 summary 后调用方能拿到明确原因并写进日志。
 *   为兼容旧调用方，summary 自带 items（就是原来的 string[]）。
 *
 * @param {object} p
 * @param {object} p.memory       MemoryStore（写 appendSelf）
 * @param {string} p.chatKey
 * @param {Array}  p.messages     会话缓冲的消息序列
 * @param {Array}  [p.reasonings] 与 messages 下标对应的私有推理（缓冲的旁路数组）
 * @param {Function} p.callModel  形如 (args) => Promise<{message,usage}>，通常传 chatCompletionWithRetry
 * @param {object} [p.api]        渠道配置（baseUrl/model，供日志）
 * @param {number} [p.maxChars]   蒸馏输入字符预算
 * @returns {Promise<{
 *   status: 'skipped-no-buffer' | 'skipped-empty-cot' | 'skipped-no-content' | 'ok',
 *   reason: string,
 *   cotChars: number,
 *   itemCount: number,
 *   items: string[]
 * }>}
 */
export async function distillBuffer({ memory, chatKey, messages, reasonings, callModel, maxChars = 12000 }) {
  const no = (status, reason, cotChars = 0) => withItems({ status, reason, cotChars, itemCount: 0, items: [] });
  if (!memory || !chatKey || typeof callModel !== 'function') {
    return no('skipped-no-buffer', '参数不全（memory/chatKey/callModel 缺失）');
  }
  const cot = collectAssistantText(messages, { maxChars, reasonings });
  // 素材为空 → 显式回报原因，绝不静默 return（用户点了按钮必须能在日志里看到结果）。
  // 真实原因通常是"这条链路上的模型不产 reasoning_content"（正文空、思考也没有）。
  if (!cot) {
    return no('skipped-empty-cot', '这段会话里既没有 assistant 正文、也没有 reasoning_content（模型未产出私有推理），无可提炼素材');
  }
  const r = await callModel({
    messages: [
      { role: 'system', content: DISTILL_SYSTEM_PROMPT },
      { role: 'user', content: `以下是这段会话的内部思考：\n\n${cot}` }
    ],
    maxTokens: 600,
    temperature: 0.2
  });
  const text = r?.message?.content;
  const items = parseDistillResult(text);
  const written = [];
  for (const content of items) {
    const e = memory.appendSelf(chatKey, content);
    if (e) written.push(e.content);
  }
  // 模型跑了但认为"没有值得记住的东西"——这是正常结果，不是错误。
  if (!written.length) return withItems(no('skipped-no-content', '蒸馏模型认为这段对话没有值得跨轮记住的内容', cot.length));
  return withItems({ status: 'ok', reason: '', cotChars: cot.length, itemCount: written.length, items: written });

  /**
   * 兼容旧的 string[] 调用方：把 summary 伪装成数组（带 .status/.reason 等属性）。
   * 老代码 `written.length` / `for (const c of written)` 照常可用，新代码读属性拿原因。
   * 避免为了加可观测性而改所有调用点（含既有测试）。
   */
  function withItems(summary) {
    const arr = summary.items.slice();
    Object.assign(arr, summary);
    return arr;
  }
}
