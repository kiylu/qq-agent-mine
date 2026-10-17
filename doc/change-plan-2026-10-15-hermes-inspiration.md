# 改动清单：借鉴 hermes-agent 的启发

## 总览

| 层 | 改动 | 落点 | 额外模型调用 | 工作量 |
|---|---|---|---|---|
| L1 | 沉淀质量：纠正信号 + 信号清单 + memory/skill 分工 | `conversation.js` / `prompt.js` | 零 | 小 |
| L2 | 声明式 Markdown 技能 + 渐进式披露 + 开关 + 管理入口 | `skills/manager.js`、扩展页 | 零 | 中 |
| L3 | 续接期后台评审（低频、旁路） | `orchestrator.js` | 有（低频） | 中 |
| L4a | 技能库治理建议（技能页展示、手动确认） | 新增治理任务 + 技能页 | 有（整理时） | 中 |
| L4b | 记忆权重机制（按来源定分 / 衰减 / 注入排序 / 淘汰 / 回收站） | `memory.js` | 零 | 中 |
| L4c | 全局规则（跨群互通，需主人私聊授权） | `memory.js` / `tool-registry.js` | 零 | 中 |
| L5 | 轨迹导出（归档 → 数据集） | 新增脚本 | 零 | 小 |

```
L1 → L2 → L3 → L4 → L5
```

L1/L2 零额外调用且决定质量；L3 才引入成本；L4 是对已沉淀内容的整理与治理；L5 独立。

---

## L1 · 沉淀质量（零额外调用）

只改提示词与分类，不增加任何模型调用（蒸馏本来就在会话关闭时跑一次），却直接决定"沉淀什么"。

**怎么改**

1. `src/conversation.js` 的 `DISTILL_SYSTEM_PROMPT`（当前约 474 行）：
   - 新增一级信号**「群友纠正」**——"你 AI 味好重""别这么说话""别每次都总结""你老是 Y"这类。
     现在没有专门捕获路径，只能落成"对那个人的印象"或直接漏掉。
   - 新增**信号清单**：① 纠正了说话风格/语气/格式；② 纠正了做法/顺序；③ 出现非平凡技巧；
     ④ 已有的技能/规则被发现是错的 → 立即修补。用于提高捕获率，缓解现在经常
     `skipped-no-content` 的问题。
   - 明确 **memory / skill 分工**：memory = "这个群/这个人现在是什么状况"；
     skill = "这类事该怎么做"。
2. 纠正条目写入 `_self.json`，加 `kind: 'rule'`（普通状态为 `state`）——
   **加权重与淘汰见 L4b**。纠正的语义属"技能类"，L2 落地后可迁移到 SKILL.md。
3. `src/prompt.js:135-136`：同步更新给模型看的机制说明。
4. `config.js` 的 `continuation` 段：新增 `distillSignals` 开关。

**效果**：群友纠正被真正捕获 → 下次开场就带着"别这么说话"的约束；捕获率上升。

**负面效果**

- 捕获率变高会沉淀出低价值条目 → **保留 `skipped-no-content` 出口，判定标准要严**
  （群聊单次价值低、频率高，强行沉淀只会制造噪声记忆）。
- `_self.json` 增长更快，上限需同步评估（见 L4b）。
- 仍受"只在关闭时跑"的限制：会话一直续着时，中途的纠正捕获不到（由 L3 解决）。

---

## L2 · 声明式 Markdown 技能 + 渐进式披露

给 L1 产出的"技能类"内容一个**不破缓存**的安放处。

**定位（先说清楚它解决什么问题）**

它本身不是"新功能"，而是 **L3 的载体**：L3 的后台评审要产出"以后该怎么做"，需要一个
既能在提示词里被发现、又不占常驻 token、还能被人手工编辑的容器。三型扩展的分工：

| 形态 | 何时生效 | 适合放什么 |
|---|---|---|
| `persona.customRules` / `systemPromptOverride` | **每轮常驻** | 全局、长期稳定的规则 |
| JS 技能（`skills/<id>/index.js`） | 模型调工具时 | 需要真正执行动作的能力 |
| Markdown 技能（`SKILL.md`） | 命中触发词 / 模型按需加载 | **场景化的做法**（如"怎么主持海龟汤"） |

结论：**没有 L3 时它只能手写**，价值有限（大致等价于"按场景生效的 customRules"）；
**有 L3 时**它才是自动沉淀的落点。默认 `enabled: false`，不开启时对运行期零影响
（提示词不变、工具不可见）。

