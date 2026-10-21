# 插件主动行为进「会话」页签 —— 核心暴露点方案（2026-10-20）

日期：2026-10-20 ｜ 状态：**已实施（2026-10-21）** ｜ 目标插件：`plugins/silence-ping`（主动私信）

依据：对 `src/sessions.js`、`src/plugin-loader.js`、`src/app.js`、`src/orchestrator.js`、
`src/routes.js`、`ui/app/02-sse-sessions.js` 与 `plugins/silence-ping/index.js` 的实测分析。

---

## 〇、先说结论

**不改插件去"够"核心，而是让核心把「会话登记」这一个能力主动递给插件。**

- 核心新增一个**窄接口** `api.sessions`（只给 `begin()`，返回 `update()/finish()` 句柄），
  由 `createApp()` 装配后随 `loadPlugins()` 注入到每个扩展的 `setup(api)`。
- 插件在"问 AI 之前"开一条会话、在"发完/判断完"收尾。走的是核心**同一条**
  `SessionRegistry.create/update/finish` 路径，因此会话列表、详情、SSE、成本、
  用量统计、删除、热重载全部天然一致，**不需要任何 patch、不需要写文件、不需要轮询等待**。
- 老核心没有 `api.sessions` → 插件 `api.sessions` 为 `null`，自动退回今天的行为（软依赖）。
- 核心侧新增约 **120 行**，插件侧约 **60 行**，文档与测试约 **190 行**。

**为什么不能只改插件**（上一轮已确认，这里只留结论）：会话列表读的是
`SessionRegistry.index` 这个**进程内内存数组**（`src/sessions.js:580`），
实例由 `createApp()` 闭包持有（`src/app.js:662`），没有任何全局引用；
唯一会重扫磁盘的 `reconcileInBackground()` 只在启动跑一次且有一次性闸
（`src/sessions.js:260-262`）；也没有任何 HTTP 接口能创建会话
（`/api/chats/:key/wake` 已返回 410，`src/routes.js:2003-2005`）。
插件只写 `data/sessions/*.json` 的话，当次运行列表不会刷新，只能等下次重启。

---

## 一、方案总览

```
silence-ping                         核心（createApp 闭包内）
────────────                         ─────────────────────────
api.sessions.begin({...}) ────────►  createPluginSessions()
  │                                    │ sessions.create()  ──► SessionRegistry.index（列表可见）
  │                                    │ emit('session-start')
  │ ◄────────── handle { id, update, finish }
  │
  ├─ askAI()  ──► llm.chatCompletion（原有路径，不变）
  │
  └─ handle.finish({...}) ─────────►  sessions.finish()   ──► 落盘 + 索引 + 成本 + 今日用量
                                       emit('session-end') ──► SSE → 会话页实时刷新
```

关键点：**句柄由核心创建、由核心收尾**，插件只负责"什么时候开始、结果是什么"。
插件拿不到 `SessionRegistry` 本体，因此不能 `remove()` / `clearFinished()` / 篡改别人的会话。

---

## 二、核心改动

### 2.1 新增 `src/plugin-sessions.js`（约 90 行）

一个纯装配层，把"会话生命周期 + SSE + 用量口径"收在一处，避免每个插件各写一遍。

