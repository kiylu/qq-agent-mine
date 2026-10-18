// 自身记忆 + 会话关闭蒸馏（②P2）单元测试：
//   1. MemoryStore 的 selfNote：appendSelf / selfNotes / hasSelf / clearSelf / 去重 / 上限
//   2. _self.json 不得被当成"群友印象"混进成员列表（scan 要跳过）
//   3. formatSelfForPrompt：渲染【自身状态】段；空 → ''
//   4. collectAssistantText：只取 assistant 正文，跳过工具调用参数
//   5. parseDistillResult：容错解析（markdown 围栏 / 对象数组 / 非法输入 / 去重 / 上限）
//   6. distillBuffer：把思考蒸馏写进自身记忆（注入假 callModel，校验提示词与落点）
//   7. 提示词注入：【自身状态】出现在【记忆】之后（易变区），且没有内容时不注入
// 纯离线：隔离数据目录 + 假模型。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-self-'));
process.env.QQ_AGENT_DATA_DIR = __testDataDir;

const {
  distillBuffer, collectAssistantText, parseDistillResult, parseDistillEntries,
  DISTILL_SYSTEM_PROMPT, DISTILL_SYSTEM_PROMPT_BASIC
} = await import('../src/conversation.js');
const { MemoryStore, initialSelfScore, effectiveSelfScore, isSelfExpired } = await import('../src/memory.js');

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const KEY = 'group:999';

// ═══ 1. selfNote 基础 ═══
await check('appendSelf 写入并可读回；重复内容不重复写', () => {
  const m = new MemoryStore();
  const e1 = m.appendSelf(KEY, '我正在和群友玩海龟汤');
  assert.ok(e1 && e1.content === '我正在和群友玩海龟汤');
  const e2 = m.appendSelf(KEY, '我正在和群友玩海龟汤');
  assert.equal(e2.content, e1.content, '重复内容应返回已存在条目');
  const list = m.selfNotes(KEY);
  assert.equal(list.length, 1, '去重后应只有 1 条');
  assert.ok(m.hasSelf(KEY), 'hasSelf 应为 true');
});

await check('appendSelf 落盘：新实例仍能读到（跨重启关键）', () => {
  const m2 = new MemoryStore();
  const list = m2.selfNotes(KEY);
  assert.equal(list.length, 1);
  assert.equal(list[0].content, '我正在和群友玩海龟汤');
});

await check('appendSelf 空内容 → null，不写入', () => {
  const m = new MemoryStore();
  assert.equal(m.appendSelf(KEY, '   '), null);
  assert.equal(m.appendSelf(KEY, ''), null);
});

await check('appendSelf 超上限时只留最近 N 条', () => {
  const m = new MemoryStore();
  const k = 'group:777';
  for (let i = 0; i < 50; i++) m.appendSelf(k, `状态 ${i}`, { max: 40 });
  const list = m.selfNotes(k);
  assert.equal(list.length, 40, '应裁剪到 40 条');
  assert.ok(list.some((e) => e.content === '状态 49'), '最新一条应保留');
  assert.ok(!list.some((e) => e.content === '状态 0'), '最早一条应被裁掉');
});

await check('_self.json 不会被当成群友印象（成员列表不含它）', () => {
  const m = new MemoryStore();
  const k = 'group:888';
  m.appendSelf(k, '我的私有状态');
  m.append(k, 'memberImpression', '他爱发猫图', { userId: '12345', target: '小明' });
  const members = m.members(k);
  assert.equal(members.length, 1, '成员应只有小明一个');
  assert.equal(members[0].userId, '12345');
  assert.ok(!members.some((x) => String(x.name || '').includes('self')), '不应混入 _self');
});

await check('clearSelf 清空自身记忆', () => {
  const m = new MemoryStore();
  const k = 'group:888';
  assert.ok(m.hasSelf(k));
  assert.ok(m.clearSelf(k));
  assert.equal(m.hasSelf(k), false);
});

// ═══ 2. formatSelfForPrompt ═══
await check('formatSelfForPrompt：有内容渲染【自身状态】，空返回 ""', () => {
  const m = new MemoryStore();
  const k = 'group:555';
  assert.equal(m.formatSelfForPrompt(k), '', '空时应返回空串');
  m.appendSelf(k, '待办：帮小明查天气');
  const text = m.formatSelfForPrompt(k);
  assert.ok(text.includes('【自身状态】'), '应带段名');
  assert.ok(text.includes('待办：帮小明查天气'), '应含条目内容');
});