**怎么改**（`src/skills/manager.js` + 扩展页）

1. 新增一型技能：`skills/<id>/SKILL.md`（YAML frontmatter：`name` / `description` / `triggers` /
   `category` + Markdown 正文）。
2. 加载器只把 `name + description` 注册成**稳定不变**的索引；**正文不进前缀**。
3. **索引落点决定缓存代价**——增删技能会触发一次 fresh（一次性，不是持续），按下面两条压低：

   | 方式 | 做法 | 代价 |
   |---|---|---|
   | **批量 flush（默认）** | 新技能先攒着，**会话关闭时**才更新索引——下个会话本来就是 fresh，**零边际成本** | 会话内新技能不在目录，靠触发词兜 |
   | **索引走工具** | 目录不写进提示词，改用 `list_skills` / `load_skill` 工具返回（落在尾部，增删零影响） | 发现技能多花一轮工具调用 |

   技能库变大后从前者切到后者。
4. 触发：命中 `triggers`，或模型主动调 `load_skill` 时，把正文作为**尾部消息追加**。
5. **管理入口**：扩展页（技能页）给自动技能加 **来源标记（自动/手写）**、命中次数、最后命中时间，
   并支持编辑正文 / 禁用 / 删除。接口沿用 `GET /api/skills` / `POST /api/skills/:id`，
   加 `source: 'auto' | 'manual'` 字段。
6. **开关（分层，默认关）**：

   ```
   autoLearn.enabled          总开关（默认关）
   autoLearn.createNewSkill   允许新建（默认关；只允许更新已有技能）
   autoLearn.intervalTurns    评审间隔（默认 8）
   autoLearn.maxAutoSkills    自动技能数量上限（默认 10，超了不再新建）
   ```

   默认关的理由：会自动改行为、成本不可控——与 `owner-identity`、`account-pool` 同一条取舍。

**效果**：技能类沉淀有了正式载体；技能库可无限增长而不涨常驻 token；自动技能可被查看与管理。

**负面效果**

- 追加的正文进入会话缓冲，成为下一轮前缀的一部分；正文若含变量（日期/随机/轮次）就会破缓存。
- **绕过 priority 压制**：JS 技能的 `prompt.sections` 被强制压到 ≤99，而 Markdown 正文走尾部追加，
  不受此约束 → 需约定"Markdown 技能不得覆盖安全规则"。
- 概念从两型变三型，`skill-system.md` / `skill-reference.md` / `cache-impact` 都要同步支持。

---

## L3 · 续接期后台评审（这一步才开始增加调用）

补上最大的缺口：续接期（`maxTurns: 30`）目前一次都不沉淀。

**怎么改**（`src/orchestrator.js`）

1. 在续接轮（`useBuffer === true`）计数，达到阈值（`intervalTurns`）时**旁路**跑一次评审：
   输入 = 最近几轮思考 + 当前自身状态 + 相关印象；输出 = "要不要补一条 memory / skill"。
2. 评审调用走**旁路**（独立 messages，**绝不进主会话前缀**），结果只落盘。
3. 关闭时的 `#distillAndClose`（`orchestrator.js:990`）保留作兜底。

**效果**：续接期不再"想完就忘"；长任务（海龟汤/打赌）中途也能固化暗牌答案与约定。

**负面效果**

- **成本**：每次评审 = 一次额外模型调用 → 低频 + 可配 + 有开关，并优先只在出现信号时触发。
- **不要照搬"fork 继承 cached system prompt"**：该技巧只在**缓存还热**时成立。关闭蒸馏发生在
  "沉默超过缓存 TTL"之后，缓存已冷，复用前缀零收益 → 关闭蒸馏维持独立小模型调用。
  续接期评审虽然缓存是热的，但**实际取舍是不复用**：主 systemPrompt 是"群友人设"，
  拿它当前缀会让模型接着扮演群友、而不是做复盘（评审是**元任务**）→ 用独立的小提示词，
  成本同样可控（每 N 轮一次 + 输入按字符预算截断）。
- 可能重复记（评审与关闭蒸馏各记一次）→ 复用现有去重（`appendSelf`、`#appendRaw` 的 `some()`）。

---

## L4a · 技能库治理建议

**怎么改**

- 新增治理任务（挂在 L3 评审之后，或独立定时）：检测**重复**（同类技能建议合并）、
  **长期未命中**（建议删除）、**互相冲突**（一个说 X、一个说 Y）。