```js
// 插件会话桥：把"插件自己调模型、自己发消息"记成会话页里的一条正常会话。
//
// 为什么需要桥而不是直接把 SessionRegistry 给插件：
//   ① 插件不该能删别人的会话（remove/clearFinished 不暴露）；
//   ② SSE 广播（emit）只在 createApp 闭包里，插件拿不到；
//   ③ 用量/成本口径（addUsage + vendorOfConfig）必须在核心算，插件各写一份必然漂移。
import { addUsage, emptyUsage } from './llm.js';
import { vendorOfConfig } from './model-prices.js';
import { getConfig } from './config.js';

const STATUSES = new Set(['done', 'noreply', 'error', 'aborted']);

export function createPluginSessions({ sessions, emit, log = () => {} } = {}) {
  if (!sessions || typeof emit !== 'function') return null;
  return {
    /**
     * 开一条"插件运行中"的会话。返回句柄；核心不支持/参数非法时返回 null（插件应降级）。
     * trigger 写成 'plugin:<id>' 字符串：与消息触发的数组形态区分，retrySession 据此拒绝重试。
     */
    begin({ chatKey, pluginId = '', triggerSummary = '' } = {}) {
      const key = String(chatKey || '');
      if (!/^(group|private):\d+$/.test(key)) return null;
      let s;
      try {
        s = sessions.create({
          chatKey: key,
          trigger: `plugin:${pluginId || 'unknown'}`,
          triggerSummary: String(triggerSummary || '').slice(0, 120),
          status: 'running'
        });
      } catch (e) {
        log(`[plugin-sessions] 创建会话失败：${e?.message ?? e}`);
        return null;
      }
      emit('session-start', { sessionId: s.id, chatKey: key, status: 'running', triggerSummary: s.triggerSummary });

      let closed = false;
      return {
        id: s.id,
        /** 运行中刷新（可选）：activity 会显示在会话卡片上。 */
        update(patch = {}) {
          if (closed) return;
          const live = sessions.current.get(s.id);
          if (!live) return;
          if (patch.activity !== undefined) live.activity = String(patch.activity);
          sessions.update(s.id);
          emit('session-update', { sessionId: s.id });
        },
        /**
         * 收尾。幂等：重复调用直接返回。
         * llmResult = llm.chatCompletion 的返回值 —— 用量/模型/渠道/原始响应都由核心从这里取，
         * 插件不需要也不应该自己算 token 与成本。
         */
        finish({ status = 'done', error = null, finishReason = null, text = '',
                 sent = [], llmResult = null, systemPrompt = '', userPrompt = '' } = {}) {
          if (closed) return null;
          closed = true;
          const live = sessions.current.get(s.id);
          if (!live) return null;
          const st = STATUSES.has(status) ? status : 'done';
          live.systemPrompt = String(systemPrompt || '');
          live.userPrompt = String(userPrompt || '');
          live.promptChars = live.systemPrompt.length + live.userPrompt.length;
          live.sent = Array.isArray(sent) ? sent.slice(0, 20) : [];
          live.finishReason = finishReason ? String(finishReason).slice(0, 200) : null;
          live.error = error ? String(error).slice(0, 500) : null;
          if (llmResult) {
            live.usage = addUsage(emptyUsage(), llmResult.usage);
            live.usage.calls = 1;
            live.model = String(llmResult.model || '');
            const usedApi = llmResult._usedApi || getConfig()?.api || {};
            live.vendor = vendorOfConfig({ api: usedApi, providers: getConfig()?.providers }) || '';
            // raw 必须有：用量页的"逐次调用行"与遥测的 calls 都靠 messages[].raw.usage
            live.messages = [{ role: 'assistant', content: String(text || ''), raw: llmResult.raw ?? null }];
          }
          sessions.finish(s.id, st);
          emit('session-end', {
            sessionId: s.id, chatKey: key, status: st,
            sent: live.sent.length, finishReason: live.finishReason, usage: live.usage
          });
          return s.id;
        }
      };
    }
  };
}
```

**为什么 `finish` 里要写 `messages[].raw`**：`src/app.js` 的 `parseUsageSessionFile()`
（`src/app.js:1816-1837`）优先按每条 `messages[].raw.usage` 生成"逐次调用行"；
`#bumpTodayUsage()`（`src/sessions.js:644-647`）也用同样的口径数 `llmCalls`。
少了 `raw` 就只能退化成会话级聚合，用量页与遥测的"调用次数"会与真实 API 调用数脱节。

### 2.2 `src/plugin-loader.js`：把 `sessions` 透传到 `setup(api)`

四处签名，全部带默认值（保证现有调用点不用改）：

| 位置 | 改动 |
|---|---|
| `createSkillApi(skillId, permissions = [], { sessions = null } = {})`（:80） | 返回值加 `sessions` 字段 |
| `loadSkillDir(dir, { log, kind, sessions = null })`（:211） | 传给 `createSkillApi`（:341） |
| `loadSkillRoot(rootDir, { log, label, sessions = null })`（:470） | 传给 `loadSkillDir`（:489） |
| `loadPlugins({ log, roots, sessions = null })`（:501） | 传给两个 `loadSkillRoot`（:505-506） |
| `watchPlugins({ log, onReload, roots, sessions = null })`（:546） | 传给它内部那次 `loadPlugins`（:561） |

> ⚠️ `watchPlugins` 内部会**自己再调一次** `loadPlugins`（`src/plugin-loader.js:561`）。
> 漏掉这一处的话，热重载后新实例拿到的 `api.sessions` 会变回 `null` ——
> 表现是"改一下插件文件，会话记录就悄悄停了"，属于本方案最容易踩的坑。

`api` 对象里新增的字段：

```js
    // 会话桥（可选）：核心没提供时为 null。插件必须写成 api.sessions?.begin?.(...) 的降级形态。
    sessions,
```