// ═══ 3. collectAssistantText ═══
await check('collectAssistantText：思考 + 实际发言 + 正文，跳过 user / tool 结果', () => {
  const msgs = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '我在想谜底是苹果' },
    // 本项目发言走 send_message，content 为空 —— 必须能从工具参数里取到。
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'send_message', arguments: '{"messages":["在的"]}' } }] },
    { role: 'tool', content: '发送成功' },
    { role: 'assistant', content: [{ type: 'text', text: '补充一句' }] }
  ];
  const t = collectAssistantText(msgs);
  assert.ok(t.includes('我在想谜底是苹果'), '应含第一条思考');
  assert.ok(t.includes('补充一句'), '应含数组形态的文本');
  assert.ok(t.includes('在的'), '应含实际说出口的话（在 tool_calls 里）');
  assert.ok(!t.includes('send_message'), '不应含工具名');
  assert.ok(!t.includes('发送成功'), '不应含 tool 结果');
  assert.ok(!t.includes('你好'), '不应含 user 消息');
  assert.ok(!t.includes('你好'), '不应含 user 内容');
});

await check('collectAssistantText：遵守 maxChars 预算', () => {
  const msgs = [{ role: 'assistant', content: 'x'.repeat(5000) }];
  const t = collectAssistantText(msgs, { maxChars: 1000 });
  assert.equal(t.length, 1000, '应截断到预算');
});

// ── reasoning_content（2026-10-04）：真实运行的模型正文恒为空、思考全在
//    reasoning_content 里。只读 content 时 collectAssistantText 恒返回空串，
//    蒸馏必然产不出东西（用户点「重开并蒸馏」后什么都没有）。
await check('collectAssistantText：reasoning_content 是主要素材来源', () => {
  const msgs = [
    { role: 'user', content: '你是谁' },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'send_message', arguments: '{"text":"我是 Ech0es"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '发送成功' }
  ];
  const reasonings = ['', '他又在测我，直接报名字。', ''];
  const t = collectAssistantText(msgs, { reasonings });
  assert.ok(t.includes('他又在测我'), '应取到旁路的 reasoning');
  assert.ok(!t.includes('send_message'), '仍不应含工具名');
  assert.ok(!t.includes('发送成功'), '仍不应含 tool 结果');
});

await check('collectAssistantText：reasoning 与正文都收（推理在前）', () => {
  const msgs = [{ role: 'assistant', content: '最后决定回他一句' }];
  const t = collectAssistantText(msgs, { reasonings: ['先想想怎么说', ''] });
  assert.ok(t.includes('先想想怎么说'), '应含 reasoning');
  assert.ok(t.includes('最后决定回他一句'), '应含正文');
  assert.ok(t.indexOf('先想想怎么说') < t.indexOf('最后决定回他一句'), 'reasoning 应排在正文前');
});

await check('collectAssistantText：兼容 raw 里嵌套的老形态', () => {
  const msgs = [{
    role: 'assistant',
    content: null,
    raw: { choices: [{ message: { reasoning_content: '藏在 raw 里的思考' } }] }
  }];
  const t = collectAssistantText(msgs);
  assert.ok(t.includes('藏在 raw 里的思考'), '应能从 raw.choices 兜底取到');
});

// ═══ 4. parseDistillResult ═══
await check('parseDistillResult：直接 JSON 数组', () => {
  assert.deepEqual(parseDistillResult('["A","B"]'), ['A', 'B']);
});

await check('parseDistillResult：剥 markdown 围栏', () => {
  const t = '```json\n["谜底是苹果"]\n```';
  assert.deepEqual(parseDistillResult(t), ['谜底是苹果']);
});

await check('parseDistillResult：对象数组取 content 字段', () => {
  assert.deepEqual(parseDistillResult('[{"content":"A"},{"content":"B"}]'), ['A', 'B']);
});

await check('parseDistillResult：非法输入/空数组 → []', () => {
  assert.deepEqual(parseDistillResult(''), []);
  assert.deepEqual(parseDistillResult('[]'), []);
  assert.deepEqual(parseDistillResult('这不是 JSON'), []);
  assert.deepEqual(parseDistillResult('{"a":1}'), []);
});

await check('parseDistillResult：去重 + 上限 5 条', () => {
  const t = '["A","A","B","C","D","E","F","G"]';
  const out = parseDistillResult(t);
  assert.equal(out.length, 5, '应最多 5 条');
  assert.equal(out[0], 'A');
  assert.equal(out.filter((x) => x === 'A').length, 1, '应去重');
});

