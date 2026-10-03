// 会话延续端到端（②P1"沉默为界"）：
//   1. 首次触发 → fresh（无历史会话），并把缓冲写盘
//   2. 紧接着再触发（间隔 < 沉默阈值）→ continuation：
//      **第 2 次请求的 messages 以第 1 次的 messages 逐字节开头**，只追加增量
//   3. 手动「重开会话」接口 → 缓冲清空，下次触发回到 fresh
//   4. 沉默超过阈值 → 回到 fresh
//
// 沉默阈值用 0.1 分钟（6 秒）—— 既能在一轮里跑完"连续→沉默"的对比，
// 又留足余量（连续那次间隔 < 1 秒，沉默那次 sleep 7 秒）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp, sleep, waitFor, ROOT } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  config: {
    store: {
      contextSliderPos: 100,
      historyCount: 20,
      continuation: { enabled: true, silenceMinutes: 0.1, maxTurns: 30, maxChars: 240000 }
    },
    wakeDelayMs: 200,
    drainDelayMs: 150
  }
});
const { app, llm, pushGroupMsg, teardown, request } = env;

const reqCount = () => llm.state.requests.length;
const contList = async () => (await request('GET', '/api/continuations')).data.continuations || [];

// 触发一次并等这一轮跑完（LLM 请求数 +1、会话结束、缓冲写盘）
async function fire(text, mid) {
  const before = reqCount();
  pushGroupMsg(111, '张三', text, mid);
  await waitFor(() => reqCount() > before, 8000, `触发：${text}`);
  await sleep(500);   // 等 #runAgent 收尾（写缓冲 + sessions.finish）
  return llm.state.requests[reqCount() - 1];
}

// ═══ 场景 1：首次触发 = fresh，并建立缓冲 ═══
await check('首次触发走 fresh，并把会话缓冲写盘（turns=1）', async () => {
  const req = await fire('@覆盖Bot 第一句', 70001);
  assert.equal(req.messages.length, 2, '首次会话 messages 应只有 system + user');
  // 首次会话没有任何已读历史 → 段头是"（暂无历史记录）"那种，所以只断言段名
  assert.ok(String(req.messages[1].content).includes('【已读信息】'), 'fresh 轮应带【已读信息】段');
  const list = await contList();
  const item = list.find((x) => x.chatKey === 'group:456');
  assert.ok(item, `应出现会话缓冲：${JSON.stringify(list)}`);
  assert.equal(item.turns, 1, 'turns 应为 1');
});

// ═══ 场景 2：紧接触发 = continuation，前缀逐字节复用 ═══
await check('紧接触发走 continuation：新请求以上一轮 messages 逐字节开头，只追加增量', async () => {
  const before = llm.state.requests.length;
  const prev = llm.state.requests[before - 1];
  const req = await fire('@覆盖Bot 第二句', 70002);

  // 核心断言：前缀完全一致（这是"命中前缀缓存"的前提）
  const prefix = req.messages.slice(0, prev.messages.length);
  assert.equal(
    JSON.stringify(prefix), JSON.stringify(prev.messages),
    '第二轮请求的 messages 前缀必须与第一轮逐字节一致'
  );
  assert.ok(req.messages.length > prev.messages.length, '应追加了增量');
  assert.equal(req.messages[0].content, prev.messages[0].content, 'system 提示应逐字节相同');

  // 增量消息只带新内容，不重复已读信息整窗
  const delta = req.messages[req.messages.length - 1];
  assert.equal(delta.role, 'user', '最后一条应是 user（本轮增量）');
  assert.ok(String(delta.content).includes('第二句'), '增量应包含本条新消息');
  assert.ok(!String(delta.content).includes('第一句'), '增量不该重复上一轮的消息');
  assert.ok(!String(delta.content).includes('【已读信息】'), '延续轮不得再带【已读信息】整窗');

  const item = (await contList()).find((x) => x.chatKey === 'group:456');
  assert.equal(item.turns, 2, 'turns 应累加到 2');
});

// ═══ 场景 3：手动「重开会话」→ 缓冲清空，下次回到 fresh ═══
await check('手动重开会话：缓冲被清空，下次触发回到 fresh', async () => {
  const r = await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.had, true, '重开前应存在缓冲');
  assert.equal((await contList()).some((x) => x.chatKey === 'group:456'), false, '列表里不该再有它');

  const req = await fire('@覆盖Bot 重开之后', 70003);
  assert.equal(req.messages.length, 2, '重开后应是全新的 system + user');
  assert.ok(String(req.messages[1].content).includes('【已读信息】以下是'), 'fresh 轮应带【已读信息】整窗');
});