### 2.3 `src/app.js`：装配并注入

```js
import { createPluginSessions } from './plugin-sessions.js';
```

在 `emit`（:611）与 `sessions`（:662）都已存在之后、`reloadSkills`（:1648）之前创建：

```js
  // 插件会话桥：让插件自己发起的运行也能出现在「会话」页签（含用量与成本）。
  const pluginSessions = createPluginSessions({ sessions, emit, log });
```

两处注入：

```js
    const result = await loadPlugins({ log, sessions: pluginSessions });          // :1649
    ...
    pluginWatcher = watchPlugins({ log, sessions: pluginSessions, onReload: ... }); // :1663
```

`createApp()` 的返回对象（:1703）**不需要**加东西 —— 桥只给插件用。

### 2.4 `src/sessions.js`：摘要里补 `triggerKind`

现在 `#summary()` 把 `trigger: s.triggerSummary`（:328），UI 拿到的其实是**摘要文本**，
不是触发类型 —— 所以 `renderSessionDetail` 里 `s.trigger === 'proactive'`（:590）
本来就是一段永远不成立的死代码。本方案顺手补上：

```js
      triggerKind: typeof s.trigger === 'string' ? s.trigger : 'message',
```

用途：① UI 据此隐藏插件会话的「重试」按钮；② 详情页可以显示"插件主动"而不是"-"。

### 2.5 `src/orchestrator.js`：`retrySession` 拒绝插件会话

`retrySession()`（:139-166）对 `error` 且未发过消息的会话会
`store.markUnreadInWindow()` + `scheduleWake()` —— 对插件会话这是**错的**：
它会让核心重新唤醒这个聊天并生成一次普通回复，等于重复发言。

在 `if (s.status !== 'error')` 之后加一行：

```js
    if (typeof s.trigger === 'string' && s.trigger.startsWith('plugin:')) {
      return { ok: false, reason: '插件记录的会话不能重试（它不由消息触发）' };
    }
```

### 2.6 `ui/app/02-sse-sessions.js`：隐藏插件会话的重试按钮

列表的重试按钮条件是 `s.status === 'error' && !(s.sent && s.sent.length)`（:402）。
补一个条件即可（否则用户点下去只会收到 409）：

```js
    const retryHtml = s.status === 'error' && !(s.sent && s.sent.length)
      && !String(s.triggerKind || '').startsWith('plugin:')
      ? `...` : '';
```

可选（同一处顺手做）：详情页 `触发：${esc(s.triggerSummary || (s.triggerKind === 'plugin:silence-ping' ? '插件主动' : '-'))}`。

---

## 三、插件侧改动（silence-ping）

### 3.1 新增设置 `recordSessions`

`DEFAULTS`（:120）、`plugin.json` 的 `settings`（:17）与 `configSchema`（"发送限制"组）各加一项：

| 键 | 默认 | 说明 |
|---|---|---|
| `recordSessions` | `true` | 在「会话」页签里留一条记录（token 会一并计入用量页） |

关掉时插件行为与今天完全一致。

### 3.2 `askAI()` 改为返回结构化结果（:1067-1085）

现在是"只返回 decision"，改成一个对象，**保持对 `internals.aiOverride` 的兼容**：

```js
async function askAI(pick, chatKey, s, now) {
  if (typeof internals.aiOverride === 'function') {
    const r = await internals.aiOverride(pick, chatKey, s, now);
    // 老替身返回 decision 本体；新替身可以返回 { decision, text, res, systemPrompt }
    return (r && typeof r === 'object' && r.decision) ? r : { decision: r };
  }
  const llm = await import('../../src/llm.js');
  const systemPrompt = buildPrompt(pick, chatKey, s, now);
  const userPrompt = '现在要不要主动发私信？按约定的 JSON 输出。';
  const res = await llm.chatCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.9,
    maxTokens: OUT_MAX_TOKENS,
    skillContext: { thinkingMode: 'off' }
  });
  const raw = res?.message?.content;
  const text = Array.isArray(raw) ? raw.map((x) => x?.text ?? '').join('') : String(raw ?? '');
  return { decision: parseDecision(text), text, res, systemPrompt, userPrompt };
}
```

### 3.3 `runCycle()` 里埋点（:1384-1446）

在"问 AI"之前开会话，在四个出口收尾。**所有调用都用可选链，核心没提供时行为不变**：

