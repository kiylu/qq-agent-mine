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
  distillBuffer, collectAssistantText, parseDistillResult, DISTILL_SYSTEM_PROMPT
} = await import('../src/conversation.js');
const { MemoryStore } = await import('../src/memory.js');

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
await check('collectAssistantText：只取 assistant 正文，跳过工具参数与 user', () => {
  const msgs = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '我在想谜底是苹果' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'send_message', arguments: '{"text":"hi"}' } }] },
    { role: 'tool', content: '发送成功' },
    { role: 'assistant', content: [{ type: 'text', text: '补充一句' }] }
  ];
  const t = collectAssistantText(msgs);
  assert.ok(t.includes('我在想谜底是苹果'), '应含第一条思考');
  assert.ok(t.includes('补充一句'), '应含数组形态的文本');
  assert.ok(!t.includes('send_message'), '不应含工具名');
  assert.ok(!t.includes('发送成功'), '不应含 tool 结果');
  assert.ok(!t.includes('你好'), '不应含 user 内容');
});

await check('collectAssistantText：遵守 maxChars 预算', () => {
  const msgs = [{ role: 'assistant', content: 'x'.repeat(5000) }];
  const t = collectAssistantText(msgs, { maxChars: 1000 });
  assert.equal(t.length, 1000, '应截断到预算');
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

console.log(`\n自身记忆与蒸馏：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
