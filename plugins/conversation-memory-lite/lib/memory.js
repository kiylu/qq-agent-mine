// 会话记忆门面：巩固器 + 归档检索器。
//
// 精简版只保留「日块索引 / 旧事检索」这条零注入链路：
//   · 后台按节奏把新消息压成日块索引（模型不知道、也不需要知道）
//   · 模型主动检索（memory.search / memory.archive）时才有成本
// 每轮注入（待办 / 跨轮 / 语义卡 / 跨群）已整体移除 —— 那正是击穿前缀缓存、
// 且与会话延续功能重复的部分。
import { Consolidator } from './consolidator.js';
import { ArchiveReader } from './archive.js';

/**
 * @param {{ messagesDir: string, memoryRoot: string }} paths
 */
export function createConversationMemory(paths) {
  const consolidator = new Consolidator(paths);
  const archive = new ArchiveReader({ messagesDir: paths.messagesDir });

  return {
    consolidator,
    archive,

    /** 模型调用 memory_search。 */
    search(query, opts = {}) {
      return consolidator.search(query, opts);
    },

    /** 后台巩固（可定时）。 */
    consolidate(opts) {
      return consolidator.consolidateAll(opts);
    }
  };
}