```js
      const run = (s.recordSessions === false) ? null : (api?.sessions?.begin?.({
        chatKey,
        pluginId: 'silence-ping',
        triggerSummary: `主动私信 · ${cand.lastIncoming?.senderName || chatKey}`
      }) || null);

      let asked;
      try {
        asked = await askAI(cand, chatKey, s, Date.now());
      } catch (e) {
        run?.finish({ status: 'error', error: `问 AI 失败：${e?.message ?? e}` });
        // …原有错误处理不变
      }
      const decision = asked.decision;
      const common = {
        text: asked.text,
        llmResult: asked.res,
        systemPrompt: asked.systemPrompt,
        userPrompt: asked.userPrompt
      };
```

四个出口的映射：

| 出口 | `status` | 其它字段 |
|---|---|---|
| AI 说**不发**（:1394） | `noreply` | `finishReason: decision.reason \|\| 'AI 判断不用发'`，`sent: []` |
| **演练模式**（:1410） | `noreply` | `finishReason: '演练模式：本来要发「…」'`，`sent: [{type:'text', text, at}]` |
| **发送失败**（:1434） | `error` | `error: '发送失败：' + sent.reason`，`sent: []` |
| **发送成功**（:1442） | `done` | `sent: [{ type: 'text', text, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) }]` |

`at` 的格式与 `src/tools.js:186` 里 `session.sent` 的写法保持一致（详情页直接渲染它）。

> 边界：如果 `askAI` 与 `sendPrivate` 之间抛了意料外的错，`run` 会停在 `running`。
> 建议把这一段包进 `try { … } finally { if (!closed) run?.finish({ status: 'aborted' }) }`；
> 兜不住也只是重启时被 `#reclaimZombies()`（`src/sessions.js:186-207`）标成 aborted，
> 不会污染列表。

### 3.4 版本与文档

- `BUILD_TAG` → `v1.6.0`，`plugin.json` 的 `version` → `1.6.0`。
- `README.md` 加一节「会话页签与花费」：说明主动判断会在会话页留一条记录、
  这条记录里的 token 会进用量页；关掉 `recordSessions` 可恢复旧行为。

---

## 四、行为变化与副作用（评审时重点看）

| 变化 | 说明 | 处置 |
|---|---|---|
| **用量页/状态栏数字变大** | 插件的 LLM 调用此前完全不计入，现在会计入 `usage-today.json` 与遥测 `calls` | 预期内；这也是"省 token"设置第一次真正可见 |
| **会话卡片出现"运行中"** | 一次判断通常几秒；UI 的 `autoFollowRunning` 可能把当前选中切过去 | 可接受；如介意，可只在 `finish` 时才建会话（但会丢掉"运行中"的真实性） |
| **中止按钮点了会 409** | 插件会话不在 `activeRuns`/`pendingSessions` 里 | 已知限制；运行窗口很短，暂不处理 |
| **`keepSessionFiles` 会清理它们** | 与普通会话同等待遇 | 正确 |
| **删除按钮可用** | `remove()` 对插件会话照常工作 | 正确 |
| **热重载后记录消失** | 若漏传 `watchPlugins` 的 `sessions` 参数 | 见 2.2 的 ⚠️，测试要覆盖 |
| **多实例（`QQ_AGENT_PROFILE=2`）** | 每个核心实例有自己的 `sessions`，插件按自己进程的 DATA_DIR 工作 | 天然正确 |

---

## 五、兼容性

| 组合 | 结果 |
|---|---|
| 新核心 + 新插件 | 会话可见，用量计入 |
| 新核心 + 老插件 | 完全不受影响（老插件不碰 `api.sessions`） |
| 老核心 + 新插件 | `api.sessions` 为 `undefined` → 可选链短路，行为与今天一致 |
| 测试/无头环境 `loadPlugins({ log })` | 不传 `sessions` → `api.sessions === null`，现有 4 处调用点（`test/skill-test.mjs:313`、`test/tools-skill-audit.mjs:55`、`test/coverage-e2e.mjs:598/645/647/683/686`）无需改动 |

清单 `apiVersion` 不变：这是**追加**能力，不改变既有语义。

---

## 六、测试计划

### 新增 `test/plugin-session-test.mjs`（约 150 行）

沿用 `test/session-cost-e2e.mjs` 的隔离写法（`QQ_AGENT_DATA_DIR` 必须在 import `src/config.js` 之前设好）：

1. `createApp({ log: () => {} })` + `start(0)`；
2. 用 `createPluginSessions({ sessions: app.sessions, emit: app.emit })` 造一条：
   `begin({ chatKey: 'private:10001', pluginId: 'silence-ping' })`
   → `update({ activity: '判断中' })`
   → `finish({ status: 'done', text: '{"send":true,...}', sent: [{type:'text', text:'在吗', at:'20:01:02'}], llmResult: { usage: {...}, model: 'deepseek-v4-flash', raw: { usage: {...}, model: '...' } } })`；
