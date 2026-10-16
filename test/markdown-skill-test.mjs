// Markdown 技能（L2）单元测试：
//   1. SKILL.md 解析（frontmatter / 触发词两种写法）
//   2. 渐进式披露：索引只含 name+description，正文不进提示词
//   3. 总开关 / indexMode / 单个技能开关
//   4. 触发词命中 → 返回带正文的技能
//   5. 命中统计落盘
//   6. save / delete（含 id 校验）
//   7. 工具可用性：load_skill / list_skills / remember_skill
// 纯离线：隔离数据目录 + 隔离扩展目录。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-mdskill-'));
process.env.QQ_AGENT_DATA_DIR = path.join(tmp, 'data');
process.env.QQ_AGENT_SKILLS_DIR = path.join(tmp, 'skills');
process.env.QQ_AGENT_PLUGINS_DIR = path.join(tmp, 'plugins');

const {
  listMarkdownSkills, getMarkdownSkill, activeMarkdownSkills, markdownSkillIndexText,
  matchMarkdownSkills, recordMarkdownSkillHit, saveMarkdownSkill, deleteMarkdownSkill,
  setMarkdownSkillEnabled, updateMarkdownSkillsSettings, renderMarkdownSkillBody,
  reloadMarkdownSkills
} = await import('../src/markdown-skills.js');
const { buildToolDefs } = await import('../src/tools.js');
const { getToolAvailability } = await import('../src/tool-registry.js');
const { buildSystemPrompt } = await import('../src/prompt.js');

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const SKILLS_ROOT = process.env.QQ_AGENT_SKILLS_DIR;

function writeSkill(id, text, root = SKILLS_ROOT) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text, 'utf8');
  return dir;
}

// ═══ 1. 解析 ═══
await check('解析 SKILL.md：frontmatter + 触发词（逗号与数组两种写法）', () => {
  writeSkill('turtle-soup', [
    '---',
    'name: 海龟汤主持',
    'description: 出题、逐轮回答是/否、最后揭底',
    'triggers: 海龟汤, 猜谜, 汤面',
    'category: utility',
    '---',
    '',
    '1. 出题，只给汤面',
    '2. 每轮只回「是 / 不是 / 无关」'
  ].join('\n'));
  writeSkill('array-trigger', [
    '---',
    'name: 数组触发',
    'description: 测试 [a, b] 写法',
    'triggers: [foo, bar]',
    '---',
    '正文占位'
  ].join('\n'));
  reloadMarkdownSkills();
  const list = listMarkdownSkills();
  const t = list.find((s) => s.id === 'turtle-soup');
  assert.ok(t, '应扫到 turtle-soup');
  assert.equal(t.name, '海龟汤主持');
  assert.deepEqual(t.triggers, ['海龟汤', '猜谜', '汤面']);
  assert.ok(t.bodyChars > 0, '应统计正文字数');
  assert.equal(t.source, 'manual', '默认来源是手写');
  const a = list.find((s) => s.id === 'array-trigger');
  assert.deepEqual(a.triggers, ['foo', 'bar'], '应支持 [a, b] 写法');
});

await check('缺少 frontmatter 的 SKILL.md 被忽略', () => {
  writeSkill('no-front', '只有正文，没有 frontmatter');
  reloadMarkdownSkills();
  assert.equal(getMarkdownSkill('no-front'), null);
});

// ═══ 2. 渐进式披露 ═══
await check('索引只列 name + description，正文不进提示词', () => {
  updateMarkdownSkillsSettings({ enabled: true, indexMode: 'prompt' });
  const idx = markdownSkillIndexText();
  assert.ok(idx.includes('【可加载技能】'), '应带段名');
  assert.ok(idx.includes('海龟汤主持'), '应含技能名');
  assert.ok(idx.includes('出题、逐轮回答是/否、最后揭底'), '应含说明');
  assert.ok(!idx.includes('只给汤面'), '正文不能进索引');

  const sp = buildSystemPrompt({});
  assert.ok(sp.includes('【可加载技能】'), '系统提示词应含索引段');
  assert.ok(!sp.includes('只给汤面'), '系统提示词不应含技能正文');
});

await check('indexMode=tool 时索引不进提示词', () => {
  updateMarkdownSkillsSettings({ indexMode: 'tool' });
  assert.equal(markdownSkillIndexText(), '');
  updateMarkdownSkillsSettings({ indexMode: 'prompt' });
});

