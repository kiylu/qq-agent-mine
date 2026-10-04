// 开发者快照清理（stripRequestSnapshots）单元测试，2026-10-04
//
// 背景：api.debugStoreRequest 开启后，每个会话存档里会多一个 lastRequest 字段
// （端点/参数/工具清单的排障快照）。它**对实际行为零影响**，查完就没用了，
// 却要跟着每条存档一直存 —— 所以需要一个无害的清理入口。
//
// "无害"的准确含义（本文件逐条验证）：
//   1. 只抹 lastRequest 字段，会话记录本身**不删**
//   2. usage / messages / chatKey 等**全部保留**
//   3. 正在运行/等待中的会话**跳过**（详情面板正开着它）
//   4. 没有快照的存档不被动过；重复执行幂等
//   5. 单个损坏文件不影响其余条目
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-strip-'));
process.env.QQ_AGENT_DATA_DIR = __dir;

const { SessionRegistry } = await import('../src/sessions.js');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const fileOf = (id) => path.join(__dir, 'sessions', `${id}.json`);
const readOf = (id) => JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));

/** 造一个已结束的会话（含 lastRequest），返回 id。 */
function makeFinished(reg, chatKey, withSnapshot = true) {
  const s = reg.create({ chatKey, trigger: 'message', triggerSummary: '测试' });
  s.usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, calls: 1 };
  s.messages = [{ role: 'user', content: 'hi' }];
  if (withSnapshot) {
    s.lastRequest = { endpoint: 'https://x/v1/chat/completions', params: { model: 'm' }, messageCount: 2 };
  }
  reg.finish(s.id, 'done');
  const onDisk = readOf(s.id);
  if (withSnapshot) onDisk.lastRequest = s.lastRequest;
  fs.writeFileSync(fileOf(s.id), JSON.stringify(onDisk, null, 2));
  return s.id;
}

console.log('\n【1】只抹字段，不删记录');

const reg = new SessionRegistry();
const id1 = makeFinished(reg, 'private:A', true);
const id2 = makeFinished(reg, 'private:B', false);   // 无快照

const before = readOf(id1);
ok('前置：快照存在', () => assert.ok(before.lastRequest));

const r = reg.stripRequestSnapshots();

ok('返回统计正确（scanned/cleaned/running）', () => {
  assert.strictEqual(r.cleaned, 1, '应只清掉 1 条');
  assert.ok(r.scanned >= 2, '应扫描到多条');
  assert.strictEqual(r.running, 0);
});

ok('lastRequest 字段被抹掉', () => {
  assert.strictEqual(readOf(id1).lastRequest, undefined);
});

ok('会话记录本身没被删（文件仍在、index 仍能查到）', () => {
  assert.ok(fs.existsSync(fileOf(id1)), '文件应存在');
  assert.ok(reg.listSummaries(999).some((e) => e.id === id1), '应仍在索引里');
});

console.log('\n【2】其他数据一律保留');

ok('usage / messages / chatKey / startedAt 全部不变', () => {
  const after = readOf(id1);
  assert.strictEqual(after.chatKey, before.chatKey);
  assert.strictEqual(after.startedAt, before.startedAt);
  assert.deepStrictEqual(after.usage, before.usage, 'usage 不该变');
  assert.deepStrictEqual(after.messages, before.messages, 'messages 不该变');
});

ok('无快照的存档不被写盘（保持原样）', () => {
  const untouched = readOf(id2);
  assert.ok(untouched, '文件仍可读');
  assert.strictEqual(untouched.lastRequest, undefined);
});

console.log('\n【3】重复执行是幂等的');

ok('再跑一次 cleaned=0，不报错', () => {
  const r2 = reg.stripRequestSnapshots();
  assert.strictEqual(r2.cleaned, 0);
});

console.log('\n【4】运行中的会话被跳过');

const reg2 = new SessionRegistry();
const live = reg2.create({ chatKey: 'private:C', trigger: 'message', triggerSummary: 't3' });
live.lastRequest = { endpoint: 'https://y', params: { model: 'm2' } };
fs.writeFileSync(fileOf(live.id), JSON.stringify(live, null, 2));
// 不 finish → 仍在 current 且 status='running'

const r3 = reg2.stripRequestSnapshots();

ok('运行中会话的快照不被抹（内存与磁盘都保留）', () => {
  assert.strictEqual(r3.running, 1, '应报告跳过 1 个');
  assert.strictEqual(r3.cleaned, 0, '不该清任何东西');
  assert.ok(reg2.current.get(live.id)?.lastRequest, '内存中的快照应仍在');
  assert.ok(readOf(live.id).lastRequest, '磁盘快照应仍在');
});

console.log('\n【5】损坏文件不影响其余条目');

const reg3 = new SessionRegistry();
const bad = reg3.create({ chatKey: 'private:D', trigger: 'message', triggerSummary: 't4' });
reg3.finish(bad.id, 'done');
fs.writeFileSync(fileOf(bad.id), '{ 这不是合法 JSON');
const good = reg3.create({ chatKey: 'private:E', trigger: 'message', triggerSummary: 't5' });
good.lastRequest = { endpoint: 'https://z', params: {} };
reg3.finish(good.id, 'done');
fs.writeFileSync(fileOf(good.id), JSON.stringify(readOf(good.id), null, 2));

ok('坏文件被跳过，其后的条目仍被清掉', () => {
  const r4 = reg3.stripRequestSnapshots();
  assert.ok(r4.scanned >= 2, '应扫描到多个');
  assert.ok(!readOf(good.id).lastRequest, '坏文件之后的条目仍应被清掉');
});

console.log(`\n快照清理测试：${passed} 通过${process.exitCode ? '，有失败' : ''}\n`);