3. 断言：
   - `GET /api/sessions` 里出现该条，`status === 'done'`、`triggerKind === 'plugin:silence-ping'`、`cost != null`；
   - `GET /api/sessions/:id` 的 `systemPrompt/userPrompt/sent/messages` 都在，`cost` 与列表一致；
   - `GET /api/status` 的 `usage.runs` 增加 1（`#bumpTodayUsage` 生效）；
   - `POST /api/sessions/:id/retry` 返回 409 且 reason 含"插件"；
   - `DELETE /api/sessions/:id` 成功，列表里消失；
4. `loadPlugins` 注入验证：临时 `plugins/` 目录放一个 fixture 插件，
   `setup(api)` 里断言 `typeof api.sessions?.begin === 'function'` 并造一条；
   再以**不带 `sessions`** 的方式 `loadPlugins`，断言 `api.sessions === null`；
5. 热重载路径：`watchPlugins({ sessions })` 的 `onReload` 走一次，断言新实例仍拿得到桥。

### 回归

- `npm test` 全量（重点：`skill-test`、`coverage-e2e`、`session-cost-test`、`usage-e2e`）；
- 手动：启用 silence-ping（`dryRun: true`）→ 等一轮醒来 → 会话页应出现"未回复/演练"记录，
  用量页 token 增加；关闭 `recordSessions` 后不再出现。

---

## 七、文档更新

| 文件 | 内容 |
|---|---|
| `doc/extend_development/plugin-development.md` §6 | API 表加 `api.sessions` 一行 + 新增小节「6.1 会话桥（begin/finish）」 |
| `doc/extend_development/skill-reference.md` §4 | 同上（两份文档共用同一套 API 说明） |
| `plugins/silence-ping/README.md` | 「会话页签与花费」一节 + FAQ |
| `plugins/silence-ping/plugin.json` | `recordSessions` 设置项 + 版本号 |

---

## 八、不做的事

- **不暴露 `SessionRegistry` 本体**（`remove/clearFinished/reconcile` 一律不给插件）。
- **不新增 HTTP 接口**：插件与核心同进程，没必要绕一圈，也避免给本地端口开写入口。
- **不做事件总线**：`src/app.js:611` 已说明进程内事件总线"全项目没有订阅者"，继续只用 SSE。
- **不改 `sessions.js` 的存储格式**：新增字段只有 `triggerKind`（只在摘要里，不落盘）。
- **不做插件会话的"中止"**：运行窗口只有一次 LLM 调用，收益低于复杂度。

---

## 九、改动量与实施顺序

| 步骤 | 文件 | 行数（估） |
|---|---|---|
| 1 | `src/plugin-sessions.js`（新增） | ~90 |
| 2 | `src/plugin-loader.js`（4 处签名 + 1 处内部调用） | ~12 |
| 3 | `src/app.js`（import + 装配 + 2 处注入） | ~5 |
| 4 | `src/sessions.js`（`triggerKind`） | 1 |
| 5 | `src/orchestrator.js`（重试守卫） | 3 |
| 6 | `ui/app/02-sse-sessions.js`（隐藏重试按钮） | 2 |
| 7 | `plugins/silence-ping/index.js`（askAI + runCycle + 设置） | ~60 |
| 8 | `plugins/silence-ping/plugin.json` + `README.md` | ~20 |
| 9 | `test/plugin-session-test.mjs`（新增）+ `package.json` test 链 | ~150 |
| 10 | 两份开发文档 | ~40 |

建议按 1→6 先落核心（此时无插件使用，零行为变化），跑一遍 `npm test`；
再按 7→9 接插件与测试；最后补文档。

---

## 十、待确认的决策点

1. **`recordSessions` 默认开还是关？** 建议**开** —— 这是用户第一次能在会话页看到
   "它为什么开口/为什么没开口"，也是排查插件行为最直接的入口；不想要的人可以关。
2. **失败的主动私信记 `error` 还是 `noreply`？** 建议 `error`（详情页能直接看到原因），
   同时按 2.5/2.6 拒绝重试并隐藏按钮。
3. **插件 token 是否计入用量页？** 建议计入。否则"省 token"旋钮（`personaMaxChars`）
   的效果永远无法从账面上验证；代价是历史用量曲线会出现一次台阶（属于口径修正）。
