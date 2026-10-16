// 轨迹导出（L5）单元测试：
//   1. 脱敏：QQ 号 / 群号 / 裸数字
//   2. content 拍平（字符串 / parts 数组）
//   3. archiveToSamples：sharegpt / openai；跳过无正文的 assistant；
//      丢掉开头没有 user 的部分；没有一问一答 → 空
//   4. loadArchives：读目录 / chat 过滤 / limit
//   5. exportTrajectories：写 JSONL 文件、行数正确
// 纯离线：临时目录。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-traj-'));
const {
  redactText, flattenContent, archiveToSamples, loadArchives, exportTrajectories
} = await import('../src/trajectory-export.js');

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const ARCHIVE_DIR = path.join(tmp, 'archive');
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function writeArchive(file, obj) {
  fs.writeFileSync(path.join(ARCHIVE_DIR, file), JSON.stringify(obj), 'utf8');
}

const SAMPLE_ARCHIVE = {
  chatKey: 'group:1098345913',
  systemPrompt: '你是「小Q」，混在 QQ 群里的普通群友。',
  turns: 3,
  closedAt: 1000,
  messages: [
    { role: 'user', content: '你是谁' },
    { role: 'assistant', content: '我是小Q，群里混的' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'send_message' } }] },
    { role: 'tool', content: '发送成功' },
    { role: 'user', content: [{ type: 'text', text: '发张图看看' }, { type: 'image_url', image_url: { url: 'x' } }] },
    { role: 'assistant', content: '喏' }
  ]
};

await check('脱敏：QQ 号 / 群号 / 裸数字', () => {
  assert.equal(redactText('QQ:123456789 你好'), 'QQ:<id> 你好');
  assert.equal(redactText('group_1098345913'), 'group:<id>');
  assert.equal(redactText('消息 #70012345 说的'), '消息 #<num> 说的');
  assert.equal(redactText('就 3 个人'), '就 3 个人', '短数字不该被误伤');
});

await check('flattenContent：字符串 / parts 数组 / 空', () => {
  assert.equal(flattenContent('  hi  '), 'hi');
  assert.equal(
    flattenContent([{ type: 'text', text: '看这个' }, { type: 'image_url', image_url: {} }]),
    '看这个\n[图片]'
  );
  assert.equal(flattenContent(null), '');
  assert.equal(flattenContent(123), '');
});

await check('archiveToSamples（sharegpt）：丢开头非 user、跳过无正文的 assistant', () => {
  const samples = archiveToSamples(SAMPLE_ARCHIVE, { redact: false });
  assert.equal(samples.length, 1);
  const s = samples[0];
  assert.ok(Array.isArray(s.conversations));
  assert.equal(s.conversations[0].from, 'human');
  assert.equal(s.conversations[0].value, '你是谁');
  assert.equal(s.conversations[1].from, 'gpt');
  assert.equal(s.conversations[1].value, '我是小Q，群里混的');
  // 只调工具、没有正文的那条不该出现；tool 结果也不该出现
  assert.ok(!s.conversations.some((c) => c.value.includes('send_message')), '不应含工具名');
  assert.ok(!s.conversations.some((c) => c.value.includes('发送成功')), '不应含 tool 结果');
  // 图片被折成 [图片]
  assert.ok(s.conversations.some((c) => c.value.includes('[图片]')), '应保留图片占位');
  assert.ok(s.system.includes('小Q'), '默认带系统提示词');
});

await check('archiveToSamples（openai）：messages 形态 + system 置顶', () => {
  const samples = archiveToSamples(SAMPLE_ARCHIVE, { format: 'openai', redact: false });
  assert.equal(samples.length, 1);
  const m = samples[0].messages;
  assert.equal(m[0].role, 'system');
  assert.equal(m[1].role, 'user');
  assert.ok(m.some((x) => x.role === 'assistant'));
});

await check('archiveToSamples：脱敏生效（默认开）', () => {
  const withId = {
    messages: [
      { role: 'user', content: '我的号是 123456789' },
      { role: 'assistant', content: '收到 QQ:123456789' }
    ]
  };
  const on = archiveToSamples(withId)[0];
  assert.ok(!JSON.stringify(on).includes('123456789'), '默认应脱敏');
  const off = archiveToSamples(withId, { redact: false })[0];
  assert.ok(JSON.stringify(off).includes('123456789'), '关掉脱敏后保留原样');
});

await check('archiveToSamples：includeSystem=false 时不带系统提示词', () => {
  const s = archiveToSamples(SAMPLE_ARCHIVE, { includeSystem: false })[0];
  assert.equal(s.system, undefined);
});

await check('archiveToSamples：没有一问一答 → 空数组', () => {
  assert.equal(archiveToSamples({ messages: [{ role: 'user', content: '在吗' }] }).length, 0);
  assert.equal(archiveToSamples({ messages: [] }).length, 0);
  assert.equal(archiveToSamples({}).length, 0);
  assert.equal(
    archiveToSamples({ messages: [{ role: 'assistant', content: '我先说' }, { role: 'user', content: '嗯' }] }).length,
    0,
    '只有 assistant 开头 + 一个 user，没有可学的 gpt 回复 → 空'
  );
});

await check('archiveToSamples：includeTools=true 时保留工具痕迹', () => {
  const s = archiveToSamples(SAMPLE_ARCHIVE, { includeTools: true, redact: false })[0];
  assert.ok(s.conversations.some((c) => c.value.includes('[工具调用] send_message')), '应保留工具调用痕迹');
});

await check('loadArchives：读目录 / chat 过滤 / limit', () => {
  writeArchive('group_1098345913.2026-01-01T00-00-00-000Z.1.json', SAMPLE_ARCHIVE);
  writeArchive('group_999.2026-01-02T00-00-00-000Z.1.json', { ...SAMPLE_ARCHIVE, chatKey: 'group:999', closedAt: 2000 });
  writeArchive('broken.json', 'not json');
  fs.writeFileSync(path.join(ARCHIVE_DIR, 'broken.json'), '{ 坏文件', 'utf8');

  const all = loadArchives({ dir: ARCHIVE_DIR });
  assert.equal(all.length, 2, '坏文件应被跳过');
  assert.ok(all[0].closedAt <= all[1].closedAt, '应按关闭时间升序');

  const only = loadArchives({ dir: ARCHIVE_DIR, chat: 'group_1098345913' });
  assert.equal(only.length, 1);
  assert.equal(only[0].chatKey, 'group:1098345913');

  assert.equal(loadArchives({ dir: ARCHIVE_DIR, limit: 1 }).length, 1);
  assert.equal(loadArchives({ dir: path.join(tmp, '__none__') }).length, 0, '目录不存在应返回空');
});

await check('exportTrajectories：写出 JSONL 且行数正确', () => {
  const outFile = path.join(tmp, 'out', 'traj.jsonl');
  const r = exportTrajectories({ archivesDir: ARCHIVE_DIR, outFile, redact: true });
  assert.equal(r.archives, 2);
  assert.equal(r.count, 2);
  assert.ok(fs.existsSync(outFile), '文件应写出');
  const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) JSON.parse(line);   // 每行都应是合法 JSON
  assert.ok(!fs.readFileSync(outFile, 'utf8').includes('1098345913'), '默认应脱敏群号');
});

await check('exportTrajectories：缺参数抛错', () => {
  assert.throws(() => exportTrajectories({}), /必填/);
});

console.log(`\n轨迹导出：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
