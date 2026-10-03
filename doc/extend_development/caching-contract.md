# 扩展的缓存契约（写 Skill / Plugin 必读）

> **一句话**：你注入的提示词文本，每一轮都必须**逐字节相同**。
> 做到这一点成本最低；做不到，成本可能翻好几倍，而且界面**不会告诉你**。

本文是给**外部扩展作者**的约定。核心机制见
[prompt-pipeline.md](./prompt-pipeline.md)（讲核心怎么组装提示词），
内部排查记录见 `doc/skill-plugin-compat-2026-10-03.md`。

---

## 0. 为什么这条这么重要

模型调用是按 **token 计价**的，其中「缓存命中」的部分单价极低（通常只有普通输入的
1/10）。而缓存命中的前提是：**本轮请求的开头部分，与上一轮逐字节相同**。

工程上我们做了两件事：

1. **会话延续** —— 同一会话的对话历史复用，不重发全部内容
2. **前缀缓存** —— 复用的那部分按折扣价计费

这两件事**都依赖同一个前提：开头那段字节不能变**。所以只要你动了它：

- 轻则这一轮缓存全不命中（按全价计费）
- 重则整个会话**永远无法延续**，每轮都当成新会话，模型失去全部上下文

而且**界面不会报错、不会提示**。你只会看到费用 unexplained 地变高。

---

## 1. 三条铁律

### 铁律一：`promptSections()` 可以动态，但返回值必须稳定

`prompt.sections`（静态声明）天然安全。`promptSections(ctx)` 是**动态函数**，
安全与否**完全取决于你返回的内容每轮是否相同**。

核心判断方式（`orchestrator.js`）：

```js
// 逐字节比较 systemPrompt 是否变化
if (prevBuf.systemPrompt !== systemPrompt) → 判定为 fresh（会话不续用）
```

因此：

| 写法 | 结果 |
|---|---|
| `promptSections(ctx)` 每次返回**相同**文本 | ✅ 安全 |
| `promptSections(ctx)` 返回随 `ctx.sessionId` 变化的内容 | ❌ **每轮 fresh** |
| `promptSections(ctx)` 返回带时间戳 / 随机数 / 计数器的内容 | ❌ **每轮 fresh** |
| `promptSections(ctx)` 返回随「上一轮对话」变化的内容 | ❌ **每轮 fresh** |

**反面例子**（每轮必 fresh）：

```js
export function promptSections(ctx) {
  return [{
    id: 'memory',
    title: '记忆',
    content: `当前是第 ${ctx.turns} 轮，会话 ${ctx.sessionId}，` +
             `时间 ${new Date().toISOString()}`   // ← 每次都不一样
  }];
}
```

**正确写法**（内容稳定，变化的部分交给工具按需取）：

```js
export function promptSections(ctx) {
  return [{
    id: 'memory',
    title: '记忆',
    // 固定的一句说明；具体记忆由模型自己调 memory_search 工具去查
    content: '需要回顾之前聊过什么时，用 memory_search 工具查询，不要凭印象作答。'
  }];
}
```

> 💡 判断标准：**「这段文字换个时间看，还成立吗？」**
> 成立 → 放 `promptSections`；不成立 → 做成工具，让模型自己去取。

### 铁律二：不要改写已有的 system 消息

`before-llm-messages` 钩子拿到的是**已拼好的 messages 数组**，你可以改它。
但如果你**原地改写已存在的 system 消息**，后果比铁律一更隐蔽：

```js
// ❌ 绝对不要这样
const sys = messages.find(m => m.role === 'system');
sys.content += '\n\n【待办】' + JSON.stringify(pending);   // 改写了既有字节
```

**为什么这条比铁律一更危险**：

| | 铁律一（改 systemPrompt） | 铁律二（改 system 消息） |
|---|---|---|
| 会话延续 | ❌ 每轮 fresh，延续失效 | ✅ 不受影响（判定在 hook 之前跑完） |
| 前缀缓存 | ❌ 全不命中 | ❌ **全不命中** |
| 界面提示 | 会话卡片显示「续用/新开」 | **完全没有** |

也就是说，改写 system 消息**不会**触发 fresh，所以从会话卡片上看一切正常，
但每一轮都在按全价重算。你只能靠对账发现成本异常。

