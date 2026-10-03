# 测试关注点清单：② 会话缓存 / 蒸馏 / 瘦身（2026-10-03）

对应提交：`18038c5`（P1+P2）、`91d6135`（P3）。问题③未改，不在本清单范围。

这份清单回答一个问题：**改了这么多，实测时该盯哪里、看什么、怎么判断对错。**

---

## 0. 一句话心智模型

改造后一次处理有两条路径：
- **延续（continuation）**：距上次触发 < 沉默阈值 → 复用上一次的 messages 前缀，只追加增量。
- **全新（fresh）**：沉默超阈值 / 系统提示变 / 工具集变 / 超轮次或体积上限 → 新开，且**关闭前蒸馏自身状态**。

你实测要验证的核心就三件事：**① 该续的时候真的续上了（缓存命中）② 该关的时候真的关了且蒸馏落盘 ③ 图片不会每轮重传。**

---

## 1. 自动化测试（先跑，最省事）

```bash
npm test                      # 全量；改动的三个套件都在里面
npm run test:continuation     # 会话缓冲 + 延续端到端
npm run test:self             # 自身记忆与蒸馏
npm run test:prompt           # 提示词段序 + 锚点
npm run test:coverage         # 端到端/HTTP/界面（注意下面两处预存失败）
```

**重点关注套件与项数**（跑完看这几行）：

| 套件 | 期望 | 覆盖了什么改动 |
|---|---|---|
| `conversation-buffer-test.mjs` | **20/20** | 缓冲落盘、沉默阈值、`slimHistoricalMedia`（5 项）、归档（3 项） |
| `continuation-e2e-test.mjs` | **9/9** | 前缀逐字节复用、重开会话、沉默切回 fresh、蒸馏、归档 |
| `self-note-test.mjs` | **17/17** | selfNote 读写/去重/上限、`_self.json` 不混成员、蒸馏解析、落点 |
| `test-prompt.mjs` / `prompt-anchor-test.mjs` | 通过 | 稳定段在前、易变段在后、前缀逐字节一致 |
| `wake-semantics-test.mjs` | 10/10 | 触发链路未被破坏 |

**已知的 2 处失败是预存环境问题**（已用 `git stash` 在原始代码复现确认，与本次改动无关，别去追）：
1. `coverage-http`：`POST /api/qq-portable/launch`（本机没装 QQ）
2. `coverage-ui`：`landing.html 的下载链接带版本号`（本机 landing 无下载链接）

> ⚠️ `npm test` 里 `setup-qq-version` 那条也会因本机无 `snowluma/` 失败，会让 `&&` 链**中断**，排在它后面的 9 个套件不会跑。要跑全，逐个补跑或看 `package.json` 的 script 列表。

---

## 2. 手动实测：该盯的 4 个观察面

### A. 缓存命中率（验证 P1 前缀复用）

- **看哪里**：控制台 → **用量**页，「缓存命中率」卡片 + 「按日快照」表格里的 `命中率` 列；驱动它的字段是每次请求 `usage.prompt_tokens_details.cached_tokens`（`src/llm.js`）。
- **怎么测**：同一会话里**连续**发消息（间隔小于沉默阈值），看命中率是否稳定在高位（你上次数到 97% 就是这条路径在工作）。
- **看什么算对**：第 2 轮起命中率高（延续轮前缀逐字节相同）；若**续上了却命中率≈0** → 说明前缀被谁改了字节，重点查下面第 4 节。
- **接口自查**：`GET /api/chats/<kind>_<id>/continuation` → 返回 `turns` / `messages` / `chars` / `silenceMinutes`。turns 随连续对话递增 = 续上了。

### B. 会话是续了还是重开了（验证 continue/fresh 判定）

- **看哪里（当前短板）**：`session.continuation = { mode:'continuation'|'fresh', reason }` 已经写在会话对象里，但 **UI 目前没展示**。要实时看，得靠日志或接口：
  - `GET /api/continuations` → 列出所有"正在延续中"的会话（含 turns/chars/lastTurnAt）。
  - 存档页会话详情标题右侧：`· 会话延续中：N 轮` / `· 已归档 N 段会话`。
- **怎么测**：连续发几条（应看到 turns 递增）；然后**静默超过阈值**再发（应回到 fresh，`turns` 归 1）。
- **阈值怎么定**：默认按渠道自动——anthropic 4 分钟 / qwen 5 / openai-o 8 / deepseek 60 / gemini 60，兜底 5 分钟（`src/conversation.js` 的 `SILENCE_MIN_BY_DIALECT`）。想快点测，把 `store.continuation.silenceMinutes` 设成小数（如 `0.1` = 6 秒）。

### C. 关闭时是否蒸馏出「自身状态」（验证 P2）

- **看哪里**：
  - 日志：`[orchestrator] 会话关闭蒸馏（<原因>）：写入自身状态 N 条 @ <chatKey>`；失败是 `会话关闭蒸馏失败:`。
  - 界面：**记忆页** → 选中某会话 → 「🪞 自身状态（N 条）」折叠块。
  - 落盘：`data/memory/<chatKey>/_self.json`。
  - 下一轮提示词：全新会话里应出现 `【自身状态】` 段（在【记忆】之后）。