// ═══ 5. distillBuffer ═══
await check('distillBuffer：把思考蒸馏进自身记忆（校验提示词与落点）', async () => {
  const m = new MemoryStore();
  const k = 'group:321';
  let sawSystem = '', sawUser = '';
  const callModel = async ({ messages }) => {
    sawSystem = messages[0].content;
    sawUser = messages[1].content;
    return { message: { content: '["海龟汤进行中，谜底是苹果","我承诺不主动说答案"]' } };
  };
  const written = await distillBuffer({
    memory: m, chatKey: k,
    messages: [{ role: 'assistant', content: '我在想……谜底其实是苹果，先别说' }],
    callModel
  });
  assert.equal(written.length, 2, '应写入 2 条');
  assert.equal(sawSystem, DISTILL_SYSTEM_PROMPT, '系统提示应是蒸馏专用提示词');
  assert.ok(sawUser.includes('谜底其实是苹果'), '用户消息应带 CoT 原文');
  const list = m.selfNotes(k);
  assert.equal(list.length, 2, '自身记忆应有 2 条');
  assert.ok(list.some((e) => e.content === '海龟汤进行中，谜底是苹果'));
});

await check('distillBuffer：无 assistant 文本 → 不调模型，返回 []', async () => {
  const m = new MemoryStore();
  let called = false;
  const written = await distillBuffer({
    memory: m, chatKey: 'group:322',
    messages: [{ role: 'user', content: '你好' }],
    callModel: async () => { called = true; return { message: { content: '["x"]' } }; }
  });
  assert.equal(written.length, 0);
  assert.equal(called, false, '没有可蒸馏文本时不应调用模型');
});

// 真实场景：deepseek-flash 这类模型正文恒为空，思考全在 reasoning_content 里。
// 没有这条，蒸馏在真实运行中恒返回 skipped-empty-cot（点了按钮没反应）。
await check('distillBuffer：正文空但有 reasoning_content → 照样蒸馏成功', async () => {
  const m = new MemoryStore();
  const k = 'group:324';
  let sawUser = '';
  const written = await distillBuffer({
    memory: m, chatKey: k,
    messages: [
      { role: 'user', content: '海龟汤来一局' },
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'send_message', arguments: '{}' } }] }
    ],
    reasonings: ['', '我出的谜底是镜子，记住别主动说破。'],
    callModel: async ({ messages }) => {
      sawUser = messages[1].content;
      return { message: { content: '["海龟汤进行中，谜底是镜子"]' } };
    }
  });
  assert.equal(written.status, 'ok', `应蒸馏成功，实际 ${written.status}（${written.reason || ''}）`);
  assert.ok(sawUser.includes('谜底是镜子'), '蒸馏输入应带上 reasoning 原文');
  assert.equal(m.selfNotes(k).length, 1, '应写入自身状态');
});

await check('distillBuffer：模型返回空数组 → 不写入任何条目', async () => {
  const m = new MemoryStore();
  const k = 'group:323';
  const written = await distillBuffer({
    memory: m, chatKey: k,
    messages: [{ role: 'assistant', content: '只是闲聊了一句' }],
    callModel: async () => ({ message: { content: '[]' } })
  });
  assert.equal(written.length, 0);
  assert.equal(m.selfNotes(k).length, 0);
});

// ═══ 6. L4b 记忆权重机制 ═══
await check('L4b：初始权重按来源区分', () => {
  assert.equal(initialSelfScore({ kind: 'rule', ownerActive: true }), 5);
  assert.equal(initialSelfScore({ kind: 'rule', ownerActive: false }), 2);
  assert.equal(initialSelfScore({ kind: 'state', ownerActive: true }), 3);
  assert.equal(initialSelfScore({ kind: 'state', ownerActive: false }), 1);
});

await check('L4b：有效权重随时间衰减（半衰期）', () => {
  const now = Date.now();
  const e = { score: 4, createdAt: now - 30 * 86400000, lastHitAt: 0 };
  const s = effectiveSelfScore(e, now, 30);
  assert.ok(Math.abs(s - 2) < 0.01, `30 天应衰减一半，实际 ${s}`);
});

