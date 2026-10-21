// 插件会话桥：把"插件自己调模型、自己发消息"的运行记成「会话」页签里的一条正常会话。
//
// 为什么需要它（2026-10-20 实测）：
//   会话页的数据源是 SessionRegistry.index 这个**进程内内存数组**，实例由
//   createApp() 闭包持有，插件没有任何正规途径能拿到它；唯一会重扫磁盘的
//   reconcileInBackground() 只在启动跑一次且有一次性闸，也没有任何 HTTP 接口
//   能创建会话。于是"插件自己问 AI、自己发消息"这件事在会话页里完全不可见，
//   连它花的 token 都不进用量页。
//
// 为什么不直接把 SessionRegistry 交给插件：
//   ① 插件不该能删别人的会话（remove / clearFinished / reconcile 一律不暴露）；
//   ② SSE 广播（emit）只在 createApp 闭包里，插件拿不到 —— 没有它，会话页
//      要等下一次轮询（默认 15 秒）才看得到；
//   ③ 用量与成本口径（addUsage + vendorOfConfig）必须在核心算一份，
//      每个插件各写一遍必然漂移成"会话卡片一个数、用量页另一个数"。
//
// 契约（插件侧必须按这个用法写）：
//   const run = api.sessions?.begin({ chatKey, pluginId, triggerSummary });   // 可能为 null
//   run?.update({ activity: '正在判断…' });
//   run?.finish({ status, text, sent, llmResult, systemPrompt, userPrompt });
//   老核心没有 api.sessions → 可选链短路，插件行为与没有这个能力时完全一致。

import { addUsage, emptyUsage } from './llm.js';
import { vendorOfConfig } from './model-prices.js';
import { getConfig } from './config.js';

// finish() 接受的终态。waiting/running 是过程态，不允许由插件直接写。
const FINAL_STATUSES = new Set(['done', 'noreply', 'error', 'aborted']);

// sent 条目最多留几条（与核心 send_to 工具同量级即可，多出来的对 UI 没意义）
const MAX_SENT = 20;

/**
 * 造一个会话桥。
 *
 * @param {object} deps
 * @param {import('./sessions.js').SessionRegistry} deps.sessions 核心的会话注册表（唯一的写入口）
 * @param {(type: string, payload: object) => void} deps.emit   SSE 广播（createApp 闭包里的那个）
 * @param {(msg: string) => void} [deps.log]
 * @returns {{begin: Function}|null} 缺少依赖时返回 null —— 插件据此自动降级
 */