- 结果**只在扩展页（技能页）的「治理建议」区展示**，每条带 **确认执行 / 忽略**（忽略可记一段时间
  不再提示）。**全程不自动删**。
- 后端：`GET /api/skills/governance`（只读建议）+ `POST /api/skills/:id/apply-governance`
  （用户点确认才真执行）；执行前自动备份（复用现有 `backups/` 模式）。
- 写入前**强制 read-before-write**（先读再改）；命名要求 class-level，禁止
  `fix-X` / `debug-Y` / `audit-Z-today` 这类 session 化命名。

**效果**：技能库不碎片化、不膨胀，且用户对每次变更都有确认权。

**负面效果**：建议本身由模型判断，可能不准 → 因此只建议、不自动执行，误报的代价只是噪声。

---

## L4b · 记忆权重机制

记忆（含 L1 的纠正条目）不再"只增不减、按时间 FIFO 淘汰"。

**怎么改**（`src/memory.js`）

1. 条目增加 `score` / `lastHitAt` / `kind`；读旧数据时补默认值（向后兼容，无需迁移脚本）。
2. **按来源定初始分**：

   | 来源 | 初始 score |
   |---|---|
   | 主人 + 语气强烈（明确禁止） | 5.0 |
   | 主人普通纠正 | 3.0 |
   | 普通群友纠正 | 2.0 |
   | 自己蒸馏 / `remember_self` | 1.0 |

   主人判定依赖 `owner-identity` 技能的 `message.owner-check`（`orchestrator.js:813`），
   而该技能**默认关** → 检测不到主人时按"普通群友纠正"给 2.0，**必须能降级**。
   "语气强烈"只能靠模型语义判断（写在 L1 的信号清单里），不要用规则硬判。
3. **衰减**：`score *= 0.5 ^ (ageDays / halfLife)`，`halfLife` 可配（默认 30 天）。
4. **注入按 score 排序**（关键）：现在 `formatSelfForPrompt(limit=10)` 取的是**最近 10 条**，
   而存储上限是 40 条 → 一条重要纠正**即使还没被淘汰，只要不是最近 10 条就不会被注入**。
   改成按 score 取前 N，比淘汰规则更紧急。
5. **超上限按 score 升序淘汰**（同分看时间），替代现在的 `slice(-max)` 纯 FIFO。
6. **回收站**：淘汰**不删**，移入 `data/memory/backups/evicted.json`（复用现有 `backups/` 模式）；
   记忆页加"已清理"列表 + 「恢复」按钮。**回收站自身也要设上限**（如每会话 200 条 / 90 天）。
7. 顺带补缺口：现在 `memory_query` / `memory_remove` **只支持 memberImpression**，
   自身状态没有查询/删除工具 → 补一个查看入口。

**效果**：重要纠正不易被清掉；注入的总是最相关的那几条，而不是碰巧最新的那几条；误删可恢复。

**负面效果**

- 调参不当会误删重要印象；冷群印象本来就少，衰减会让"上个月那个梗"消失 → 属行为变更，
  建议默认关或可调。
- 新增字段改变成员 JSON 结构，`_meta.json` / 备份逻辑需顺带检查。
- 回收站只是把膨胀从 A 挪到 B → 必须给它自己设上限。

---

## L4c · 全局规则（跨群互通，需主人私聊授权）

**目标**：群聊之间记忆**继续互相独立**（现状不变）；只有当**主人在私聊里明确要求互通**时，
那条规则才写进全局层，对所有群生效。

**怎么改**

1. **全局存储**：新增 `data/memory/_global/_rules.json`（与各会话目录同级）。条目结构沿用自身记忆
   （`content` / `kind: 'rule'` / `score` / `createdAt` / `lastHitAt`），另加 `source`（记录来自哪个私聊、
   何时授权）。上限、衰减、回收站复用 L4b 的机制。
   - ⚠️ `_global` 必须加入 `listChats()` 的排除名单。现有正则 `^(group|private)_(\d+)$` 天然不匹配它，
     但要显式注释说明，避免以后有人放宽正则时把它当会话。

