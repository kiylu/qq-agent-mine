# 外部 Skill / Plugin 兼容性核查报告（2026-10-03）

核查范围：2026-10-03 的「会话延续 / 自身记忆 / 媒体瘦身 / 归档 / 思维链 UI」系列改造
是否破坏对外部社区 Skill 与 Plugin 的兼容性。

结论：**接口契约未破坏，向后兼容完整；发现 1 处"真实冲突面"（Skill 动态提示词 × 会话延续），
已实测确认并用回归护栏锁住现状。**

---

## 一、结论速览

| 契约面 | 状态 | 证据 |
|---|---|---|
| Skill 加载链路（发现→校验→注册→执行） | 未改动 | `src/plugin-loader.js`（未在本次改造中修改） |
| manifest 字段 / 校验规则 | 未改动 | `src/skills/manifest.js` |
| 5 个 hook 名称与签名 | 未改动 | `orchestrator.js:783/981/1099/1227/1238` |
| 传给 hook 的公共 ctx 字段 | **纯增量**，无删除 | `orchestrator.js:769-777` |
| Skill API 面（registerTool/config/fetch/utils…） | 未改动 | `plugin-loader.js:71-134` |
| 旧 `plugin.json` / 旧 prompt 形态兼容 | 保留 | `plugin-loader.js:49-65, 137-157` |
| Plugin ↔ Skill 共享加载器/注册表 | 未改动 | `plugin-loader.js`、`tool-registry.js` |
| 提示词注入机制（核心段在前、Skill 段在后） | 机制未变，核心段序有调整 | `prompt.js:198-213, 281-282` |
| market 契约（列表/发布/口令安装） | 未改动 | `src/market.js`、`routes.js:790-898`、`server/community_app.py` |
| `session` 对象结构 | **纯增量**（continuation/inputMessages 新增） | `orchestrator.js:895/948/987` |
| `session.messages[].raw` | 仍保留可用 | `orchestrator.js:1118` |

**测试基线**：`skill-test` 24 项、`tools-skill-audit` 29 项、`skill-modal-ui` 32 项、
`market-zip-test` 7 项、`prompt-anchor-test`、`continuation-e2e` 14 项 —— 全部通过。

---

## 二、唯一的真实冲突面：Skill 动态提示词 × 会话延续

### 现象

`src/orchestrator.js:919` 用 **整个 systemPrompt 逐字节比较**判断是否续用缓冲：

```js
else if (prevBuf.systemPrompt !== systemPrompt) freshReason = '系统提示已变化（缓存前缀失效）';
```

而 Skill 可以在 `promptSections(context)` 里返回**随会话变化**的动态内容
（`src/skills/manager.js:443-459`，context 含 `sessionId` 等每轮不同的字段）。
一旦动态内容变化 → systemPrompt 不等 → **每轮强制 fresh**，延续机制形同失效。

### 实测（三分对照）

| 技能形态 | 第 2 轮 messages | 结果 |
|---|---|---|
| 静态 `prompt.sections` | 4 条 | ✅ 走 continuation |
| 动态 `promptSections()`，但内容每轮相同 | 4 条 | ✅ 走 continuation |
| 动态 `promptSections()`，内容随 sessionId 变 | 2 条 | ❌ 走 fresh |

结论：**触发条件是"动态内容发生变化"，而非"使用了动态段"。** 内容稳定的动态段无害。

### 定性

- 这**不是**本次改造引入的 bug —— `systemPrompt` 逐字节比较是 P1「前缀缓存」的设计前提
  （`conversation.js:16-20` 明确要求 systemPrompt 逐字节复用）。
- 但它是"外部 Skill × 会话延续"的真实冲突面：外部开发者若写"每轮注入会变的内容"
  （如对话记忆、随机脑内闪过），会让该会话**永远无法延续**，且成本上升。
- 归因提示：这不是功能破坏，而是**性能退化**；聊天功能本身不受影响。

### 护栏

`test/continuation-e2e-test.mjs` 场景 9 已固化该行为：动态段变化 → 断言走 fresh。
若将来把比较逻辑改为"只比核心前缀"（允许尾部动态段），该断言会失败，提示放宽。

