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

## 四、给外部开发者的结论

- **可以放心使用现有 Skill / Plugin 契约**：manifest、hooks、API、market 安装流程均未变。
- **一个建议**：若 Skill 需要注入"每轮会变"的内容，避免放进 `promptSections`
  （会打断会话延续）。可改用 `before-llm-messages` hook —— 它在延续决策**之后**运行
  （`orchestrator.js:981`，决策在 `:916-972`），注入到 messages 而不影响 systemPrompt 比较。

  ⚠️ 但注意：该 hook 是**原地修改同一个 messages 数组**（`:981`），而 `#runAgent` 收尾时
  会把 `messages.slice(1)` 写回缓冲（`:1354-1358`）。所以 hook 注入的内容**会进入缓冲**，
  成为下一轮的前缀。若注入内容每轮不同，虽不触发 `systemPrompt` 比较（不判 fresh），
  但会**击穿下一轮的前缀缓存命中**（前缀字节变了）。稳妥做法：注入内容保持稳定，
  或只追加到末尾、不改动已有条目的字节。