export function createPluginSessions({ sessions, emit, log = () => {} } = {}) {
  if (!sessions || typeof sessions.create !== 'function' || typeof emit !== 'function') return null;

  return {
    /**
     * 开一条"插件运行中"的会话。
     *
     * trigger 写成字符串 `plugin:<id>`：与消息触发的**数组**形态区分开。
     * orchestrator.retrySession() 据此拒绝重试（插件会话没有"触发批"可翻回未读，
     * 重试会让核心凭空唤醒这个聊天再回一遍）。
     *
     * @returns {{id: string, update: Function, finish: Function}|null}
     *          参数非法/创建失败返回 null（插件应照常继续，只是不记录）
     */
    begin({ chatKey, pluginId = '', triggerSummary = '' } = {}) {
      const key = String(chatKey || '');
      if (!/^(group|private):\d+$/.test(key)) {
        log(`[plugin-sessions] 会话键不合法，跳过记录：${key || '(空)'}`);
        return null;
      }
      let session;
      try {
        session = sessions.create({
          chatKey: key,
          trigger: `plugin:${pluginId || 'unknown'}`,
          triggerSummary: String(triggerSummary || '').slice(0, 120),
          status: 'running'
        });
      } catch (error) {
        log(`[plugin-sessions] 创建会话失败：${error?.message ?? error}`);
        return null;
      }
      emit('session-start', {
        sessionId: session.id,
        chatKey: key,
        status: 'running',
        triggerSummary: session.triggerSummary
      });

      let closed = false;

      /** 取活对象。finish() 之后 current 里就没有了，返回 null 让调用方安静跳过。 */
      const liveOf = () => sessions.current?.get?.(session.id) || null;

      return {
        id: session.id,

        /**
         * 运行中刷新（可选）。activity 会显示在会话卡片上（"正在判断…"这类）。
         * 只允许改展示字段：状态、用量、发送记录一律由 finish() 定稿。
         */
        update(patch = {}) {
          if (closed) return;
          const live = liveOf();
          if (!live) return;
          if (patch.activity !== undefined) live.activity = String(patch.activity ?? '');
          sessions.update(session.id);
          emit('session-update', { sessionId: session.id });
        },

        /**
         * 收尾。幂等：重复调用直接返回第一次的结果。
         *
         * llmResult 传 llm.chatCompletion() 的**原始返回值**即可 —— 用量、模型、
         * 渠道、原始响应全部由核心从这里取。插件不要自己算 token 与成本：
         * 价格表会变，且"渠道：模型"的归并规则只在 model-prices.js 有一份。
         *
         * @param {object} opts
         * @param {'done'|'noreply'|'error'|'aborted'} [opts.status]
         * @param {string|null} [opts.error]
         * @param {string|null} [opts.finishReason] 给 UI 看的一句话（为什么没发/为什么失败）
         * @param {string} [opts.text]              模型原始输出（进 messages，详情页可见）
         * @param {Array<{type:string,text:string,at?:string}>} [opts.sent] 实际发出的消息
         * @param {object|null} [opts.llmResult]    chatCompletion 的返回值
         * @param {string} [opts.systemPrompt]
         * @param {string} [opts.userPrompt]
         * @returns {string|null} 会话 id（已关闭/对象不存在时返回 null）
         */
        finish({
          status = 'done',
          error = null,
          finishReason = null,
          text = '',
          sent = [],
          llmResult = null,
          systemPrompt = '',
          userPrompt = ''
        } = {}) {
          if (closed) return null;
          closed = true;
          const live = liveOf();
          if (!live) return null;

          live.systemPrompt = String(systemPrompt || '');
          live.userPrompt = String(userPrompt || '');
          live.promptChars = live.systemPrompt.length + live.userPrompt.length;
          live.sent = Array.isArray(sent) ? sent.slice(0, MAX_SENT) : [];
          live.finishReason = finishReason ? String(finishReason).slice(0, 200) : null;
          live.error = error ? String(error).slice(0, 500) : null;

          if (llmResult) {
            live.usage = addUsage(emptyUsage(), llmResult.usage);
            live.usage.calls = 1;
            live.model = String(llmResult.model || '');
            // 渠道与模型必须同源：只记 model 会让"渠道：模型"的成本报表把这次
            // 调用算到当前配置的渠道名下，而它可能来自备选端点（同 orchestrator:1152）。
            const usedApi = llmResult._usedApi || getConfig()?.api || {};
            live.vendor = vendorOfConfig({ api: usedApi, providers: getConfig()?.providers }) || '';
            // ⚠️ raw 必须带上：用量页的"逐次调用行"（app.js · parseUsageSessionFile）
            //    和遥测的 calls 计数（sessions.js · #bumpTodayUsage）都读
            //    messages[].raw.usage —— 少了它就只能退化成会话级聚合，
            //    "调用次数"会与真实 API 调用数脱节。
            live.messages = [{
              role: 'assistant',
              content: String(text || ''),
              raw: llmResult.raw ?? null
            }];
          }

          const finalStatus = FINAL_STATUSES.has(status) ? status : 'done';
          // finish 会落盘、从 current 移除、刷新索引摘要（含现算的成本）
          sessions.finish(session.id, finalStatus);
          emit('session-end', {
            sessionId: session.id,
            chatKey: key,
            status: finalStatus,
            sent: live.sent.length,
            finishReason: live.finishReason,
            usage: live.usage
          });
          return session.id;
        }
      };
    }
  };
}
