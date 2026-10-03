// 会话记忆 · 精简版（确定性型 / plugins/）
//
// ── 这一版为什么叫"精简" ─────────────────────────────────────────────────
// 上游 07-conversation-memory 魔改包有两块功能：
//   ① 后台按节奏把新消息压成日/时块索引 —— 零注入，只有模型主动检索时才花 token
//   ② 每轮往提示词里注入短片段（待办 / 跨轮 / 语义卡 / 跨群）
//
// ② 是**击穿前缀缓存**的元凶：它原地改写既有 system 消息，而内容每轮都在变，
// 于是整个 messages 前缀失效、被迫全价重算，且不会触发本工程的 fresh 逻辑
// （缓存命中率骤降、成本成倍）。而且它的作用（"上一轮想到哪了"）与本工程的
// **会话延续**高度重复 —— 延续已经把思考链跨轮保留下来了，做得更好也更省。
//
// 所以精简版**只保留 ①**：
//   · 后台定时把 data/messages 增量压成小时块（模型不知道，也不收钱）
//   · 模型主动调 memory_search / memory_archive 时才检索
//   · 不再挂任何 before-llm-messages / before-context 注入钩子
// 结果：缓存影响体检从 danger 归零为 ok，且检索能力照旧。
//
// ── 与核心的关系（零侵入）────────────────────────────────────────────────
// 全部通过 hooks 连线，没有改一行核心代码：
//   activate / deactivate  起停后台巩固定时器
// 检索能力经 providers 暴露给 skills/memory-recall/ 里的模型工具消费。
//
// 模型主动检索（memory_search / memory_archive）属于另一型 —— 注册工具、
// 由模型决定何时调用，放在 skills/memory-recall/：那里通过这里暴露的
// memory.search / memory.archive 能力取用实现。关掉本插件 → 检索工具自动
// 显示「依赖未就绪」；只留本插件 → 索引照常巩固，只是模型不能主动翻旧账。

import path from 'node:path';
import { DATA_DIR } from './lib/env.js';
import { createConversationMemory } from './lib/memory.js';

/** 出厂默认值（与 plugin.json 的 settings 保持一致，改一处要改两处）。 */
const DEFAULTS = {
  enabled: true,
  consolidateIntervalMin: 10
};

let api = null;
let mem = null;
let timer = null;
let consolidating = false;

/** 当前设置（插件默认值 ← 用户在设置页改过的值）。 */
function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** 单例：巩固器与检索器必须共用同一份索引，否则搜到的和刚写的对不上。 */
function instance() {
  if (!mem) {
    mem = createConversationMemory({
      messagesDir: path.join(DATA_DIR, 'messages'),
      memoryRoot: path.join(DATA_DIR, 'memory-v2')
    });
  }
  return mem;
}

/**
 * 跑一次增量巩固。
 *
 * 重入保护：定时器与首跑都可能触发，两个巩固同时写索引会互相覆盖。
 * 失败只打日志 —— 记忆是增强功能，坏了也绝不能让主流程陪葬。
 */
function consolidate(why) {
  if (consolidating) return;
  if (settings().enabled === false) return;
  consolidating = true;
  try {
    const results = instance().consolidate({ force: false }) || [];
    const added = results.reduce((sum, r) => sum + (Number(r?.added) || 0), 0);
    if (added > 0) {
      api.log(`巩固（${why}）：+${added} 条，索引 ${JSON.stringify(instance().consolidator.stats())}`);
    }
  } catch (error) {
    api.warn('巩固失败：', error?.message ?? error);
  } finally {
    consolidating = false;
  }
}

export function setup(a) {
  api = a;
}

/** 生效：起后台巩固。首跑延迟 8 秒，别和启动抢 IO。 */
export function activate() {
  if (settings().enabled === false) return;
  const everyMin = Math.max(1, Number(settings().consolidateIntervalMin) || 10);
  timer = setInterval(() => consolidate('tick'), everyMin * 60000);
  timer.unref?.();
  const boot = setTimeout(() => consolidate('boot'), 8000);
  boot.unref?.();
  api.log(`会话记忆（精简版）已启用：间隔 ${everyMin} 分钟，零注入，数据根 ${DATA_DIR}`);
}

/** 关闭：停掉定时器。已生成的索引留在磁盘上，重新启用即复用。 */
export function deactivate() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 能力：给 skills/memory-recall/ 的检索工具用。
 * 返回统一形状 `{ ok, ... }`，不抛错 —— 调用方是模型工具，抛错只会变成一句难懂的话。
 */
export const providers = {
  'memory.search': (args = {}) => {
    const query = String(args?.query ?? '').trim();
    if (!query) return { ok: false, hits: [], error: '缺少检索关键词' };
    try {
      const hits = instance().search(query, {
        chatKey: args?.chatKey || null,
        limit: Math.min(12, Math.max(1, Number(args?.limit) || 5)),
        maxSnippets: 5
      });
      return { ok: true, hits };
    } catch (error) {
      return { ok: false, hits: [], error: String(error?.message ?? error) };
    }
  },

  'memory.archive': (args = {}) => {
    try {
      const archive = instance().archive;
      const chatKey = args?.chatKey || null;
      const mode = String(args?.mode || 'list');
      if (mode === 'list') return { ok: true, chatKey, days: archive.listDays(chatKey, { limit: 30 }) };
      if (mode === 'count') {
        return {
          ok: true,
          ...archive.count({
            chatKey,
            query: args?.query,
            day: args?.day || null,
            dayFrom: args?.dayFrom || null,
            dayTo: args?.dayTo || null,
            maxSamples: 8
          })
        };
      }
      return {
        ok: true,
        ...archive.load({
          chatKey,
          day: args?.day,
          dayFrom: args?.dayFrom,
          dayTo: args?.dayTo,
          offset: args?.offset,
          limit: args?.limit,
          query: args?.query
        })
      };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },

  'memory.status': () => {
    try {
      return { ok: true, index: instance().consolidator.stats() };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};

// 精简版不再挂任何 hooks：没有 before-context / before-llm-messages / after-response，
// 即不做每轮注入、不写跨轮状态、不记成本 —— 这些都是缓存击穿源或已由会话延续覆盖。
export const hooks = {};