await check('重开会话接口对"本来就没有缓冲"的会话也返回 200（幂等）', async () => {
  await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  const r = await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.had, false, '第二次应报 had=false');
});

await check('重开并蒸馏（distill=true）：清缓冲同时触发一次蒸馏请求', async () => {
  // 先建立一段缓冲（造出可蒸馏的思考链）
  await fire('@覆盖Bot 蒸馏前铺垫', 70006);
  assert.ok((await contList()).some((x) => x.chatKey === 'group:456'), '应先有缓冲');

  const before = reqCount();
  const r = await request('POST', '/api/chats/group_456/new-conversation', { body: { distill: true } });
  assert.equal(r.status, 200);
  assert.equal(r.data.had, true, '重开前应有缓冲可清');
  assert.equal(r.data.distill, true, '响应应回显 distill=true');

  // 缓冲已清（与普通重开一致）
  assert.equal((await contList()).some((x) => x.chatKey === 'group:456'), false, '缓冲应被清空');

  // 蒸馏是 fire-and-forget 的额外 LLM 调用：等它出现（提示词含"记忆归档"标记）
  await waitFor(() => reqCount() > before, 8000, '应触发一次蒸馏请求');
  const distillReq = llm.state.requests[reqCount() - 1];
  assert.ok(String(distillReq.messages?.[0]?.content || '').includes('记忆归档'),
    '蒸馏请求的系统提示应含"记忆归档"标记');
});

await check('重开会话（distill 缺省）不触发蒸馏', async () => {
  await fire('@覆盖Bot 不蒸馏铺垫', 70007);
  const before = reqCount();
  const r = await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  assert.equal(r.data.distill, false, '缺省应回显 distill=false');
  await sleep(1200);   // 给"万一误触发"的蒸馏留出冒头时间
  assert.equal(reqCount(), before, '普通重开不应产生任何额外 LLM 调用');
});

// ═══ 场景 4：沉默超过阈值 → 回到 fresh ═══
await check('沉默超过阈值后触发：走 fresh（不再续用旧上下文）', async () => {
  // 先建立一段缓冲（上一条用例把缓冲清掉了），再静默 7 秒（阈值 6 秒）
  await fire('@覆盖Bot 先建立一段', 70004);
  assert.ok((await contList()).some((x) => x.chatKey === 'group:456'), '此时应有缓冲');
  await sleep(7000);
  const req = await fire('@覆盖Bot 沉默之后', 70005);
  assert.equal(req.messages.length, 2, '沉默超阈值后应回到全新的 system + user');
});

// ═══ 场景 5：软重置后又能继续续用 ═══
await check('沉默重置后的下一轮又能走 continuation（链路自愈）', async () => {
  const before = llm.state.requests.length;
  const prev = llm.state.requests[before - 1];
  const req = await fire('@覆盖Bot 重置后紧接着', 70006);
  const prefix = req.messages.slice(0, prev.messages.length);
  assert.equal(JSON.stringify(prefix), JSON.stringify(prev.messages), '软重置后应重新开始锚定并复用前缀');
});

// ═══ 场景 6：会话关闭触发蒸馏（②P2）═══
// 沉默超阈值 → 关闭缓冲时，会发一次"蒸馏请求"（系统提示含"记忆归档"），
// 把上一轮 assistant 的思考提炼成【自身状态】写盘。
await check('沉默关闭会话时触发蒸馏：自身状态写入记忆', async () => {
  // 先建立一段带"思考"的会话（脚本里 assistant 会输出可被蒸馏的正文）
  llm.state.script.length = 0;   // 清空脚本队列，改用默认响应
  await fire('@覆盖Bot 我在想谜底', 70010);
  await sleep(7000);            // 超阈值，下次触发时关闭并蒸馏

  const before = llm.state.requests.length;
  pushGroupMsg(111, '张三', '@覆盖Bot 沉默之后', 70011);
  await waitFor(() => llm.state.requests.length > before, 8000, '沉默后触发');
  await sleep(1200);            // 等 #distillAndClose 的 fire-and-forget 跑完

  const distilledReqs = llm.state.requests.filter(
    (r) => String(r.messages?.[0]?.content || '').includes('记忆归档')
  );
  assert.ok(distilledReqs.length >= 1, '关闭会话时应发出一次蒸馏请求');
});

