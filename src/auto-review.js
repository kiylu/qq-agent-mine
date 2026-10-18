// 自动学习（L3）：续接期后台评审。
//
// ── 补的是什么缺口 ──────────────────────────────────────────────────────
// 本项目原先只在**会话关闭**时蒸馏一次。而一个会话最多连续 30 轮
// （`continuation.maxTurns`），这 30 轮里**什么都不沉淀** —— 海龟汤玩到一半被软重置，
// 中途想清楚的东西就没了。
//
// 做法：每 N 轮续接，**旁路**跑一次评审（独立 messages，绝不进主会话前缀），
// 让模型判断"这一段有没有值得留下的：一条记忆 / 一个可复用的做法"。结果只落盘
// （`_self.json` 与 `SKILL.md`）。
//
// ── 两个刻意的取舍 ──────────────────────────────────────────────────────
// 1. **不复用主会话的 systemPrompt。** 看着能省一次前缀缓存，但那是"群友人设"提示词，
//    模型会接着扮演群友而不是做复盘 —— 评审是**元任务**，必须用独立的小提示词。
//    成本可控：每 N 轮一次，输入按字符预算截断。
// 2. **不学"什么都不做是失败"。** 群聊单次价值低，绝大多数评审**应该**返回空；
//    为了沉淀而沉淀只会制造噪声记忆。提示词里明确写了"没有就返回空"。
//
// ⚠️ 去重复用现有机制：`memory.appendSelf` 同内容不重复写；技能已存在时不覆盖手写版本。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';
import { collectAssistantText, DISTILL_NOT_RECORD } from './conversation.js';
import { listMarkdownSkills, getMarkdownSkill, saveMarkdownSkill } from './markdown-skills.js';

const STATS_FILE = path.join(DATA_DIR, 'auto-learn-stats.json');

/**
 * 数值钳制。
 * ⚠️ 不能写成 `Number(v) || 默认值` —— 那会把**合法的 0**（如"自动技能上限 0 = 不许新建"）
 *    当成"没填"而替换成默认值。这里只把非有限数当缺失。
 */
function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 自动学习的配置（已补默认值）。 */
export function autoLearnConfig() {
  const c = getConfig()?.autoLearn || {};
  return {
    // 总开关，默认关：会额外花模型调用、会改行为，不默认开。
    enabled: c.enabled === true,
    // 每 N 轮续接评审一次（1 轮就评审 = 每轮多一次调用，不划算）
    intervalTurns: clampInt(c.intervalTurns, 1, 50, 8),
    // 单次评审最多写几条记忆
    maxMemories: clampInt(c.maxMemories, 1, 5, 1),
    // 评审是否允许**新建**技能（关 = 只更新已存在的自动技能）
    createNewSkill: c.createNewSkill === true,
    // 自动创建的技能数量上限（0 = 不许新建，但允许更新已有的自动技能）
    maxAutoSkills: clampInt(c.maxAutoSkills, 0, 100, 10)
  };
}

export function updateAutoLearnConfig(patch = {}) {
  const next = {};
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.intervalTurns !== undefined) next.intervalTurns = clampInt(patch.intervalTurns, 1, 50, 8);
  if (patch.maxMemories !== undefined) next.maxMemories = clampInt(patch.maxMemories, 1, 5, 1);
  if (patch.createNewSkill !== undefined) next.createNewSkill = !!patch.createNewSkill;
  if (patch.maxAutoSkills !== undefined) next.maxAutoSkills = clampInt(patch.maxAutoSkills, 0, 100, 10);
  if (Object.keys(next).length) updateConfig({ autoLearn: next });
  return autoLearnConfig();
}

// ── 统计（给 UI 显示"上次跑没跑、写了几条"）──

export function autoLearnStats() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch { raw = null; }
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    runs: Number(s.runs) || 0,
    lastRunAt: Number(s.lastRunAt) || 0,
    lastStatus: String(s.lastStatus || ''),
    totalMemories: Number(s.totalMemories) || 0,
    totalSkills: Number(s.totalSkills) || 0
  };
}

