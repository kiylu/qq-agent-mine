# 实施记录：问题①（缓存）走 B + 剥离 raw

日期：2026-10-03
依据：`doc/change-plan-2026-10-03.md` §一
状态：**已实施并通过回归**

---

## 改了什么

### 1. `src/prompt.js` —— 段落重排（核心）

**新顺序**：
```
【角色设定】→【引导说明】→【已读信息】→【新已读信息】→【记忆】
           →【未读信息】→【活跃模式】→【可用表情包】→【当前时间】
```

稳定前缀 = **系统提示 + 角色设定 + 引导说明 + 已读信息**（最后一项由锚点保证字节不变）。

- 【记忆】从"已读信息之前"挪到"之后"：它原本的成员顺序吃 `updatedAt`、内容随新印象增长，**一次 `remember_member` 就能把后面整块（已读信息，token 大头）踢出缓存**。
- 【可用表情包】从"第 2 段"挪到尾部：它的选中集合受 `useCount` 影响，且每 60 分钟按轮次洗牌。
- 引导说明新增一行：`- 对群友的印象见下方【记忆】段；本会话可用的表情包列表见下方【可用表情包】段。`
- 记忆成员口径统一为"本轮展示的已读条目 + 触发批里出现的人"（原本 anchored/标准 两套口径）。
- **删除【新加入成员】段**（记忆已不在前缀里，该补丁失去意义）。
- `resolvePromptAnchor`：删 `memberIds` / `newUserIds` / `hasNewMember→reset`；`anchor` 收敛为 `{readIds, readCount}`；删掉不再使用的 `collectMemberIds()`。

### 2. `src/config.js`

`promptAnchor.maxExtraRead`：`5 → 15`。
原值太小 —— 群里稍热闹（两次触发间新增 >5 条）就整体 reset，日常"新对话"几乎必然落到滑动窗口，锚点形同没开。

### 3. `src/orchestrator.js` —— 剥离 `raw`

发给 API 的 `messages` 里的 assistant 条目**不再带 `raw`**（原始响应体）。
原因：多轮工具调用时每一轮请求都会把历史助手条目再发一遍，带上 `raw` 等于把之前所有轮次的完整响应重复上传 —— 请求体无谓膨胀，且这些字节随每轮响应变化，白白干扰缓存。
`raw` 只留在 `session.messages`（UI / 排障用；已确认 `ui/` 与 `routes.js` 没有任何读点，不破坏现有功能）。

### 4. 测试同步

- `test/test-prompt.mjs`：段序断言改为新顺序，并新增"稳定前缀里不得出现会自己变的段"（【记忆】【可用表情包】必须在【已读信息】之后）。
- `test/prompt-anchor-test.mjs`：
  - `prefixOf()` 前缀起点从【记忆】改为【已读信息】；
  - **场景 F 断言反转**：新群友加入不再导致 reset（走 B 之后记忆不进前缀）；
  - 删 `memberIds` 断言；场景 H 的滑窗改为 `G,H,I,J,K`（原 `IJKLM` 里的 L/N 已随场景调整不再存在）；
  - `runOnce()` 支持传 `stickerEntries`；
  - **新增场景 I（缓存杀手回归）**：两轮之间写一条新记忆 + 换一批表情，断言「已读信息」稳定前缀**逐字节一致** —— 这条在改动前必然失败、改动后必须通过。

---

## 验证结果