---

## 三、次要提示（非破坏，但外部开发者需注意）

1. **`before-llm-messages` 收到的是"精简 + 增量"形态**：延续轮的历史图片已被
   `slimHistoricalMedia` 换成文字占位（`conversation.js:326/341-346`）。
   若插件假设"messages 里必有原始 `image_url`"，会受影响。
   可通过配置 `store.continuation.slimMedia = false` 关闭（`orchestrator.js:941`）。

2. **工具集变化也会触发 fresh**：`sameToolNames` 是集合比较
   （`conversation.js:307-313`）。Skill 的 `available()` 若在首探与后台探测之间
   翻转可用性（文档推荐的异步探测写法），会导致工具集变动 → fresh。
   建议外部 Skill 的 `available()` 保持判定稳定。

---

## 五、缓存影响体检工作台（2026-10-03 追加）

上面两处冲突面（动态 `promptSections`、改写 system 的 `before-llm-messages`）
原本只能靠人工读代码判断。现在核心提供一个**确定性**体检接口，把风险直接标在技能/插件页上。

### 接口

```
GET /api/skills/cache-impact              # 只体检当前生效中的扩展
GET /api/skills/cache-impact?onlyActive=0 # 连未启用的也一起体检（排查用）
```

返回：

```jsonc
{
  "ok": true,
  "skills": [{
    "id": "xxx", "name": "xxx",
    "dynamicSections": true,        // promptSections 随上下文变化
    "sectionSample": [{ "id": "...", "title": "..." }],
    "systemRewriteHook": false,     // 运行时探测到 hook 改写了既有 system 消息
    "staticSystemWrite": true,      // 静态扫描：源码里有 system 改写模式（数据依赖型）
    "pushOnlyHook": true,           // 只 push 新消息（无害，但注入内容需稳定）
    "unstableAvailable": false,     // available() 连续两次结果不一致
    "level": "warn",                // ok | warn | danger
    "notes": ["..."]                // 人话解释 + 后果
  }],
  "summary": { "total": 1, "danger": 0, "warn": 1, "ok": 0 }
}
```

### 判定口径

| 检测项 | 方法 | 命中后果 |
|---|---|---|
| `dynamicSections` | 用两个明显不同的上下文各跑一次 `promptSections(ctx)`，比对输出指纹 | **danger**：每轮 fresh（丢上下文）+ 缓存全不命中 |
| `systemRewriteHook` | 造一条最小 messages（index0=system）跑一次 hook（**await 结果**），比对既有的 index0 是否被改动 | **danger**：不触发 fresh，但击穿前缀缓存、每轮全价，界面无提示 |
| `staticSystemWrite` | 读入口源码（含同目录 `lib/*.js`），找 `role === 'system'` + `content +=`／`.content.push` 组合 | **danger**：同 `systemRewriteHook`，用于补"数据依赖型"漏检 |
| `pushOnlyHook` | hook 只新增消息、未改既有 system | **warn**：对延续无害；注入内容若每轮不同仍击穿下一轮缓存 |
| `unstableAvailable` | 连续两次 `available()` 结果比对 | **warn**：工具集抖动 → fresh |

**为什么有两套 `systemRewrite` 判据**（2026-10-03 补）：
- **运行时探测**只能看到"这次试跑实际发生的改动"。像 `conversation-memory` 这类
  **数据依赖型** hook（待办/跨轮/语义卡为空时什么都不注入）在冷启动试跑下**零改写**，
  会漏检 —— 但真实运行时有内容时就会改写。
- **静态扫描**读源码找同款写法，把这类漏网之鱼捞回来。代价是可能误报
  （比如"取 system 只为读、不写"的实现），所以提示里标明"此判据为静态扫描"。

检测**不调用大模型**，纯确定性；属启发式，可能有误报（如依赖时间戳的实现），
因此只作为**提示**——`ok` 不显示徽标，`warn`/`danger` 才在技能卡片名后出现徽标。

### 边界

- 异步 `before-llm-messages`（返回 Promise）无法同步判定，报告里给"建议人工确认"提示，不误判为改写。
- 只比对 **index0** 的 system（本项目的 system 始终是首条，`prompt.js` 组装约定）。