// ═══ 场景 7：媒体瘦身 + 归档（②P3）═══
await check('关闭的会话被归档，归档接口能查到（②P3）', async () => {
  // 上一个用例的沉默关闭已把 group:456 的缓冲归档
  const r = await request('GET', '/api/chats/group_456/continuation-archive');
  assert.equal(r.status, 200);
  const arcs = r.data.archives || [];
  assert.ok(arcs.length >= 1, `应至少有 1 份归档：${JSON.stringify(arcs)}`);
});

await check('手动重开会话也会归档当前缓冲', async () => {
  await fire('@覆盖Bot 建立缓冲准备重开', 70020);
  const before = (await request('GET', '/api/chats/group_456/continuation-archive')).data.archives.length;
  const r = await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  assert.equal(r.data.had, true);
  const after = (await request('GET', '/api/chats/group_456/continuation-archive')).data.archives.length;
  assert.equal(after, before + 1, '重开会话应新增一份归档');
});

// ═══ 场景 8：思维链接口（记忆页「🧠 查看思维链」的数据源）═══
await check('思维链接口返回活跃缓冲的 messages（含 assistant/tool 往返）', async () => {
  await fire('@覆盖Bot 建立思维链', 70030);
  const r = await request('GET', '/api/chats/group_456/thoughts');
  assert.equal(r.status, 200);
  const msgs = r.data.messages || [];
  assert.ok(msgs.length >= 2, `应至少含 user + assistant：${msgs.length}`);
  assert.equal(msgs[0].role, 'user', '首条应是 user（本轮输入）');
  assert.ok(msgs.some((m) => m.role === 'assistant'), '应含 assistant 思考条目');
  assert.ok((r.data.turns || 0) >= 1, '应带 turns');
});

await check('思维链接口在没有缓冲时返回空数组（不报错）', async () => {
  // 先清掉缓冲，模拟"会话已关闭"
  await request('POST', '/api/chats/group_456/new-conversation', { body: {} });
  const r = await request('GET', '/api/chats/group_456/thoughts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.messages, [], '无缓冲时应返回空 messages');
  assert.equal(r.data.turns, 0);
});

// ═══ 场景 9：外部技能对会话延续的影响（兼容性回归护栏）═══
//
// 已实测确认的既有行为：
//   · 静态 prompt.sections           → 不影响延续（systemPrompt 每轮一致）
//   · 动态 promptSections 但内容稳定 → 不影响延续
//   · 动态 promptSections 且内容随会话变化 → systemPrompt 逐字节不等 → 每轮强制 fresh
//
// 第三条不是本次改造引入的 bug（`systemPrompt` 逐字节比较是 P1 的设计），
// 但它是"外部 Skill × 会话延续"的真实冲突面。这里用护栏锁住现状：
// 若将来把比较逻辑改成"只比核心前缀"，这条会变成 pass，届时可放宽。
await check('Skill 动态提示词段变化时走 fresh（已知行为，护栏）', async () => {
  // ⚠️ 探针必须写进**本次测试的隔离扩展目录**（QQ_AGENT_SKILLS_DIR），
  //    不能写 ROOT/skills —— 否则 (a) 污染用户真实技能目录，
  //    (b) 被 harness 的目录隔离挡在外面，reloadSkills 根本加载不到它。
  const skillsRoot = process.env.QQ_AGENT_SKILLS_DIR || path.join(ROOT, 'skills');
  const skillDir = path.join(skillsRoot, 'cont-brake-probe');
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
      id: 'cont-brake-probe', name: '延续护栏探针', version: '0.0.1', apiVersion: 1,
      category: 'utility', description: 'probe'
    }));
    fs.writeFileSync(path.join(skillDir, 'index.js'), `
      export function setup() {}
      // 内容随 sessionId 变化 —— 模拟外部 Skill "每轮注入会变的内容"
      export function promptSections(ctx) {
        return [{ id: 'dyn', title: '动态', content: 'sid=' + (ctx?.sessionId || 'x'), priority: 40 }];
      }
    `);
    await app.reloadSkills({ reason: 'test' });

    await fire('@覆盖Bot 护栏第一句', 70040);
    const r2 = await fire('@覆盖Bot 护栏第二句', 70041);
    // 现状：动态段变化 → systemPrompt 不等 → fresh（messages 只有 system+user）
    assert.equal(r2.messages.length, 2,
      '动态提示词段变化时应走 fresh（messages 仅 system+user）—— 此为已知行为护栏');
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
    try { await app.reloadSkills({ reason: 'test' }); } catch { /* ignore */ }
  }
});

await teardown();

console.log(`\n会话延续端到端：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) { console.log('失败项：'); for (const f of fail) console.log('  - ' + f); process.exit(1); }