2. **写入闸门（两道，缺一不可）**
   - **必须主人私聊**：`kind === 'private'` 且该会话的 QQ 就是主人。
   - **必须明确要求互通**：靠**专用工具** `remember_global`，**不靠关键词猜**（"全局""所有群"这类措辞判定
     不可靠）。该工具只在主人私聊时可用 —— 在 `src/tool-registry.js` 的可用性判定里加一条，
     做法与 `send_to` 的独立开关一致：不满足时模型**连工具都看不见**。

3. **主人判定的硬依赖（必须先解决）**
   现在"主人 QQ"**不在核心配置里**，而是 `owner-identity` 技能的私有 settings；核心只通过
   `message.owner-check` 能力问"这批消息里有没有主人"。该能力当前返回 `{ persona, rules }`，
   **不足以判定"这个私聊是不是主人"**。两个选项：
   - **A（推荐）**：扩展该能力的返回为 `{ isOwner, ownerQq, persona, rules }`（向后兼容），核心据此判断；
   - **B**：核心新增 `owner.qq` 配置项，不依赖技能。
   无论哪种，`owner-identity` **默认关** → 关闭时本功能自动不可用，UI 按项目约定**明确给出原因**
   （"需要先开启主人识别并填 QQ 号"），不要静默失效。

4. **注入**：`formatSelfForPrompt` 前面追加一段【全局规则】（只列 `kind='rule'` 的全局条目，按权重取前 N）；
   本会话的【自身状态】照旧。该段与【自身状态】同处**易变区**，不碰稳定前缀。

5. **管理端**：记忆页顶部（不属于任何单个会话）增加「全局规则」区：可查看来源、编辑、删除、回收站恢复。

6. **开关**：`continuation.globalRules`（默认开；关闭时全局段不注入、`remember_global` 工具不可用）。

**效果**：群内语境保持隔离；主人在私聊里说一次"以后所有群都别用总结式收尾"，一次生效、全群适用。

**负面效果**

- **跨群污染风险**：全局规则写错会同时影响所有群 → 必须管理端可查可删，且写入只走专用工具。
- **硬依赖 `owner-identity` 技能**（默认关）：未开启时功能不可用，必须在设置页明确提示原因。
- 全局段是每个会话提示词的一部分，**改动会让所有会话各 fresh 一次**（罕见，可接受）。
- 需要扩展 `message.owner-check` 的返回契约（或新增能力），属**对外契约变更** → 需同步
  `doc/extend_development/skill-reference.md`。

---

## L5 · 轨迹导出（归档 → 数据集）

**怎么改**

- 新增 `scripts/export-trajectories.mjs`：读 `data/archives`，转 ShareGPT / OpenAI messages 格式，
  导出 JSONL；设置页加入口。
- **分步推进**：① 先只做**导出**（零风险，除隐私）；② 导出后**先别急着训**，先从中精选
  **few-shot 示例**放进 prompt（便宜、立即可用、随时可改）；③ 人设定稿、few-shot 不够用了，
  再考虑微调。

**效果**：人设可内化，把"说话方式"从提示词搬进权重 → 省掉一大块固定前缀（实测提示词约 12256 字符）；
人设更稳、不被长上下文稀释；将来可用更小更便宜的模型。

**负面效果**

- **微调学到的是"风格"不是"记忆"**——它不会让机器人记住群友，记忆仍靠 memory 系统。
- **数据质量是决定性的**：群聊归档里全是灌水/@/表情，直接训会学到坏模式 → 必须筛选
  （只留机器人实际发言 + 必要上下文），最好人工标出"好的回复"。
- **数据量通常不够**：人设微调一般要几千条高质量样本，单群归档可能只有几百条。
- **不可逆 + 有门槛**：微调后难回滚（改 prompt 随时能改）；本项目是 Node/Electron，训练要另起管线。
- **隐私**：必须脱敏（QQ 号 / 群号 / 人名）+ 用户显式确认。

---

## 贯穿约束

1. **缓存铁律**：任何"每轮注入"的东西都要过 `GET /api/skills/cache-impact`，必须 `ok`
   （见 `doc/extend_development/caching-contract.md`）。
2. **可用性唯一口径**：任何新工具/能力都要走 `src/tool-registry.js` 的 7 道判定，不允许另写一份。
3. **旁路调用不得污染主前缀**：L3 评审、L4 治理等旁路模型调用一律用独立 messages，结果只落盘；
   只有"缓存还热"的续接期评审才考虑复用主前缀。

---

## 已办记录

### 2026-10-16 · L1 + L4b（相互依赖的一对）

