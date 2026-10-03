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
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { detectDialect } from './thinking.js';

const CONV_DIR = path.join(DATA_DIR, 'conversations');
// 陈旧缓冲的兜底清理：超过这个时长没有任何交互就直接丢弃（防文件无限堆积）。
// 注意这与"沉默阈值"是两回事 —— 沉默阈值决定"下次触发时是否续用"，这里只是
// 把永远不会再被用到的文件删掉。
const STALE_MS = 24 * 60 * 60 * 1000;
// sweep 的最小间隔（避免每轮都 readdir）。
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

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
   * @param {number} p.turns         累计的用户轮数
   */
  save(chatKey, { systemPrompt, toolNames, messages, turns }) {
    const key = String(chatKey ?? '');
    if (!key) return null;
    const prev = this.cache.get(key) || this.#load(key);
    const buf = {
      chatKey: key,
      systemPrompt: String(systemPrompt ?? ''),
      toolNames: Array.isArray(toolNames) ? toolNames.map(String) : [],
      messages: Array.isArray(messages) ? messages : [],
      turns: Math.max(0, Number(turns) || 0),
      chars: countChars(messages),
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

  /** 丢弃某会话的缓冲（手动「重开会话」/ 沉默关闭 / 任一前提不满足时调用）。 */
  clear(chatKey) {
    const key = String(chatKey ?? '');
    if (!key) return false;
    const had = this.cache.delete(key);
    try {
      fs.rmSync(fileOf(key), { force: true });
      return true;
    } catch {
      return had;
    }
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

// ── 会话关闭时的蒸馏（②P2）────────────────────────────────────────────
// 关闭那一刻是唯一真正握有完整思考链的时刻。调一次小模型，把它提炼成
// "需要跨会话记住的私有状态"，写进自身记忆（_self.json）的【自身状态】段。
//
// 为什么必须做：延续期间思考天然留在上下文里；一旦关闭（沉默/超限），
// 那些思考就永久蒸发。海龟汤这类"暗牌"任务，谜底就在机器人的 CoT 里 ——
// 不蒸馏 = 下次重开时它把自己的谜底忘了。

/**
 * 从会话缓冲里抽出 assistant 的"思考/正文"文本（即机器人自己的私有推理）。
 * 这是蒸馏的输入。工具调用参数**不算**思考内容，跳过。
 */
export function collectAssistantText(messages, { maxChars = 12000 } = {}) {
  const chunks = [];
  let total = 0;
  for (const m of messages || []) {
    if (m?.role !== 'assistant') continue;
    const c = m?.content;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('')
        : '';
    const t = String(text ?? '').trim();
    if (!t) continue;
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
 * @param {object} p
 * @param {object} p.memory       MemoryStore（写 appendSelf）
 * @param {string} p.chatKey
 * @param {Array}  p.messages     会话缓冲的消息序列
 * @param {Function} p.callModel  形如 (args) => Promise<{message,usage}>，通常传 chatCompletionWithRetry
 * @param {object} [p.api]        渠道配置（baseUrl/model，供日志）
 * @param {number} [p.maxChars]   蒸馏输入字符预算
 * @returns {Promise<string[]>}   实际写入的条目
 */
export async function distillBuffer({ memory, chatKey, messages, callModel, maxChars = 12000 }) {
  if (!memory || !chatKey || typeof callModel !== 'function') return [];
  const cot = collectAssistantText(messages, { maxChars });
  if (!cot) return [];
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
  return written;
}