| 套件 | 结果 |
|---|---|
| `test/test-prompt.mjs` | ✅ 通过 |
| `test/prompt-anchor-test.mjs` | ✅ 通过（含新增场景 I） |
| `test/wake-semantics-test.mjs` | ✅ 10/10 |
| `npm test`（全量） | 84 通过 / **1 失败（预存，与本次无关）** |
| `npm run test:coverage` | 离线 148/0 ✅、HTTP 116/0 ✅、端到端 44/0 ✅、静态界面 20/**1 失败（预存）** |
| `test/coverage-wiring.mjs` | ✅（jsdom 未安装，按设计跳过） |

**两处失败均为预存问题**（已用 `git stash` 在原始代码上复现确认）：
1. `test/setup-qq-version.mjs` —— `--check 会报告协议栈的 CLIENT_BUILD`：本机没有 `snowluma/` 目录（需 `npm run setup` 下载），与环境有关。
2. `test/coverage-ui.mjs` —— `landing.html 的下载链接带版本号`：`ui/landing.html` 里找不到安装包下载链接，与本次改动无关。

---

## 环境备注

- 本工作树原先**没有 `node_modules`**，已执行 `npm install`（运行时依赖 `js-yaml` / `undici` / `ws`）。`npm install` 顺带把 `package-lock.json` 的 version 字段从 `0.3.0` 同步成 `0.4.0`，该无关改动**已回滚**。
- `jsdom` 未安装 → `test:coverage` 里的「界面接线」套件按设计自动跳过；要启用：`npm i -D jsdom`。

---

## 下一步

②（沉默为界 / 思考落盘）**P1**：`src/conversation.js` ConversationBuffer（落盘 `data/conversations/`）+ wake 入口 continue/fresh 决策 + continue 只追加增量。

---

# 实施记录：问题② P1（"沉默为界" / 思考链落盘）

状态：**已实施并通过回归**

## 改了什么

### 新增 `src/conversation.js` —— 会话缓冲

按 `chatKey` 维护"活跃会话"，落盘 `data/conversations/<chatKey>.json`：

```
{ chatKey, systemPrompt, toolNames, messages（不含 system、已剥 raw）,
  turns, chars, startedAt, lastTurnAt }
```

- **必须落盘**：不能像 `activeTopics` 那样只放内存 —— 重启即丢会让"沉默为界"退化成"每次全新会话"。
- `resolveSilenceMs(cont, api)`：沉默阈值按渠道自动取值（复用 `thinking.js` 的 `detectDialect`）——
  anthropic 4 / qwen 5 / openai-o 8 / deepseek 60 / gemini 60 / 兜底 5（分钟）。
  `silenceMinutes: null` = 自动，数字 = 强制，`0` = 不按沉默切分。
- `sameToolNames()`：工具集签名比对（顺序无关，集合必须一致）。
- `sweep()`：24 小时无交互的缓冲自动清掉（节流 10 分钟一次），防文件堆积。

### `src/config.js`

新增 `store.continuation = { enabled: true, silenceMinutes: null, maxTurns: 30, maxChars: 240000 }`。

### `src/prompt.js`

新增 `buildContinuationPrompt(ctx)` —— 延续轮的用户消息，**只带增量**：
未读信息 +【记忆】+【活跃模式】+【当前时间】。
不带【已读信息】整窗（那些内容就在同一会话的上下文里，重发=双重计费），
也不带【角色设定】【引导说明】【可用表情包】（同理）。

### `src/orchestrator.js`

- 构造函数新增 `this.conversation = new ConversationStore()`。
- **messages 组装从"提示词之后"移到了"工具集过滤之后"** —— 因为要继续用会话，
  必须先知道本轮工具集是否与缓冲记录的一致（工具定义排在 messages 之前，一变缓存全废）。
- `#runAgent` 里新增**会话延续决策**，四个条件全满足才 `continue`：
  延续开着 + 缓冲在 + `systemPrompt` 逐字节相同 + 工具集相同 + 沉默间隔 ≤ 阈值 + 未超轮次/体积上限。
  任一不满足 → `fresh`，并**清掉旧缓冲**（P2 会在这里蒸馏私有状态）。
  fresh 的原因写进 `session.continuation.reason`，UI/排障能看到"这次为什么没续上"。
- `continue` 时：`[system(缓冲里的原串), ...缓冲 messages, 新增量 user]`，
  并且**主动丢弃该会话的提示词锚点状态** —— 延续轮没发【已读信息】整窗，
  刚才算出来的锚点代表"一个其实没发出去的窗口"，留着会污染下一次 fresh。
- 运行结束把 `messages.slice(1)` 写回缓冲；出错/中止的会话不写（半截状态续下去更乱）。
- 新增对外方法：`listContinuations()` / `continuationFor(chatKey)` / `resetContinuation(chatKey)`。

### `src/routes.js` + `ui/app/04-archive-usage.js`

- `GET /api/continuations`：活跃缓冲总览。
- `GET /api/chats/<kind>_<id>/continuation`：单个会话的缓冲状态。
- `POST /api/chats/<kind>_<id>/new-conversation`：手动**重开会话**（丢弃 LLM 侧对话历史）。
- 存档页工具栏新增「**重开会话**」按钮：点开先拉一次状态，弹**二次确认**
  （弹窗里写明"当前已延续 N 轮 / 会影响什么 / 不影响什么"），确认后调接口。
  会话详情标题右侧同时显示"· 会话延续中：N 轮"。

## 需要同步的旧契约（都改了）

`②P1` 打破了"每次触发 = 全新会话"这个隐含假设，三处旧断言按新语义重写：

| 位置 | 旧断言 | 新语义 |
|---|---|---|
| `test/selftest.mjs` drain 场景 | "drain 运行同样是全新会话（messages.length=2）" | drain **延续**同一会话：以上一轮 messages 逐字节开头 + 只追加增量 |
| `test/selftest.mjs` 引用 / 记忆场景 | 去 `messages[1]` 里找内容 | 延续轮的内容在**增量**里 → 改成逐条 message 找 |
| `test/wake-semantics-test.mjs` | 全窗口语义 | **显式关掉延续**（该套件测的是触发链路语义，定义在全新会话路径上；延续路径由新套件覆盖） |
| `test/coverage-e2e.mjs` 引用场景 | 去 `messages[1]` 里找 | 同上，改成逐条 message 找 |

## 新增测试

- `test/conversation-buffer-test.mjs`（12 项）：缓冲 save/get/clear/list + **落盘可续**、
  按渠道推导沉默阈值、`sameToolNames`、`buildContinuationPrompt` 只带增量不带整窗。
- `test/continuation-e2e-test.mjs`（6 项，端到端）：
  首次 fresh 并建缓冲 → 紧接触发 continuation 且**前缀逐字节一致** → 手动重开会话回到 fresh
  → 沉默超阈值回到 fresh → 软重置后链路自愈。
  沉默阈值用 0.1 分钟（6 秒）在一轮里跑完"连续 vs 沉默"的对比。
- 两个套件已注册进 `npm test`；另加 `npm run test:continuation`。

## 验证结果

| 套件 | 结果 |
|---|---|
| `conversation-buffer-test.mjs` | ✅ 12/12 |
| `continuation-e2e-test.mjs` | ✅ 6/6 |
| `selftest.mjs` | ✅ 41/41 |
| `wake-semantics-test.mjs` | ✅ 10/10 |
| `prompt-anchor-test.mjs` / `test-prompt.mjs` | ✅ 通过 |
| `npm test` 其余各套件 | ✅ 全部通过 |
| `npm run test:coverage` | 离线 148/0 ✅、HTTP 116/0 ✅、端到端 44/0 ✅、静态界面 20/**1（预存）** |

**唯一两处失败都是预存问题**（已用 `git stash` 在原始代码上复现确认，与本次无关）：
1. `test/setup-qq-version.mjs` —— `--check 会报告协议栈的 CLIENT_BUILD`：本机没有
   `snowluma/` 目录（需 `npm run setup` 下载），环境性失败。84 通过 / 1 失败。
2. `test/coverage-ui.mjs` —— `landing.html 的下载链接带版本号`：`ui/landing.html`
   里找不到安装包下载链接，与本次改动无关。

> 顺带发现：`npm test` 的 `&&` 链会在上面第 1 条失败处中断，导致排在它后面的
> 9 个套件（setup-download / qq-pack / qq-process-detect / sender-×2 /
> vendor-mirror / safe-fetch-file / market-zip / web-search-parse）**其实没跑**。
> 这一轮已把它们逐个补跑，**全部通过**。（这是既有行为，不是本次引入的。）

## ⚠️ 需要改的文档

README「技术架构」第 2~4 条要改写 —— 成本模型从「无状态、单次成本恒定」
变成「有界增长、单价靠缓存压住」。**这条还没改**（等 P1 实测确认后再一起改）。

## 下一步（P2）

`closeBuffer` 蒸馏：关会话那一刻（唯一真正握有完整 CoT 的时刻）调一次小模型，
把思考提炼成"私有状态"（未完成目标 / 自己定的规则 / 答案 / 待办），
写进新的自身记忆（`selfNote` + `_self.json` + `remember_self` 工具），
下次 fresh 在易变区注入【自身状态】段。

---

# 实施记录：问题② P2（会话关闭蒸馏 / 自身状态）

状态：**已实施并通过回归**

## 改了什么

### `src/memory.js` —— 自身记忆（selfNote）

- 新增 `_self.json`（每会话一个小文件，位于 `data/memory/<chatKey>/_self.json`），
  格式 `[{ content, createdAt }]`。**与群友印象分开存**，不参与成员合并/整理。
- 新增方法：`appendSelf` / `selfNotes` / `hasSelf` / `clearSelf` / `formatSelfForPrompt`。
  - `appendSelf`：同内容去重；只保留最近 40 条（`max` 可调）——自身状态是"当前有效清单"而非日志。
  - `formatSelfForPrompt`：渲染【自身状态】段；空 → `''`（不注入）。
- **修正**：`#ensureChat` 扫描会话目录时跳过 `_self.json`（原先只跳 `_meta.json`），
  否则会被当成一个"无 QQ 号的成员"混进成员列表。
- `removeChat` 已覆盖 `_self.json`（它删的是目录内全部文件）。

### `src/tools.js` —— 新增 `remember_self` 工具

- 让模型**主动**记自己的状态（进行中的任务、自定规则、谜底、待办）。
- 与 `memory_append` 明确区分：那个记"对群友的印象"，这个记"你自己"。

### `src/prompt.js` —— 注入【自身状态】段 + 引导

- `buildUserPrompt`：在【记忆】之后（同属易变区，不参与稳定前缀）注入【自身状态】。
- `buildContinuationPrompt`：延续轮同样带上（模型可能上轮刚写过）。
- `memoryRules()` 新增两行说明：`remember_self` 的用途；以及"思考不发群里，
  但关键暗牌答案/约定主动落一下更稳"。
- 引导说明补一句指向【自身状态】段。
- 头部注释 + `DISTILL` 相关注释同步新成本模型。

### `src/conversation.js` —— 蒸馏核心

- `collectAssistantText(messages, { maxChars })`：从缓冲里抽 assistant 正文（跳过工具参数），
  这是蒸馏的输入。
- `DISTILL_SYSTEM_PROMPT` + `parseDistillResult(text, { max })`：
  让模型只输出 JSON 数组；解析容错（剥 markdown 围栏、截 `[...]`、对象数组取 `content`、去重、上限 5 条）。
- `distillBuffer({ memory, chatKey, messages, callModel, maxChars })`：
  抽 CoT → 调一次模型 → 写自身记忆；没有可蒸馏文本时不调模型。

### `src/orchestrator.js` —— 接上关闭流程

- 新增私有方法 `#distillAndClose(chatKey, buffer, reason)`：
  **先 `clear` 缓冲，再 fire-and-forget 蒸馏**（不阻塞当前运行）。
  - 用 `this.distilling` 集合防同会话并发重复蒸馏。
  - 结果由 `getConfig().store.continuation.distillOnClose`（默认 true）开关。
  - 成功后 `emit('self-distilled', ...)`，日志可查。
- fresh 分支里把原来的 `this.conversation.clear(chatKey)` 换成 `#distillAndClose(...)`。
  **所有 fresh 原因都覆盖**：沉默超阈值 / systemPrompt 变化 / 工具集变化 / 超轮次 / 超体积 / 首轮无缓冲（无缓冲时直接 clear，不蒸馏）。
- 构造函数新增 `this.distilling = new Set()`。

> **为什么是"下一次"生效**：fresh 分支里 `userPrompt` 在本决策之前就已构造好，
> 所以本轮蒸馏的产物最快在**下一轮 wake** 的提示词构造时被读到 —— 这本就是它
> 的设计意图（为"下次重开"准备）。fire-and-forget 也保证关闭动作不会拖慢当前会话。

### `src/config.js`

`store.continuation` 新增两项：
```
distillOnClose: true,        // 关闭时蒸馏（关闭时不做就永久丢失）
distillMaxChars: 12000       // 蒸馏输入的字符预算
```

### `src/routes.js` + `ui/app/05-memory-settings.js`

- `GET /api/memory-files/<kind>_<id>` 响应新增 `selfNotes`。
- 记忆详情页新增「🪞 自身状态（N 条）」可折叠区块（默认收起，有内容才显示）。

## 新增测试

`test/self-note-test.mjs`（17 项）：
- selfNote 写/读/去重/上限/落盘可读；`_self.json` 不被当群友印象；`clearSelf`。
- `formatSelfForPrompt`：有内容带段名、空返回 `''`。
- `collectAssistantText`：只取 assistant 正文、跳过工具参数与 user、遵守 maxChars。
- `parseDistillResult`：直 JSON / markdown 围栏 / 对象数组 / 非法输入 / 去重 / 上限。
- `distillBuffer`：注入假模型，校验系统提示 + CoT 原文 + 落点；无可蒸馏文本不调模型；空数组不写入。
- 已注册进 `npm test`；另加 `npm run test:self`。

## 验证结果

| 套件 | 结果 |
|---|---|
| `self-note-test.mjs`（新增） | ✅ 17/17 |
| `npm test`（全量链路） | ✅ 全绿（exit 0，0 失败） |
| continuation / prompt / anchor / wake / selftest / audit | ✅ 全部通过 |

## 文档同步

- README「技术架构」第 2~4 条已改写：成本模型从「无状态、单次成本恒定」→
  「**有界增长、单价靠缓存压住**」；能力清单新增"记得住自己的事"。
- `src/prompt.js` 头部注释同步。

## 下一步（P3，未做）

- 媒体瘦身：continue 时把历史 `image_url` 换文字占位，避免图片 token 每轮重发。
- buffer 归档回溯（最近 N 个）。
- UI：会话页显示"延续中（N 轮）"标记 + 「重开会话」按钮已有雏形，可再打磨。

---

# 实施记录：问题② P3（媒体瘦身 / 归档回溯 / UI）

状态：**已实施并通过回归**

## 改了什么

### `src/conversation.js` —— 媒体瘦身 + 归档

- 新增 `slimHistoricalMedia(messages)`（导出，纯函数）：
  把消息 parts 里的 `image_url` / `video_url` 换成一行文字占位
  `[此前看过的一张图片/视频（已省略，避免重复计费）]`，保留伴随的说明文字；
  **连续多张图折叠成一条占位**；瘦身后只剩文本时退回字符串形态（更省字节、更好比对前缀）。
  - 不修改原数组（返回新数组；无媒体时原样返回同一引用）。
- 归档：新增 `ARCHIVE_DIR`（`data/conversations/archive/`）+ `ARCHIVE_KEEP=10`。
  - `clear(chatKey, { archive=true, reason })`：删前先归档一份，再删原文件。
  - `#archive()`：文件名 `"<chatKey>.<ISO时间>.<自增序号>.json"`（同毫秒不撞名），
    写入 `closedReason` / `closedAt`；顺带裁剪到每会话最近 10 份。
  - `listArchives(chatKey?, { limit })`：列归档摘要，新的在前。
  - `clear(..., { archive:false })` 用于陈旧清理（`sweep` 的兜底删除仍走直接删，不归档）。

### `src/orchestrator.js` —— 接上瘦身与归档

- 延续轮构造 `messages` 时，历史前缀先过 `slimHistoricalMedia()`（本轮新图不动）。
- 写回缓冲前同样过一遍（让缓冲体积收敛，`maxChars` 上限才准；下一轮前缀与存量字节一致，避免抖动）。
- `resetContinuation` / `#distillAndClose` 调 `clear(..., { archive:true, reason })`。
- 新增 `listArchives(chatKey)` 对外方法。

### `src/config.js`

`store.continuation.slimMedia = true`（可关）。

### `src/routes.js` + `ui/app/04-archive-usage.js`

- 新增 `GET /api/chats/<kind>_<id>/continuation-archive`：列出该会话归档。
- 会话详情标题右侧新增"· 已归档 N 段会话"标记（与已有"· 会话延续中：N 轮"并列）。
  - **P3-3 备注**：会话页"延续中：N 轮"标记 + 「重开会话」按钮（含二次确认弹窗）
    在 P1 阶段已实现，本次仅补归档计数展示。

## ⚠️ 一个必须知道的取舍

媒体瘦身会**改变历史前缀的字节**：切换那一刻，该会话的缓存前缀失效一次。
之后前缀稳定在"占位版"，缓存重新命中。所以它只在"会话里出现过图片/视频、
且还会续多轮"时才划算 —— 否则为省一次图片重复计费而丢一次缓存，得不偿失。
因此给了 `slimMedia` 开关；默认开（base64 图片体量大，多数场景划算）。

## 新增/更新测试

- `test/conversation-buffer-test.mjs`（12 → 20 项）：新增 5 项 `slimHistoricalMedia`
  （占位/折叠/纯文本原样/视频/纯函数不改原数组）+ 3 项归档（clear 归档、archive:false、
  每会话 ≤10 份）。
- `test/continuation-e2e-test.mjs`（7 → 9 项）：新增"关闭会话被归档 + 归档接口可查"、
  "手动重开会话也会归档"。

## 验证结果

| 套件 | 结果 |
|---|---|
| `conversation-buffer-test.mjs` | ✅ 20/20 |
| `continuation-e2e-test.mjs` | ✅ 9/9 |
| `self-note-test.mjs` | ✅ 17/17 |
| `npm test`（全量） | ✅ 全绿（exit 0） |

## 下一步

② 全部完成（P1/P2/P3）。剩余可选项：附录里的**问题③（三档连贯性偏置）**方案，**未启用**。