await check('总开关关闭：索引为空、没有生效技能', () => {
  updateMarkdownSkillsSettings({ enabled: false });
  assert.equal(markdownSkillIndexText(), '');
  assert.equal(activeMarkdownSkills().length, 0);
  updateMarkdownSkillsSettings({ enabled: true });
});

// ═══ 3. 触发词 ═══
await check('触发词命中 → 返回带正文的技能；无关文本不命中', () => {
  const hits = matchMarkdownSkills('来玩个海龟汤吧');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'turtle-soup');
  assert.ok(hits[0].body.includes('只给汤面'), '应带正文');
  assert.equal(matchMarkdownSkills('今天天气不错').length, 0);
});

await check('renderMarkdownSkillBody 带技能名标题', () => {
  const full = getMarkdownSkill('turtle-soup', { withBody: true });
  const text = renderMarkdownSkillBody(full);
  assert.ok(text.startsWith('【技能：海龟汤主持】'), `实际开头：${text.slice(0, 20)}`);
  assert.ok(text.includes('只给汤面'));
});

// ═══ 4. 命中统计 ═══
await check('命中统计累计并落盘', () => {
  const before = listMarkdownSkills().find((s) => s.id === 'turtle-soup').hits;
  recordMarkdownSkillHit('turtle-soup');
  recordMarkdownSkillHit('turtle-soup');
  const t = listMarkdownSkills().find((s) => s.id === 'turtle-soup');
  assert.equal(t.hits, before + 2);
  assert.ok(t.lastHitAt > 0, '应记录最后命中时间');
});

// ═══ 5. 单个技能开关 ═══
await check('单个技能可单独关闭，不影响其它技能', () => {
  setMarkdownSkillEnabled('array-trigger', false);
  assert.equal(activeMarkdownSkills().some((s) => s.id === 'array-trigger'), false);
  assert.equal(activeMarkdownSkills().some((s) => s.id === 'turtle-soup'), true);
  setMarkdownSkillEnabled('array-trigger', true);
  assert.equal(activeMarkdownSkills().some((s) => s.id === 'array-trigger'), true);
});

// ═══ 6. 写入 / 删除 ═══
await check('saveMarkdownSkill 写入并可读回；非法 id 被拒', () => {
  const saved = saveMarkdownSkill({ id: 'my-skill', name: '我的技能', description: '测试', triggers: ['xx'], body: '步骤一' });
  assert.equal(saved.id, 'my-skill');
  assert.ok(fs.existsSync(path.join(SKILLS_ROOT, 'my-skill', 'SKILL.md')), 'SKILL.md 应落盘');
  assert.equal(getMarkdownSkill('my-skill', { withBody: true }).body, '步骤一');
  assert.throws(() => saveMarkdownSkill({ id: '../evil', name: 'x', body: 'y' }), /id/, '路径逃逸的 id 必须被拒');
});

await check('deleteMarkdownSkill 删除 SKILL.md 并清掉统计', () => {
  recordMarkdownSkillHit('my-skill');
  assert.ok(deleteMarkdownSkill('my-skill'));
  assert.equal(getMarkdownSkill('my-skill'), null);
  assert.equal(deleteMarkdownSkill('my-skill'), false, '再删应返回 false');
});

// ═══ 7. 工具可用性（唯一口径在 tool-registry）═══
await check('工具可用性：总开关关闭 → load_skill / list_skills 不可见', () => {
  buildToolDefs();
  updateMarkdownSkillsSettings({ enabled: false });
  assert.equal(getToolAvailability('load_skill', {}).enabled, false);
  assert.equal(getToolAvailability('load_skill', {}).code, 'md-skills-disabled');
  updateMarkdownSkillsSettings({ enabled: true });
  assert.equal(getToolAvailability('load_skill', {}).enabled, true);
  assert.equal(getToolAvailability('list_skills', {}).enabled, true);
});

await check('工具可用性：remember_skill 需显式开启自动创建', () => {
  buildToolDefs();
  updateMarkdownSkillsSettings({ enabled: true, allowAutoCreate: false });
  assert.equal(getToolAvailability('remember_skill', {}).enabled, false);
  assert.equal(getToolAvailability('remember_skill', {}).code, 'md-skills-no-auto-create');
  updateMarkdownSkillsSettings({ allowAutoCreate: true });
  assert.equal(getToolAvailability('remember_skill', {}).enabled, true);
  updateMarkdownSkillsSettings({ allowAutoCreate: false });
});

console.log(`\nMarkdown 技能：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