---

## 六、给外部开发者的结论

- **可以放心使用现有 Skill / Plugin 契约**：manifest、hooks、API、market 安装流程均未变。
- **一个建议**：若 Skill 需要注入"每轮会变"的内容，避免放进 `promptSections`
  （会打断会话延续）。可改用 `before-llm-messages` hook —— 它在延续决策**之后**运行
  （`orchestrator.js:981`，决策在 `:916-972`），注入到 messages 而不影响 systemPrompt 比较。

  ⚠️ 但注意：该 hook 是**原地修改同一个 messages 数组**（`:981`），而 `#runAgent` 收尾时
  会把 `messages.slice(1)` 写回缓冲（`:1354-1358`）。所以 hook 注入的内容**会进入缓冲**，
  成为下一轮的前缀。若注入内容每轮不同，虽不触发 `systemPrompt` 比较（不判 fresh），
  但会**击穿下一轮的前缀缓存命中**（前缀字节变了）。稳妥做法：注入内容保持稳定，
  或只追加到末尾、不改动已有条目的字节。

---

## 七、测试与扩展的隔离（2026-10-03 补）

**现象**：装上 `conversation-memory` 后，核心测试 `selftest` 的
"drain 运行应延续同一会话（messages 逐字节前缀）"断言失败。

**根因**：`plugin-loader.js` 的 `skills/`、`plugins/` 根目录硬编码在 `APP_ROOT` 下，
测试只隔离了数据目录（`QQ_AGENT_DATA_DIR`），**没隔离扩展目录** ——
用户装任何插件，核心断言就会被该插件的行为（此处是改写 system）影响，
把"用户环境"和"代码正确性"搅在一起。

**修复**：
- `SKILLS_DIR` / `PLUGINS_DIR` 支持 `QQ_AGENT_SKILLS_DIR` / `QQ_AGENT_PLUGINS_DIR`
  环境变量覆盖（与 `QQ_AGENT_DATA_DIR` 同一约定）。
- `test/selftest.mjs`、`test/_harness.mjs`（`makeDataDir`）默认把扩展目录指向空临时目录。
- `test/continuation-e2e-test.mjs` 场景 9 的探针写入**隔离**技能目录，不再污染 `ROOT/skills`。
- `tools-skill-audit` **从 `npm test` 主链移出**：它审计的是"已装扩展"的质量，
  装了不达标插件必红 —— 那是扩展问题，不是核心回归。改为 `npm run test:audit` 单独跑。

**效果**：`npm test` 与"用户装了什么扩展"彻底解耦。

---

## 八、既有扩展的清理与精简（2026-10-03 收尾）

体检工作台跑出来后，`conversation-memory` 被判 `danger`：它在 `before-llm-messages`
每轮把待办/跨轮/语义卡/跨群**追加进既有 system 消息**，内容每轮变 → 击穿前缀缓存
且不触发 fresh；而它的作用（"上一轮想到哪了"）与本工程的**会话延续**高度重复。

按"只留需要的功能"原则做的处理：

- 删掉除会话记忆外的全部第三方扩展（`budget-guard`、`owner-identity`、
  `jm-comic`、`pixiv-image-tagsearch`）；`skills/` 现为空。
- `conversation-memory` → **`conversation-memory-lite`**（分层会话记忆 · 精简版）：
  - **保留**：后台小时块索引 + 模型主动检索（`memory.search` / `memory.archive` /
    `memory.status`），零注入、非检索不花 token。
  - **移除**：`before-context` / `before-llm-messages` / `after-response` 三个注入类
    hooks，以及 `arch.js`、`cost-guard.js`、`cross-turn.js`、`cross-chat.js`、
    `semantic-cards.js`、`pending.js`、`sensory.js`、`working.js` 八个模块。
  - 结果：同一套体检从 `danger` → **`ok`**（`staticSystemWrite=false` /
    `systemRewriteHook=false`），检索能力不变。

**经验**：`hooks = {}` 也是有效形态 —— 插件可以只提供 `providers` 能力而不挂任何 hook。

---

## 九、给外部开发者的结论