先做这两项：L1 产出的"纠正"条目要靠 L4b 打分与淘汰；L4b 的"按来源定分"又依赖 L1 传递来源
（`kind` / `ownerActive`）。其余（L2/L3/L4a/L5）未动。

**L4b · 记忆权重机制**（`src/memory.js`）

- 自身记忆条目新增 `kind`（`state`/`rule`）、`score`、`lastHitAt`；旧数据读时补默认值，**无需迁移脚本**。
- 新增 `initialSelfScore({ kind, ownerActive })`：rule×主人=5 / rule=2 / state×主人=3 / state=1。
- 新增 `effectiveSelfScore()`：读时按半衰期计算，**不写盘**（无写放大）。
- `appendSelf(..., { max, kind, ownerActive, score, halfLifeDays })`：超上限改为**按有效权重升序淘汰**
  （同分淘汰更旧的），不再纯 FIFO。
- **注入改为按权重取前 N**（`formatSelfForPrompt`）：原来取"最近 10 条"而存储上限 40 ——
  重要但来得早的条目会"还没被淘汰就先不被注入"，这是本次最关键的一处修正。
- 新增**回收站**：淘汰不删，落 `data/memory/<会话>/_evicted.json`（上限 200 条）；
  新增 `evictedSelf()` / `restoreSelf()` / `clearEvictedSelf()`。
  `_evicted.json` 已加入成员扫描跳过名单，不会被当成群友印象。

**L1 · 沉淀质量**（`conversation.js` / `prompt.js` / `config.js` / `orchestrator.js` / `tools.js`）

- `DISTILL_SYSTEM_PROMPT` 重写：区分 `state`（当前状况）与 `rule`（以后该怎么做），
  把**群友纠正说话方式/做法**列为一级信号；旧口径保留为 `DISTILL_SYSTEM_PROMPT_BASIC`。
- 新增 `parseDistillEntries()` → `{ content, kind }`；`parseDistillResult()` 保留为只取内容的兼容包装。
- `distillBuffer({ ..., ownerActive, signals })`：把 `kind`/`ownerActive` 传给 `appendSelf`；
  `signals=false` 时退回旧提示词。
- `config.continuation` 新增 `distillSignals`（默认 true）与 `selfHalfLifeDays`（默认 30）。
- `orchestrator`：`#distillAndClose` 增加 `ownerActive` 参数（由 `owner-identity` 技能的判定结果传入）；
  工具 `ctx` 新增 `ownerActive`。
- `remember_self` 工具新增 `kind` 参数（`state`/`rule`），并按 `ctx.ownerActive` 决定初始权重；
  `prompt.js` 同步更新说明，并新增"纠正要用 kind=rule 记"的引导。

**接口 / 界面**

- `GET /api/memory-files/:key` 响应新增 `evictedSelf`。
- 新增 `POST /api/memory-files/:key/self/restore`（恢复）与
  `DELETE /api/memory-files/:key/self/evicted`（清空）。
- 记忆页新增「已清理」折叠区：逐条「恢复」+「清空回收站」。

**测试**

- `test/self-note-test.mjs`：新增 10 条断言（初始权重、衰减、按权重淘汰、回收站恢复、
  注入按权重取前 N、`_evicted.json` 不入成员、kind 解析、rule 写入权重、signals 开关）—— 31/31 通过。
- `test/coverage-http.mjs`：新增 2 条路由覆盖（恢复 / 清空）—— 118 通过。
- `npm test` 全绿（36 套件）。

**行为变化（需知）**

- 系统提示词字节变了（`prompt.js` 的记忆说明 + 蒸馏提示）→ 升级后首个会话 fresh 一次，之后照常命中。
- 自身记忆的淘汰顺序从"最旧的先走"变为"权重最低的先走"；默认权重下与旧行为接近，
  只有 `rule` 与主人触发的条目会被优先保留。

### 2026-10-16 · L2（声明式 Markdown 技能）+ L5（轨迹导出）

**L2 · 声明式 Markdown 技能**（新增 `src/markdown-skills.js`）

- 第三型扩展：`skills|plugins/<id>/SKILL.md`（YAML frontmatter：`name` / `description` /
  `triggers` / `category` / `enabled` + Markdown 正文）。零依赖的极简 frontmatter 解析。
- **渐进式披露**：只有 `name + description` 进系统提示词（`markdownSkillIndexText()`，
  插在核心规则之后）；正文**不进前缀**。
