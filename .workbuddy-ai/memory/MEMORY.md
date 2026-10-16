# 项目长期记忆（qq-agent-mine）

## 用户偏好：文档写作

- **改动清单 / 方案文档只要最终版**：不写修订说明、不写版本号（v1/v2）、不写"根据什么什么修订"、
  不留以前的方案、不解释"为什么调整了方案"。只保留：改什么（文件级落点）/ 效果 / 负面效果 / 优先级。
- 方案类文档沿用仓库既有命名：`doc/change-plan-YYYY-MM-DD*.md`、`doc/fix-plan-*.md`、
  `doc/issue-analysis-*.md`。

## 项目关键约束（写方案/改代码时必须遵守）

- **缓存铁律**：任何"每轮注入"的内容必须过 `GET /api/skills/cache-impact` 且为 `ok`；
  详见 `doc/extend_development/caching-contract.md`（三条铁律：promptSections 返回值必须逐字节稳定、
  不得改写既有 system 消息、available() 判定必须稳定）。
- **工具可用性唯一口径**：`src/tool-registry.js` 的 7 道判定，模块不得另写一份。
- **旁路模型调用不得污染主前缀**：用独立 messages，结果只落盘。

## 项目架构要点（速查）

- 双型扩展：`skills/`（LLM 型，注册工具，模型决定何时用）、`plugins/`（确定性型，providers/hooks）。
- 会话延续：`src/conversation.js`（沉默阈值按渠道缓存 TTL 取：anthropic 4 / qwen 5 / openai-o 8 /
  deepseek 60 / gemini 60 分钟；`maxTurns=30`、`maxChars=240000`）。
- 蒸馏：`#distillAndClose`（`orchestrator.js:990`）**只在会话关闭时**跑，产出仅自身状态
  （`appendSelf` → `_self.json`），用独立的 `DISTILL_SYSTEM_PROMPT`，与主 systemPrompt 不同 →
  0 缓存命中。
- 记忆：`src/memory.js`（群友印象 memberImpression + 自身状态 `_self.json`）；
  插件 `plugins/conversation-memory-lite`（零注入、Hippocampus 倒排索引 + score/forget）。
- 注意：仓库根 `skills/` 目录当前为空。
