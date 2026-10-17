// 自动学习（L3）单元测试：
//   1. 配置默认值与钳制（intervalTurns / maxMemories / maxAutoSkills）
//   2. buildAutoReviewInput：思考 + 自身状态 + 印象；空输入
//   3. parseAutoReview：正常 / 围栏 / 纯字符串记忆 / 非法 / 技能 id 非法
//   4. applyAutoReview：写记忆（去重、kind、权重）、不覆盖手写技能
//   5. reviewConversation：ok / nothing-to-save / 无素材 / 模型异常
//   6. 统计落盘
// 纯离线：隔离数据目录 + 隔离扩展目录 + 假模型。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-autolearn-'));
process.env.QQ_AGENT_DATA_DIR = path.join(tmp, 'data');
process.env.QQ_AGENT_SKILLS_DIR = path.join(tmp, 'skills');
process.env.QQ_AGENT_PLUGINS_DIR = path.join(tmp, 'plugins');

const {
  autoLearnConfig, updateAutoLearnConfig, autoLearnStats,
  buildAutoReviewInput, parseAutoReview, applyAutoReview, reviewConversation,
  AUTO_REVIEW_SYSTEM_PROMPT
} = await import('../src/auto-review.js');
const { MemoryStore } = await import('../src/memory.js');
const md = await import('../src/markdown-skills.js');

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const KEY = 'group:70001';

// ═══ 1. 配置 ═══
await check('配置默认：默认关、间隔 8、单次 1 条、不新建技能、上限 10', () => {
  const c = autoLearnConfig();
  assert.equal(c.enabled, false, '默认必须关');
  assert.equal(c.intervalTurns, 8);
  assert.equal(c.maxMemories, 1);
  assert.equal(c.createNewSkill, false);
  assert.equal(c.maxAutoSkills, 10);
});

await check('配置钳制：越界值被夹到合法区间', () => {
  const c = updateAutoLearnConfig({ intervalTurns: 999, maxMemories: 0, maxAutoSkills: -5 });
  assert.equal(c.intervalTurns, 50);
  assert.equal(c.maxMemories, 1);
  assert.equal(c.maxAutoSkills, 0);
  updateAutoLearnConfig({ intervalTurns: 8, maxMemories: 1, maxAutoSkills: 10 });
});

// ═══ 2. 输入组装 ═══
await check('buildAutoReviewInput：思考 + 自身状态 + 印象', () => {
  const input = buildAutoReviewInput({
    messages: [{ role: 'assistant', content: '我在想谜底是镜子' }],
    reasonings: [''],
    selfNotes: [{ content: '海龟汤进行中' }],
    impressions: '【对群友的印象】\n- 张三：爱玩梗'
  });
  assert.ok(input.includes('【最近的内部思考】'));
  assert.ok(input.includes('谜底是镜子'));
  assert.ok(input.includes('【当前自身状态】'));
  assert.ok(input.includes('海龟汤进行中'));
  assert.ok(input.includes('张三：爱玩梗'));
});

await check('buildAutoReviewInput：没有任何素材 → 空串', () => {
  assert.equal(buildAutoReviewInput({ messages: [{ role: 'user', content: '你好' }] }), '');
});

await check('buildAutoReviewInput：过期的 state 不进评审上下文', () => {
  const input = buildAutoReviewInput({
    messages: [{ role: 'assistant', content: '想过一些事' }],
    selfNotes: [
      { content: '已过期的旧计划', kind: 'state', expired: true },
      { content: '还在进行的游戏', kind: 'state', expired: false }
    ]
  });
  assert.ok(!input.includes('已过期的旧计划'), '过期条目不该喂给评审');
  assert.ok(input.includes('还在进行的游戏'));
});

// ═══ 3. 解析 ═══
await check('parseAutoReview：正常 JSON（记忆 + 技能）', () => {
  const r = parseAutoReview(JSON.stringify({
    memories: [{ kind: 'rule', content: '别每次都总结' }, { kind: 'state', content: '谜底是镜子' }],
    skill: { id: 'turtle-soup', name: '海龟汤主持', description: '出题', triggers: '海龟汤, 猜谜', body: '1. 出汤面' }
  }), { maxMemories: 2 });
  assert.equal(r.memories.length, 2);
  assert.equal(r.memories[0].kind, 'rule');
  assert.equal(r.memories[1].kind, 'state');
  assert.equal(r.skill.id, 'turtle-soup');
  assert.deepEqual(r.skill.triggers, ['海龟汤', '猜谜']);
});

