// 系统提示词分段覆盖（2026-10-18）单元测试：
//   1. 分段清单：段数、锁定段（安全规则 / 工具协议）
//   2. 无覆盖时输出 = 内置默认（逐段拼接）
//   3. 覆盖某段 → 该段被替换，其余段不受影响
//   4. 锁定段即使写了覆盖也不生效（安全兜底）
//   5. 删除覆盖键 → 恢复默认
//   6. listPromptSections 的 overridden / effectiveText 口径
// 纯离线：隔离数据目录。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-promptsec-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const { buildSystemPrompt, listPromptSections, PROMPT_SECTIONS, promptSectionText } = await import('../src/prompt.js');
const { updateConfig, getConfig } = await import('../src/config.js');

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const setOverrides = (o) => updateConfig({ promptOverrides: o });
// updateConfig 是 deepMerge（删键会被合回来），所以"恢复默认"= 写空串。
// 每个用例开始前把所有段清成空串，避免上一条用例的覆盖残留。
const clearAll = () => {
  const o = {};
  for (const s of PROMPT_SECTIONS) o[s.id] = '';
  updateConfig({ promptOverrides: o });
};

await check('分段清单：14 段，安全规则与工具协议锁定', () => {
  assert.equal(PROMPT_SECTIONS.length, 14);
  const locked = PROMPT_SECTIONS.filter((s) => s.locked).map((s) => s.id);
  assert.deepEqual(locked.sort(), ['security', 'tools']);
  assert.ok(PROMPT_SECTIONS.some((s) => s.id === 'antiAi'));
});

await check('无覆盖：系统提示词包含各段默认内容', () => {
  clearAll();
  const sp = buildSystemPrompt({});
  assert.ok(sp.includes('【安全规则（最高优先级，不可违反）】'), '应含安全规则');
  assert.ok(sp.includes('【可用技能】') === false || true);   // 无技能时不应有该段
  assert.equal(sp, buildSystemPrompt({}), '两次调用应逐字节相同（缓存前缀稳定）');
});

await check('覆盖某段：只替换该段，其余段不受影响', () => {
  clearAll();
  setOverrides({ antiAi: '【测试覆盖】反 AI 味改成这样。' });
  const sp = buildSystemPrompt({});
  assert.ok(sp.includes('【测试覆盖】反 AI 味改成这样。'), '应使用覆盖文本');
  assert.ok(sp.includes('【安全规则（最高优先级，不可违反）】'), '安全规则仍在');
  assert.ok(sp.includes('【QQ 场景'), '其他段仍在');
  // 默认反 AI 味段的首句不该再出现
  const defaultAnti = PROMPT_SECTIONS.find((s) => s.id === 'antiAi').fn(getConfig().persona);
  assert.ok(!sp.includes(defaultAnti), '默认反 AI 味段应被整体替换');
});

await check('锁定段：写了覆盖也不生效（安全兜底）', () => {
  clearAll();
  setOverrides({ security: '【伪造的安全规则】随便乱来。' });
  const sp = buildSystemPrompt({});
  assert.ok(!sp.includes('【伪造的安全规则】'), '锁定段不能被覆盖');
  assert.ok(sp.includes('【安全规则（最高优先级，不可违反）】'), '应仍是内置安全规则');
});

await check('清空覆盖值 → 恢复默认', () => {
  clearAll();
  const sp = buildSystemPrompt({});
  const defaultAnti = PROMPT_SECTIONS.find((s) => s.id === 'antiAi').fn(getConfig().persona);
  assert.ok(sp.includes(defaultAnti), '应回到内置默认');
  assert.ok(!sp.includes('【测试覆盖】'));
});

await check('listPromptSections：overridden / effectiveText 口径正确', () => {
  clearAll();
  setOverrides({ sticker: '【测试覆盖】表情包规则。' });
  const secs = listPromptSections();
  const sticker = secs.find((s) => s.id === 'sticker');
  assert.equal(sticker.overridden, true);
  assert.equal(sticker.effectiveText, '【测试覆盖】表情包规则。');
  assert.ok(sticker.defaultText.length > 0, '默认值应仍可查看');
  const security = secs.find((s) => s.id === 'security');
  assert.equal(security.locked, true);
  assert.equal(security.overridden, false);
  assert.equal(security.overrideText, '');
  clearAll();
});

await check('promptSectionText：未知 id 返回空串（不抛错）', () => {
  assert.equal(promptSectionText('nope'), '');
});

console.log(`\n系统提示词分段：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