await check('L4b：超上限时按权重淘汰 —— 高权重的 rule 不被普通 state 挤掉', () => {
  const m = new MemoryStore();
  const k = 'group:910';
  m.appendSelf(k, '别每次都总结式收尾', { kind: 'rule', ownerActive: true });  // 5 分
  for (let i = 0; i < 49; i++) m.appendSelf(k, `普通状态 ${i}`, { max: 40 });
  const list = m.selfNotes(k);
  assert.equal(list.length, 40, '应裁到 40 条');
  assert.ok(list.some((e) => e.content === '别每次都总结式收尾'), '高权重 rule 必须留下');
  assert.ok(!list.some((e) => e.content === '普通状态 0'), '低分的旧状态应先被淘汰');
});

await check('L4b：被淘汰的条目进回收站，可恢复', () => {
  const m = new MemoryStore();
  const k = 'group:911';
  for (let i = 0; i < 45; i++) m.appendSelf(k, `状态 ${i}`, { max: 40 });
  const evicted = m.evictedSelf(k);
  assert.equal(evicted.length, 5, `应有 5 条进回收站，实际 ${evicted.length}`);
  assert.ok(evicted.some((e) => e.content === '状态 0'), '最早那条应被淘汰进回收站');
  const restored = m.restoreSelf(k, '状态 0');
  assert.ok(restored && restored.content === '状态 0', '应能恢复');
  assert.ok(m.selfNotes(k).some((e) => e.content === '状态 0'), '恢复后应回到自身状态');
  assert.ok(!m.evictedSelf(k).some((e) => e.content === '状态 0'), '恢复后应从回收站移除');
});

await check('L4b：注入按权重取前 N —— 重要但旧的条目不被挤出窗口', () => {
  const m = new MemoryStore();
  const k = 'group:912';
  m.appendSelf(k, '群友说别用总结式收尾', { kind: 'rule', ownerActive: true });  // 5 分
  for (let i = 0; i < 12; i++) m.appendSelf(k, `琐碎状态 ${i}`);                  // 各 1 分
  const text = m.formatSelfForPrompt(k, { limit: 5 });
  assert.ok(text.includes('群友说别用总结式收尾'), '高权重条目必须在注入窗口里');
  assert.ok(!text.includes('琐碎状态 0'), '低权重的旧条目应被挤出窗口');
});

await check('L4b：_evicted.json 不会被当成群友印象', () => {
  const m = new MemoryStore();
  const k = 'group:913';
  for (let i = 0; i < 45; i++) m.appendSelf(k, `状态 ${i}`, { max: 40 });
  m.append(k, 'memberImpression', '他爱发猫图', { userId: '12345', target: '小明' });
  const members = m.members(k);
  assert.equal(members.length, 1, '成员应只有小明');
  assert.ok(!members.some((x) => String(x.name || '').includes('evicted')), '不应混入 _evicted');
});

// ═══ 7. L1 沉淀质量（纠正信号）═══
await check('L1：默认蒸馏提示词包含"群友纠正"信号与 rule 说明', () => {
  assert.ok(DISTILL_SYSTEM_PROMPT.includes('纠正'), '应含纠正信号');
  assert.ok(DISTILL_SYSTEM_PROMPT.includes('rule'), '应说明 rule 类');
});

await check('L1：parseDistillEntries 解析 kind（并兼容纯字符串）', () => {
  const out = parseDistillEntries(
    '[{"kind":"rule","content":"别总结"},{"kind":"state","content":"谜底是镜子"},"旧格式"]'
  );
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, 'rule');
  assert.equal(out[0].content, '别总结');
  assert.equal(out[1].kind, 'state');
  assert.equal(out[2].kind, 'state', '纯字符串按 state 处理');
});

await check('L1：distillBuffer 把 rule 条目按高权重写入', async () => {
  const m = new MemoryStore();
  const k = 'group:920';
  const written = await distillBuffer({
    memory: m, chatKey: k,
    messages: [{ role: 'assistant', content: '群友嫌我总结太多，以后别这样' }],
    ownerActive: true,
    callModel: async () => ({ message: { content: '[{"kind":"rule","content":"别用总结式收尾"}]' } })
  });
  assert.equal(written.status, 'ok');
  assert.equal(written.entries[0].kind, 'rule');
  const note = m.selfNotes(k).find((e) => e.content === '别用总结式收尾');
  assert.ok(note, '应写入自身状态');
  assert.equal(note.kind, 'rule');
  assert.equal(note.score, 5, '主人触发 + rule → 初始 5 分');
});