await check('parseAutoReview：剥 markdown 围栏 / 记忆为纯字符串 / 非法输入', () => {
  const fenced = parseAutoReview('```json\n{"memories":["A","B"],"skill":null}\n```', { maxMemories: 2 });
  assert.equal(fenced.memories.length, 2);
  assert.equal(fenced.memories[0].kind, 'state', '纯字符串按 state');
  assert.equal(fenced.skill, null);
  assert.deepEqual(parseAutoReview(''), { memories: [], skill: null });
  assert.deepEqual(parseAutoReview('这不是 JSON'), { memories: [], skill: null });
  assert.deepEqual(parseAutoReview('{"memories":[]}'), { memories: [], skill: null });
});

await check('parseAutoReview：技能 id 非法 → 丢弃技能', () => {
  const r = parseAutoReview(JSON.stringify({
    memories: [],
    skill: { id: '../evil', name: 'x', body: 'y' }
  }));
  assert.equal(r.skill, null);
});

await check('parseAutoReview：记忆条数受 maxMemories 限制 + 去重', () => {
  const r = parseAutoReview(JSON.stringify({
    memories: [{ content: 'A' }, { content: 'A' }, { content: 'B' }, { content: 'C' }]
  }), { maxMemories: 2 });
  assert.equal(r.memories.length, 2);
  assert.equal(r.memories[0].content, 'A');
  assert.equal(r.memories[1].content, 'B');
});

// ═══ 4. 落盘 ═══
await check('applyAutoReview：写入记忆（kind 与权重生效）', () => {
  const m = new MemoryStore();
  const r = applyAutoReview({
    memory: m, chatKey: KEY, ownerActive: true,
    parsed: { memories: [{ kind: 'rule', content: '别每次都总结' }], skill: null }
  });
  assert.equal(r.memories, 1);
  assert.equal(r.skill, null);
  const note = m.selfNotes(KEY).find((e) => e.content === '别每次都总结');
  assert.ok(note, '应写入自身记忆');
  assert.equal(note.kind, 'rule');
  assert.equal(note.score, 5, '主人 + rule → 5 分');
});

await check('applyAutoReview：重复内容不重复写', () => {
  const m = new MemoryStore();
  const parsed = { memories: [{ kind: 'state', content: '同一件事' }], skill: null };
  applyAutoReview({ memory: m, chatKey: KEY, parsed });
  const r2 = applyAutoReview({ memory: m, chatKey: KEY, parsed });
  assert.equal(r2.memories, 1, 'appendSelf 去重后仍返回条目');
  assert.equal(m.selfNotes(KEY).filter((e) => e.content === '同一件事').length, 1);
});

await check('applyAutoReview：createNewSkill=false 时不新建技能', () => {
  const m = new MemoryStore();
  const r = applyAutoReview({
    memory: m, chatKey: KEY, createNewSkill: false,
    parsed: { memories: [], skill: { id: 's1', name: '技能1', triggers: [], body: '步骤' } }
  });
  assert.equal(r.skill, null);
  assert.equal(md.getMarkdownSkill('s1'), null);
});

await check('applyAutoReview：允许新建时写出 auto 来源的技能', () => {
  const m = new MemoryStore();
  const r = applyAutoReview({
    memory: m, chatKey: KEY, createNewSkill: true, maxAutoSkills: 10,
    parsed: { memories: [], skill: { id: 's2', name: '技能2', description: 'd', triggers: ['x'], body: '步骤' } }
  });
  assert.equal(r.skill, 's2');
  const meta = md.listMarkdownSkills().find((s) => s.id === 's2');
  assert.equal(meta.source, 'auto');
});

await check('applyAutoReview：不覆盖手写技能', () => {
  const m = new MemoryStore();
  // 先手写一个同名技能
  md.saveMarkdownSkill({ id: 'manual-one', name: '手写', description: '手写的', triggers: [], body: '原文' });
  const r = applyAutoReview({
    memory: m, chatKey: KEY, createNewSkill: true,
    parsed: { memories: [], skill: { id: 'manual-one', name: '改名', triggers: [], body: '被改写' } }
  });
  assert.equal(r.skill, null, '手写技能不该被自动改写');
  assert.equal(md.getMarkdownSkill('manual-one', { withBody: true }).body, '原文');
});