- **索引随会话边界刷新，无需额外 flush 逻辑**：系统提示词在会话内是逐字节复用的
  （`conversation.js` 存 `prevBuf.systemPrompt`），所以增删技能不会当场打断缓存，
  只在下个会话生效 —— 正是"批量 flush 到会话关闭"想要的效果。
- 加载正文的两条路：① 模型调 `load_skill`（按名取正文，工具结果落在尾部）；
  ② **触发词命中**时 `orchestrator` 把正文作为**尾部 system 消息**追加（铁律二：只追加不改前缀）；
  已在 messages 里出现过的技能不重复追加。
- 工具：`load_skill` / `list_skills` / `remember_skill`（后者受 `allowAutoCreate` 管，默认关）。
  可用性一律走 `tool-registry` 的判定（新增 5.6 步）——总开关关时模型**连工具都看不见**。
- 配置（`config.markdownSkills`，**不写进 `config.skills`** —— 那是 JS 技能的命名空间）：
  `enabled`（默认关）/ `indexMode`（`prompt`|`tool`）/ `maxBodyChars` / `allowAutoCreate` / `items`。
- 接口：`GET /api/markdown-skills`（`?withBody=1` 带正文）、`POST .../settings`、
  `POST .../reload`、`POST /:id`（新建 / 改内容 / 切开关）、`DELETE /:id`。
- 界面：**独立页签**「扩展 → 自动学习」（`#view-autolearn`）。与「技能」页分开是刻意的：
  那页放的是**人写的 JS 扩展**（注册工具、能执行动作），这里放的是**模型自己攒的**东西
  （只有提示词），混在一页会分不清"这条到底是谁写的"。
  页面结构：`后台评审` 设置卡 + `Markdown 技能` 设置卡 + 技能卡片列表；
  复用 `usage-wrap / usage-h3 / module-grid / mcard`，输入框用 `.inp`，与项目其它页一致。
  - ⚠️ 界面位置改过两次：先插成 `#skills-page` 的兄弟节点（`#view-skills` 是 `display:flex`，
    结果变成左右两栏各占一半），再改为页内区块，最终拆成独立页签 —— 技能页的改动已全部回退。

**L5 · 轨迹导出**（新增 `src/trajectory-export.js` + `scripts/export-trajectories.mjs`）

- 读 `data/conversations/archive` 的会话归档 → ShareGPT / OpenAI messages 的 JSONL。
- 只保留"一问一答"：跳过只调工具没说话的 assistant 条目；丢掉开头没有 user 的部分；
  没有一问一答的归档产出 0 条。图片折成 `[图片]`。
- **默认脱敏**（QQ 号 / 群号 / 裸数字 → `<id>` / `<num>`）；要原始数据必须显式关掉。
- CLI：`npm run export:trajectories`，支持 `--out / --format / --chat / --limit /
  --no-system / --with-tools / --no-redact`。
- 接口 `POST /api/export-trajectories`；界面在「用量与成本」页头加了「导出训练数据」按钮
  （弹窗里可选格式 / 会话 / 条数 / 是否脱敏，并提示隐私风险）。
- 落地路径写在文档与脚本输出里：**先导出 → 先精选 few-shot 示例放进提示词 →
  人设定稿、few-shot 不够用了再考虑微调**。

**测试**

- 新增 `test/markdown-skill-test.mjs`（13 条）与 `test/export-trajectories-test.mjs`（11 条），
  均已挂进 `npm test` 主链。
- `test/coverage-http.mjs` 补 5 条新路由覆盖：接口覆盖率 88%（95/108），
  较改动前的 87% 略升；`npm test` 全绿（38 套件）。

**行为变化（需知）**

- 默认**全部关闭**（`markdownSkills.enabled = false`）：不开启时提示词、工具、界面均无变化。
- 开启后：系统提示词多出【可加载技能】段（只有名字+说明，逐字节稳定）；
  命中触发词时该轮 messages 尾部多一条 system 消息。
- 新增 `data/markdown-skill-stats.json`（命中统计）与 `data/exports/`（导出产物）。

**踩坑记录（供后续参考）**

- `POST /api/markdown-skills/:id` 第一版把"技能不存在"一律当编辑处理 → 新建返回 404。
  后果不只是功能错：**404 时请求体没被消费，HTTP 连接挂住**，导致覆盖测试在 `teardown()`
  卡死（进程 5 分钟不退出）。已修：新建需要 `name`，缺省字段才沿用现有值。