- **怎么测（关键）**：先让机器人**在思考里留下暗牌信息**（比如让它玩海龟汤/出题，思考里有谜底），静默超阈值触发关闭 → 查日志是否蒸馏 → 看 `_self.json` 是否落了条目 → 再发一条，确认新会话提示词里带上了。
- **预期行为**：蒸馏是 **fire-and-forget**，不阻塞当前会话；产物给**下一轮**用（本轮提示词已构造完）。所以本轮看不到、下一轮才生效是**正常**的。
- **不蒸馏的情况**（都正常）：`_self.json` 为空、`distillOnClose:false`、缓冲为空、蒸馏那轮模型返回 `[]`。

### D. 图片/视频是否被瘦身（验证 P3）

- **看哪里**：`data/conversations/<chatKey>.json` 的 `messages` 里，**历史**条目的 `image_url`/`video_url` 应已被替换成文字占位 `[此前看过的一张图片/视频（已省略，避免重复计费）]`；本轮新图仍是原样。
- **怎么测**：发一张图让机器人看图 → 触发一轮 → 再连续触发 → 打开缓冲文件看历史里那张图是否变占位。
- **预期取舍**：切换那一刻**前缀字节变了 → 该会话缓存会失效一次**，之后稳定。所以命中率曲线可能是"掉一下再回升"，不是 bug。
- **可关**：`store.continuation.slimMedia = false`。

---

## 3. 直接看数据文件（最硬核也最直接）

| 位置 | 看什么 |
|---|---|
| `data/conversations/<chatKey>.json` | 活跃缓冲：`systemPrompt` / `toolNames` / `messages` / `turns` / `chars` / `startedAt` / `lastTurnAt` |
| `data/conversations/archive/<chatKey>.<时间>.<seq>.json` | 已关闭会话归档：多了 `closedReason` / `closedAt`；每会话最多 10 份 |
| `data/memory/<chatKey>/_self.json` | 自身状态条目 `[{content, createdAt}]`，最多 40 条 |
| `data/memory/<chatKey>/<QQ>.json` | 群友印象（应与自身状态**分开**，互不混入） |
| `data/sessions/`、`data/logs/` | 会话记录与日志（蒸馏日志、缓冲写盘失败警告都在这） |

**`<chatKey>` 格式**：`group_<群号>` / `private_<QQ>`（文件名里 `:` 被换成 `_`）。

---

## 4. 最容易被忽略 / 容易误判的坑

1. **"续上了但缓存没命中"** —— 前缀被改字节。可能来源：
   - 系统提示变了（配置/人设/技能改动）→ 判定 fresh 是**对的**；
   - 工具集变了（`visionEnabled`/搜索开关切了）→ 判定 fresh 是**对的**；
   - 谁在往历史 messages 里写"每轮都变"的字段（`raw` 已剥；若新增类似字段就会复发）。
2. **蒸馏"看起来没生效"** —— 它是给下一轮的，本轮看不到属正常；且只在**关闭那一刻**触发，正常连续对话期间**不会**蒸馏。
3. **归档文件名相同被覆盖** —— 已用 ISO 时间 + 自增序号规避；若你手动删改 `archive/` 后观察到数量异常，先看是不是时间戳相同。
4. **`sweep()` 不归档** —— 24 小时无交互的陈旧缓冲是**直接删**（不产生归档），这是设计，不是丢数据。
5. **`session.continuation` 在 UI 无展示** —— 想排障"这次为什么没续上"，目前只能看日志/接口，UI 看不到 `freshReason`。**这是一个已知短板**，需要的话可以补一个展示。
6. **测试环境隔离** —— 测试都靠 `QQ_AGENT_DATA_DIR` 指向临时目录；手动实测时**别把测试的临时目录当成真实数据目录**，反之亦然。
7. **并发单会话串行** —— 同一 `chatKey` 由 `runningChats` 保证串行，continue 天然安全；但 `distilling` 集合只是**本进程内**防重复蒸馏，多进程同时跑会重复（正常部署单进程，不涉及）。

---

## 5. 建议的最小实测剧本

1. 建一个只有你在的测试群，档位设 4 档（全响应）或 @ 必应。
2. **连续 @ 机器人三轮**（间隔几秒）→ 看用量页命中率是否高位、`/api/continuations` 的 turns 是否 1→2→3。
3. **发一张图**，让它看图回答 → 去看 `data/conversations/<chatKey>.json`，确认这张图**本轮还在**。
4. **再 @ 一轮** → 确认那张图的历史条目**已变占位**。
5. **沉默超过阈值**（或临时把 `silenceMinutes` 设 0.1）再 @ → 看日志是否出现「会话关闭蒸馏」→ 查 `_self.json`。
6. **再 @** → 确认新会话提示词带 `【自身状态】` 段、命中率重新爬升。
7. 打开记忆页 → 确认「🪞 自身状态」块能看到内容，且群友印象里没有混入 `_self` 的东西。