await check('applyAutoReview：超过自动技能上限后不再新建', () => {
  const m = new MemoryStore();
  const r = applyAutoReview({
    memory: m, chatKey: KEY, createNewSkill: true, maxAutoSkills: 1,
    parsed: { memories: [], skill: { id: 's3', name: '技能3', triggers: [], body: '步骤' } }
  });
  // 已有 s2 一个 auto 技能 → 上限 1 → 不再新建
  assert.equal(r.skill, null);
});

// ═══ 5. reviewConversation ═══
const TURNS = [
  { role: 'user', content: '来个海龟汤' },
  { role: 'assistant', content: '好，我出题了，谜底是镜子，先别说' }
];

await check('reviewConversation：ok —— 写记忆 + 建技能', async () => {
  const m = new MemoryStore();
  const k = 'group:70002';
  const r = await reviewConversation({
    memory: m, chatKey: k, messages: TURNS,
    createNewSkill: true, maxAutoSkills: 10,
    callModel: async () => ({
      message: {
        content: JSON.stringify({
          memories: [{ kind: 'state', content: '正在玩海龟汤，谜底是镜子' }],
          skill: { id: 'turtle-host', name: '海龟汤主持', description: '出题', triggers: '海龟汤', body: '1. 出汤面' }
        })
      }
    })
  });
  assert.equal(r.status, 'ok', `实际 ${r.status}（${r.reason}）`);
  assert.equal(r.memories, 1);
  assert.equal(r.skill, 'turtle-host');
  assert.ok(m.selfNotes(k).some((e) => e.content.includes('谜底是镜子')));
});

await check('reviewConversation：模型返回空 → nothing-to-save', async () => {
  const m = new MemoryStore();
  const r = await reviewConversation({
    memory: m, chatKey: 'group:70003', messages: TURNS,
    callModel: async () => ({ message: { content: '{"memories":[],"skill":null}' } })
  });
  assert.equal(r.status, 'nothing-to-save');
  assert.equal(r.memories, 0);
});

await check('reviewConversation：没有可复盘素材 → 不调模型', async () => {
  const m = new MemoryStore();
  let called = false;
  const r = await reviewConversation({
    memory: m, chatKey: 'group:70004',
    messages: [{ role: 'user', content: '在吗' }],
    callModel: async () => { called = true; return { message: { content: '{}' } }; }
  });
  assert.equal(r.status, 'skipped-no-input');
  assert.equal(called, false);
});

await check('reviewConversation：模型抛错 → error（不抛出）', async () => {
  const m = new MemoryStore();
  const r = await reviewConversation({
    memory: m, chatKey: 'group:70005', messages: TURNS,
    callModel: async () => { throw new Error('boom'); }
  });
  assert.equal(r.status, 'error');
  assert.ok(r.reason.includes('boom'));
});

await check('reviewConversation：评审用独立提示词（不是人设提示词）', async () => {
  const m = new MemoryStore();
  let sys = '';
  await reviewConversation({
    memory: m, chatKey: 'group:70006', messages: TURNS,
    callModel: async ({ messages }) => {
      sys = messages[0].content;
      return { message: { content: '{"memories":[],"skill":null}' } };
    }
  });
  assert.ok(sys.includes('中途复盘'), '应是评审专用提示词');
  assert.ok(!sys.includes('你是「'), '不应带群友人设');
});

// ═══ 6. 统计 ═══
await check('统计：跑过之后 runs/lastRunAt 有值', () => {
  const s = autoLearnStats();
  assert.ok(s.runs > 0, `runs 应 > 0，实际 ${s.runs}`);
  assert.ok(s.lastRunAt > 0);
});

// ═══ 7. 提示词防污染（2026-10-17）═══
await check('评审提示词含「不要写」清单，且默认只写 1 条', () => {
  assert.ok(AUTO_REVIEW_SYSTEM_PROMPT.includes('【不要写】'), '应与关闭蒸馏共用排除清单');
  assert.ok(AUTO_REVIEW_SYSTEM_PROMPT.includes('打算 / 准备 / 决定'), '应点名"计划类"污染');
  assert.equal(autoLearnConfig().maxMemories, 1, '默认单次只写 1 条');
});

console.log(`\n自动学习：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