- 归档里的 `systemPrompt` 是**独立字段**（`conversation.js` 存缓冲时把 system 从 messages
  剥掉了），不是 messages 里的 system 条目 —— 导出时必须先读该字段。

### 2026-10-17 · L3（续接期后台评审）

**新增 `src/auto-review.js`**

- 触发（全部满足才跑）：`autoLearn.enabled` 开、该会话不在评审中、缓冲存在、
  `buf.turns % intervalTurns === 0`。用 `turns` 取模而不是另起计数器 —— 缓冲里的 turns
  本来就是"本会话第几轮"，多一份计数既要在重启后恢复、又容易和真实状态对不上。
- 触发点：`orchestrator` 在 `conversation.save()` 之后，且只在
  `session.continuation.mode === 'continuation'` 时（fresh 轮已由关闭蒸馏兜底）。
- **旁路调用**：独立 messages，结果只落盘，绝不进主会话前缀。
- **不复用主会话前缀**：评审是元任务，拿"群友人设"提示词当前缀会让模型接着扮演群友。
  改用独立的小提示词 + 输入按 6000 字符预算截断。
- 产出两类：
  - **记忆** → `memory.appendSelf(chatKey, content, { kind, ownerActive })`，自动继承 L4b 的
    初始权重（rule×主人=5 等）与去重；
  - **技能** → `saveMarkdownSkill({ ..., source: 'auto' })`。手写技能**不覆盖**；
    新建受 `createNewSkill` 与 `maxAutoSkills` 双重约束（0 = 不许新建，但允许更新已有的自动技能）。
- 统计落盘 `data/auto-learn-stats.json`（runs / lastRunAt / lastStatus / 累计条数），供 UI 显示。

**配置 / 接口 / 界面**

- `config.autoLearn`：`enabled`（默认关）/ `intervalTurns`（8）/ `maxMemories`（2）/
  `createNewSkill`（false）/ `maxAutoSkills`（10）。
- 接口：`GET /api/auto-learn`（设置 + 统计）、`POST /api/auto-learn/settings`。
- 界面：**独立页签**「扩展 → 自动学习」里的「后台评审」卡 —— 总开关、间隔、
  单次记忆条数、允许新建技能、自动技能上限，以及"已跑 N 次 / 累计写入 / 上次结果"。
  全部在 UI 里改，不需要手改 config。
- 与 `markdownSkills.allowAutoCreate` 的分工写进了注释与界面文案：
  那个管"模型在聊天中主动写技能（`remember_skill`）"，这个管"后台定时复盘"，两条独立路径。

**测试**

- 新增 `test/auto-review-test.mjs`（20 条，已挂进 `npm test`）。
- `test/coverage-http.mjs` 补 2 条路由覆盖：接口覆盖率 88%（97/110），`npm test` 全绿（39 套件）。

**行为变化（需知）**

- 默认关闭；开启后**每 N 轮续接多一次模型调用**（这是唯一新增的固定成本）。
- 评审的写入会进 `_self.json` 与 `skills/<id>/SKILL.md`（后者仅当允许新建时）。

**踩坑记录**

- 配置钳制第一版写成 `Number(v) || 默认值`，把**合法的 0** 吃掉了 ——
  `maxAutoSkills: 0`（表示"不许自动新建技能"）会被替换成 10。已改为只把非有限数当缺失
  （`clampInt`）。

**界面调整（同日）**

- 新增「扩展 → 自动学习」**独立页签**：`#view-autolearn` / `#autolearn-page`；
  `ext-submenu` 加第三项，`initSubmenu` 与 `switchTab` 同步注册。
- 技能页（`#skills-page`）此前误加的两个区块**已全部回退**：`renderModulePage` 不再拼
  `mdHtml` / `autoLearnHtml`，`bindModulePageEvents` 也不再绑它们。
- 视觉对齐项目既有风格：`usage-wrap / usage-head / usage-h3 / module-grid / mcard / uc-tag`；
  输入框统一加 `.inp`（裸 `input` 只有 `font:inherit`，不套类会露出浏览器默认外观）；
  设置卡的 `.mcard-desc` 解掉 2 行截断（`-webkit-line-clamp:unset`），否则说明文字被吃掉。
- 测试同步：`coverage-wiring` 的视图清单加 `autolearn`（9 个视图）；
  `ext-submenu-ui` 的二级项断言从硬编码 2 项改为按 `pages.length` 校验。