await check('L1：signals=false 时退回旧口径提示词', async () => {
  const m = new MemoryStore();
  let sawSystem = '';
  await distillBuffer({
    memory: m, chatKey: 'group:921',
    messages: [{ role: 'assistant', content: '随便想想' }],
    signals: false,
    callModel: async ({ messages }) => {
      sawSystem = messages[0].content;
      return { message: { content: '[]' } };
    }
  });
  assert.equal(sawSystem, DISTILL_SYSTEM_PROMPT_BASIC);
});

// ── 2026-10-17：state 过期（治"一次性计划塞满注入窗口"）──────────────────────

await check('TTL：state 超期后不再注入，rule 不受影响', async () => {
  const m = new MemoryStore();
  const k = 'group:930';
  m.appendSelf(k, '旧状态：还在猜海龟汤的谜底', { kind: 'state' });
  m.appendSelf(k, '旧规则：别用总结式收尾', { kind: 'rule' });
  // 手工把两条的 createdAt 拨到 5 天前（模拟过期）
  const file = path.join(__testDataDir, 'memory', 'group_930', '_self.json');
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of arr) e.createdAt = Date.now() - 5 * 86400000;
  fs.writeFileSync(file, JSON.stringify(arr), 'utf8');

  const text = m.formatSelfForPrompt(k);
  assert.ok(text.includes('别用总结式收尾'), 'rule 不该过期');
  assert.ok(!text.includes('旧状态'), 'state 超期后不该注入');
  const old = m.selfNotes(k).find((e) => e.content.includes('旧状态'));
  assert.equal(old.expired, true, 'selfNotes 应标记 expired');
  const rule = m.selfNotes(k).find((e) => e.content.includes('旧规则'));
  assert.equal(rule.expired, false);
});

await check('TTL：isSelfExpired 的边界（rule 恒不过期 / ttl<=0 关闭）', async () => {
  const now = Date.now();
  const old = now - 10 * 86400000;
  assert.equal(isSelfExpired({ kind: 'state', createdAt: old }, now, 72), true);
  assert.equal(isSelfExpired({ kind: 'state', createdAt: now }, now, 72), false);
  assert.equal(isSelfExpired({ kind: 'rule', createdAt: old }, now, 72), false, 'rule 永不过期');
  assert.equal(isSelfExpired({ kind: 'state', createdAt: old }, now, 0), false, 'ttl=0 表示关闭');
});

await check('自身状态：removeSelf 移入回收站并可恢复', async () => {
  const m = new MemoryStore();
  const k = 'group:931';
  m.appendSelf(k, '我准备回一句吐槽', { kind: 'state' });
  m.appendSelf(k, '别用总结式收尾', { kind: 'rule' });
  const removed = m.removeSelf(k, '我准备回一句吐槽');
  assert.ok(removed, '应删掉一条');
  assert.equal(m.selfNotes(k).length, 1);
  assert.ok(m.evictedSelf(k).some((e) => e.content === '我准备回一句吐槽'), '应进回收站');
  const back = m.restoreSelf(k, '我准备回一句吐槽');
  assert.ok(back, '应能恢复');
  assert.equal(m.selfNotes(k).length, 2);
});

await check('自身状态：clearSelf({toEvicted}) 整批进回收站', async () => {
  const m = new MemoryStore();
  const k = 'group:932';
  m.appendSelf(k, '甲', { kind: 'state' });
  m.appendSelf(k, '乙', { kind: 'rule' });
  m.clearSelf(k, { toEvicted: true });
  assert.equal(m.selfNotes(k).length, 0);
  assert.equal(m.evictedSelf(k).length, 2, '两条都该在回收站');
});

await check('L1：蒸馏提示词含「不要写」清单，且上限收到 3 条', async () => {
  assert.ok(DISTILL_SYSTEM_PROMPT.includes('【不要写】'), '应有排除清单');
  assert.ok(DISTILL_SYSTEM_PROMPT.includes('打算 / 准备 / 决定'), '应点名"计划类"污染');
  assert.ok(DISTILL_SYSTEM_PROMPT.includes('最多 3 条'), '上限应收到 3');
});

await check('L1：关闭蒸馏最多写 3 条（模型多给也不收）', async () => {
  const m = new MemoryStore();
  const written = await distillBuffer({
    memory: m, chatKey: 'group:933',
    messages: [{ role: 'assistant', content: '想了五件事' }],
    callModel: async () => ({
      message: { content: JSON.stringify([1, 2, 3, 4, 5].map((i) => ({ kind: 'state', content: `第${i}条` }))) }
    })
  });
  assert.equal(written.itemCount, 3);
});

console.log(`\n自身记忆与蒸馏：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