function recordAutoLearnRun({ status, memories = 0, skill = null }) {
  const s = autoLearnStats();
  const next = {
    runs: s.runs + 1,
    lastRunAt: Date.now(),
    lastStatus: String(status || ''),
    totalMemories: s.totalMemories + (Number(memories) || 0),
    totalSkills: s.totalSkills + (skill ? 1 : 0)
  };
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    const tmp = `${STATS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1), 'utf8');
    fs.renameSync(tmp, STATS_FILE);
  } catch { /* 统计失败不影响主流程 */ }
}

// ── 评审提示词 ──

export const AUTO_REVIEW_SYSTEM_PROMPT = [
  '你在帮一个群聊 AI 机器人做"中途复盘"。它正连着聊，还没到会话关闭，所以没人替它记东西。',
  '下面给你：它最近几轮的**内部思考**（[思考]）、**实际发到群里的话**（[说出口]）、',
  '它当前的【自身状态】、【对群友的印象】。',
  '',
  '请判断：这一段有没有值得留下来的东西？两类：',
  '',
  '- **memory（记忆）**：',
  '  · kind=state —— 跨轮必须接得上的事实：还在进行的多轮活动（没结束的游戏、谜底）、',
  '    答应了但没做的事、对方问了还没答的问题；',
  '  · kind=rule —— 以后该怎么做：群友**真的开口纠正过**的说话方式/做法，',
  '    或它明确承诺长期遵守的规矩。这类比普通状态重要。',
  '- **skill（技能）**：一段**可复用的步骤**（如"怎么主持一局海龟汤"）。',
  '  只在这段真的摸索出了成型的流程时才写；随手闲聊不要写。',
  '',
  DISTILL_NOT_RECORD,
  '',
  '要求：',
  '- **绝大多数情况应该什么都不写。** 群聊单次价值低，为了沉淀而沉淀只会制造噪声。',
  '- memory 最多 {MAX_MEMORIES} 条，每条一句中文。',
  '- skill 的 body 分步写清怎么做（Markdown），id 用英文短标识（字母/数字/._-）。不确定就别写。',
  '- 只输出 JSON，不要解释、不要 markdown 代码块：',
  '  {"memories":[{"kind":"state","content":"..."}],"skill":null}',
  '  或',
  '  {"memories":[],"skill":{"id":"turtle-soup","name":"海龟汤主持","description":"...","triggers":"海龟汤, 猜谜","body":"1. ..."}}',
  '- 没有值得留的：{"memories":[],"skill":null}'
].join('\n');

// ── 输入组装 ──

/**
 * 组装评审输入。全部来自**已有数据**，不额外调模型。
 * @param {object} p
 * @param {Array}  p.messages     会话缓冲的 messages（不含 system）
 * @param {Array}  [p.reasonings] 与 messages 下标对应的私有推理
 * @param {Array}  [p.selfNotes]  当前自身状态（{content} 或字符串）
 * @param {string} [p.impressions] 已渲染好的【对群友的印象】段
 * @param {number} [p.maxChars]   内部思考的字符预算
 */
export function buildAutoReviewInput({
  messages, reasonings, selfNotes = [], impressions = '', maxChars = 6000
} = {}) {
  const cot = collectAssistantText(messages, { maxChars, reasonings });
  const parts = [];
  if (cot) parts.push('【最近的内部思考】', cot);
  // 过期的 state 不再注入主提示词，也不该当作评审的上下文 —— 否则模型会基于
  // 一条早已失效的计划继续写新条目（`selfNotes()` 会带 expired 标记）。
  const notes = (Array.isArray(selfNotes) ? selfNotes : [])
    .filter((e) => !(e && typeof e === 'object' && e.expired))
    .slice(0, 10);
  if (notes.length) {
    parts.push('', '【当前自身状态】');
    for (const e of notes) parts.push(`- ${typeof e === 'string' ? e : String(e?.content ?? '')}`);
  }
  if (impressions && String(impressions).trim()) {
    parts.push('', String(impressions).trim());
  }
  return parts.join('\n').trim();
}

// ── 结果解析 ──

/**
 * 解析评审输出。容错：可能包 markdown 围栏、可能给纯字符串数组。
 * @returns {{memories: Array<{content:string, kind:'state'|'rule'}>, skill: object|null}}
 */
export function parseAutoReview(text, { maxMemories = 1 } = {}) {
  const empty = { memories: [], skill: null };
  let s = String(text ?? '').trim();
  if (!s) return empty;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let obj = null;
  try { obj = JSON.parse(s); } catch { return empty; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return empty;

  const memories = [];
  const seen = new Set();
  for (const item of Array.isArray(obj.memories) ? obj.memories : []) {
    const isObj = item && typeof item === 'object';
    const content = typeof item === 'string' ? item : (isObj && typeof item.content === 'string' ? item.content : '');
    const t = String(content).trim().slice(0, 400);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    memories.push({ content: t, kind: isObj && item.kind === 'rule' ? 'rule' : 'state' });
    if (memories.length >= Math.max(1, maxMemories)) break;
  }

  let skill = null;
  const sk = obj.skill;
  if (sk && typeof sk === 'object' && typeof sk.body === 'string' && sk.body.trim()) {
    const id = String(sk.id || '').trim();
    const name = String(sk.name || id).trim();
    if (/^[a-zA-Z0-9._-]{1,40}$/.test(id) && name) {
      const triggers = Array.isArray(sk.triggers)
        ? sk.triggers
        : String(sk.triggers || '').split(/[,，]/);
      skill = {
        id,
        name,
        description: String(sk.description || '').trim(),
        triggers: triggers.map((x) => String(x).trim()).filter(Boolean).slice(0, 20),
        body: String(sk.body).trim().slice(0, 4000)
      };
    }
  }
  return { memories, skill };
}

// ── 落盘 ──

/**
 * 写技能：手写的不覆盖；新建受 `createNewSkill` 与数量上限约束。
 * @returns {string|null} 实际写入的技能 id
 */
export function applyAutoSkill(skill, { createNewSkill = false, maxAutoSkills = 10 } = {}) {
  if (!skill?.id) return null;
  const existing = getMarkdownSkill(skill.id, { withBody: true });
  if (existing) {
    const meta = listMarkdownSkills().find((s) => s.id === skill.id);
    // 手写的技能不让自动学习改写 —— 那是用户的东西。
    if (!meta || meta.source !== 'auto') return null;
    saveMarkdownSkill({
      id: skill.id,
      name: skill.name || existing.name,
      description: skill.description || existing.description,
      triggers: skill.triggers.length ? skill.triggers : existing.triggers,
      category: existing.category,
      body: skill.body,
      source: 'auto'
    });
    return skill.id;
  }
  if (!createNewSkill) return null;
  const autoCount = listMarkdownSkills().filter((s) => s.source === 'auto').length;
  if (autoCount >= Math.max(0, maxAutoSkills)) return null;
  saveMarkdownSkill({ ...skill, category: 'utility', source: 'auto' });
  return skill.id;
}

/**
 * 把解析结果落盘。
 * @returns {{memories:number, skill:string|null}}
 */
export function applyAutoReview({
  memory, chatKey, parsed, ownerActive = false, createNewSkill = false, maxAutoSkills = 10
} = {}) {
  let memories = 0;
  for (const m of parsed?.memories || []) {
    const e = memory.appendSelf(chatKey, m.content, { kind: m.kind, ownerActive });
    if (e) memories += 1;
  }
  const skill = applyAutoSkill(parsed?.skill, { createNewSkill, maxAutoSkills });
  return { memories, skill };
}

/**
 * 跑一次评审。**旁路**调用，结果只落盘。
 *
 * @returns {Promise<{status:string, reason:string, memories:number, skill:string|null}>}
 *   status: ok | nothing-to-save | skipped-no-input | skipped-bad-args | error
 */
export async function reviewConversation({
  memory, chatKey, messages, reasonings, callModel,
  ownerActive = false, maxMemories = 1, createNewSkill = false, maxAutoSkills = 10, maxChars = 6000
} = {}) {
  const no = (status, reason) => ({ status, reason, memories: 0, skill: null });
  if (!memory || !chatKey || typeof callModel !== 'function') {
    return no('skipped-bad-args', '参数不全（memory/chatKey/callModel 缺失）');
  }

  const input = buildAutoReviewInput({
    messages,
    reasonings,
    maxChars,
    selfNotes: typeof memory.selfNotes === 'function' ? memory.selfNotes(chatKey) : [],
    impressions: typeof memory.formatForPrompt === 'function'
      ? memory.formatForPrompt(chatKey, { userIds: null })
      : ''
  });
  if (!input.trim()) return no('skipped-no-input', '没有可复盘的素材（既无思考也无状态）');

  let r;
  try {
    r = await callModel({
      messages: [
        {
          role: 'system',
          content: AUTO_REVIEW_SYSTEM_PROMPT.replace('{MAX_MEMORIES}', String(maxMemories))
        },
        { role: 'user', content: input }
      ],
      maxTokens: 700,
      temperature: 0.2
    });
  } catch (error) {
    const reason = String(error?.message ?? error);
    recordAutoLearnRun({ status: 'error' });
    return no('error', reason);
  }

  const parsed = parseAutoReview(r?.message?.content, { maxMemories });
  const written = applyAutoReview({ memory, chatKey, parsed, ownerActive, createNewSkill, maxAutoSkills });
  if (!written.memories && !written.skill) {
    recordAutoLearnRun({ status: 'nothing' });
    return no('nothing-to-save', '评审认为这一段没有值得留下的内容');
  }
  recordAutoLearnRun({ status: 'ok', memories: written.memories, skill: written.skill });
  return { status: 'ok', reason: '', memories: written.memories, skill: written.skill };
}