**正确做法**：

```js
// ✅ 追加新消息，不动已有的
messages.push({
  role: 'system',
  content: '【脑内闪过】' + association
});

// ✅ 或者：根本不用这个钩子，把能力做成工具
```

`messages.push()` 是安全的 —— 追加在末尾不影响前缀。
但注意：**push 进去的内容会进入会话缓冲**，成为下一轮前缀的一部分。
所以 push 的内容**也必须每轮稳定**，否则同样击穿下一轮缓存。

### 铁律三：`available()` 的判定要稳定

工具集是**集合比较**：只要可用工具的名字集合变了，就触发 fresh。

```js
// ❌ 首探和后台探测结果可能不同 → 工具集抖动 → 每轮 fresh
export function available() {
  return checkSomethingAsync();   // 返回不稳定
}
```

文档其他章节推荐的「首次乐观放行 + 后台探测 + 缓存结果」写法
（见 [skill-reference.md](./skill-reference.md)）本身是好的，
但**必须保证探测结果一旦确定就不再变**：

```js
let _cached = null;
export function available() {
  if (_cached === null) _cached = detect();   // 只探测一次，之后永远返回同一个值
  return _cached;
}
```

---

## 2. 上架前请自查

核心提供一个**确定性体检接口**（不调用大模型，纯静态判定）：

```bash
GET /api/skills/cache-impact              # 体检当前生效中的扩展
GET /api/skills/cache-impact?onlyActive=0  # 连未启用的也一起查（排查用）
```

返回里几个关键字段：

| 字段 | 含义 | 后果 |
|---|---|---|
| `dynamicSections` | `promptSections` 输出随上下文变化 | **danger**：每轮 fresh + 缓存全不命中 |
| `systemRewriteHook` | 运行时探测到 hook 改写了既有 system 消息 | **danger**：击穿缓存，且界面无提示 |
| `staticSystemWrite` | 静态扫描：源码里有 `role==='system'` + `content +=` 模式 | **danger**：同上，补数据依赖型的漏检 |
| `unstableAvailable` | 连续两次 `available()` 结果不一致 | **warn**：工具集抖动 → fresh |
| `level` | `ok` / `warn` / `danger` | 汇总判定 |

> `staticSystemWrite` 是**静态扫描**，可能误报（比如「取 system 只为读、不写」）。
> 界面上 `ok` 不显示徽标，`warn` / `danger` 才会标出来。

**判定为 `danger` 时，UI 会在技能/插件卡片名后显示徽标。** 发布前请务必确认
自己的扩展是 `ok`。

---

## 3. 常见疑问

**Q：我确实需要注入随轮次变化的内容（比如「上一轮想到哪了」）怎么办？**

用**工具**，不要用提示词注入。提供 `memory_search` 之类的工具，让模型在需要时
自己去查。这样：
- 不占每轮的固定 token
- 不影响前缀缓存
- 模型可以选择「不查」，避免无谓消耗

**Q：怎么确认我的扩展是不是有问题？**

三步：
1. 调 `GET /api/skills/cache-impact`，看自己的 `level`
2. 装上后在会话页看卡片：显示「新开」而你们明明在连续对话 → 铁律一被触发
3. 对账成本：缓存命中率异常低 → 大概率是铁律二

**Q：`systemRewriteHook` 明明是 `false`，但我确实在改 system 消息？**

如果你的改写是**数据依赖型**的（比如「有待办时才注入」），冷启动试跑时没有数据，
运行时探测就看不到改动。静态扫描 `staticSystemWrite` 是为此设计的兜底判据。
**以 `staticSystemWrite` 为准。**

**Q：异步的 `before-llm-messages` 会被判定为改写吗？**

不会。异步 hook 无法同步判定，接口会给「建议人工确认」提示，不会误判。

---

## 相关文档

- [prompt-pipeline.md](./prompt-pipeline.md) —— 核心提示词的组装流水线
- [skill-development.md](./skill-development.md) —— LLM 型技能（`skills/`）开发
- [plugin-development.md](./plugin-development.md) —— 确定性型插件（`plugins/`）开发
- [skill-reference.md](./skill-reference.md) —— 清单字段 / API 完整参考
