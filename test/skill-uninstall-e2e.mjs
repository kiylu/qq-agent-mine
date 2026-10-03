// 卸载技能/插件接口端到端测试（POST /api/skills/uninstall）
//
// 为什么单独测：删除是**唯一不可逆**的扩展操作，删错了没法恢复。
// 最需要守住的不是"能删掉"，而是"**不该删的删不掉**"——
//   · 路径穿越（`../` 删到根目录外）
//   · 删不存在的条目
//   · 类型判定错（把插件当技能、或反之，删错目录）
//
// ⚠️ 必须是独立进程：QQ_AGENT_DATA_DIR 与 QQ_AGENT_SKILLS_DIR 必须在 import
//    src/config.js 之前设好（config.js 在模块顶层就固化 DATA_DIR）。
//    放进已有静态 import 的测试文件会读到/删掉**用户真实的 skills/ plugins/**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ① 先隔离三个目录 —— 必须早于任何 src/ 的 import
const __dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-uninstall-e2e-'));
const SKILLS_ROOT = path.join(__dir, 'skills');
const PLUGINS_ROOT = path.join(__dir, 'plugins');
fs.mkdirSync(SKILLS_ROOT, { recursive: true });
fs.mkdirSync(PLUGINS_ROOT, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = path.join(__dir, 'data');
process.env.QQ_AGENT_SKILLS_DIR = SKILLS_ROOT;
process.env.QQ_AGENT_PLUGINS_DIR = PLUGINS_ROOT;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { createApp } = await imp('src/app.js');
const { updateConfig } = await imp('src/config.js');

let pass = 0, fail = 0;
const check = (n, c, e = '') => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); }
};

// 造一个可加载的技能目录（清单 + 入口）
function makeSkill(id, kind = 'skill') {
  const dir = path.join(kind === 'plugin' ? PLUGINS_ROOT : SKILLS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify({
    id, name: `测试${id}`, version: '1.0.0', description: '用于卸载测试',
    ...(kind === 'plugin' ? { capabilities: ['test.cap'] } : {})
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'),
    kind === 'plugin'
      ? `export function setup(api){}\nexport const providers={'test.cap':()=>1};\n`
      : `export function setup(api){ api.registerTool({id:'noop',description:'no-op',parameters:{type:'object',properties:{}} , execute:async()=>({content:'ok'})}); }\n`,
    'utf8');
  return dir;
}

const app = createApp({ log: () => {} });
const port = await app.start(0);
const base = `http://127.0.0.1:${port}`;
console.log('=== 技能/插件卸载 · 端到端（真实服务）===\n');
console.log(`  隔离目录：\n    skills  = ${SKILLS_ROOT}\n    plugins = ${PLUGINS_ROOT}\n`);

// 三个可删条目 + 一个必须活着的「无辜目录」（用于验证穿越防护）
const skillDir = makeSkill('demo-skill', 'skill');
const pluginDir = makeSkill('demo-plugin', 'plugin');
const innocent = path.join(SKILLS_ROOT, 'keep-me');
fs.mkdirSync(innocent, { recursive: true });
fs.writeFileSync(path.join(innocent, 'important.txt'), 'do not delete', 'utf8');
// 根目录外的哨兵文件：任何穿越尝试都不许碰到它
const outside = path.join(__dir, 'OUTSIDE-SENTINEL.txt');
fs.writeFileSync(outside, 'must survive', 'utf8');

// 给 demo-skill 配一段设置，验证删除后配置残留也一并清掉
updateConfig({ skills: { 'demo-skill': { enabled: true, someKey: 'v' } } });

// 等首屏加载完成，确保三个条目都进了注册表
for (let i = 0; i < 40; i++) {
  const r = await (await fetch(`${base}/api/skills`)).json();
  if ((r.skills || []).length >= 2) break;
  await new Promise((res) => setTimeout(res, 100));
}
const before = await (await fetch(`${base}/api/skills`)).json();
check('前置：两个测试条目已加载', (before.skills || []).length >= 2,
  `实际 ${(before.skills || []).length} 个：${(before.skills || []).map((s) => s.id).join(',')}`);

const post = async (body) => {
  const res = await fetch(`${base}/api/skills/uninstall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// ── 1. 正常卸载技能：目录消失、列表更新、配置清掉 ──
{
  const r = await post({ id: 'demo-skill' });
  check('卸载技能：200', r.status === 200, JSON.stringify(r.json));
  check('卸载技能：kind 判定为 skill', r.json.kind === 'skill', JSON.stringify(r.json));
  check('卸载技能：目录已删除', !fs.existsSync(skillDir));
  check('卸载技能：重扫成功', r.json.rescanned === true);
  check('卸载技能：返回的列表已不含它', !(r.json.skills || []).some((s) => s.id === 'demo-skill'));
  check('卸载技能：配置残留已清掉', r.json.config?.skills?.['demo-skill'] == null,
    JSON.stringify(r.json.config?.skills));
  check('卸载技能：只读刷新拿到的列表也不含它',
    !((await (await fetch(`${base}/api/skills`)).json()).skills || []).some((s) => s.id === 'demo-skill'));
}

// ── 2. 正常卸载插件：按 plugins/ 目录删（类型判定不能错）──
{
  const r = await post({ id: 'demo-plugin' });
  check('卸载插件：200', r.status === 200, JSON.stringify(r.json));
  check('卸载插件：kind 判定为 plugin', r.json.kind === 'plugin', JSON.stringify(r.json));
  check('卸载插件：plugins/ 下的目录已删除', !fs.existsSync(pluginDir));
  check('卸载插件：skills/ 下没被误删同名目录', !fs.existsSync(path.join(SKILLS_ROOT, 'demo-plugin')));
}

// ── 3. 路径穿越：各种花招都必须被拒，且根目录外哨兵文件存活 ──
{
  const attacks = [
    '../OUTSIDE-SENTINEL',
    '../../OUTSIDE-SENTINEL',
    '..',
    'a/../../OUTSIDE-SENTINEL',
    'keep-me/..',
    'demo-skill/../keep-me'
  ];
  for (const id of attacks) {
    const r = await post({ id });
    const rejected = r.status === 400 || r.status === 404;
    check(`穿越被拒：${JSON.stringify(id)}`, rejected, `status=${r.status} ${JSON.stringify(r.json)}`);
  }
  check('穿越攻击后根目录外哨兵文件仍存在', fs.existsSync(outside));
  check('穿越攻击后 skills/ 目录完好', fs.existsSync(innocent) && fs.existsSync(path.join(innocent, 'important.txt')));
}

// ── 4. 删不存在的条目：404，且不误删任何东西 ──
{
  const r = await post({ id: 'no-such-skill' });
  check('删不存在的条目：404', r.status === 404, `status=${r.status}`);
  check('删不存在的条目：keep-me 未受影响', fs.existsSync(path.join(innocent, 'important.txt')));
}

// ── 5. 缺 id / 空 id ──
{
  check('缺少 id：400', (await post({})).status === 400);
  check('空 id：400', (await post({ id: '   ' })).status === 400);
}

// ── 6. 非法字符 ──
{
  for (const id of ['has space', 'semi;colon', 'star*', '中文名', 'a\\b']) {
    const r = await post({ id });
    check(`非法 id 被拒：${JSON.stringify(id)}`, r.status === 400, `status=${r.status}`);
  }
}

// ── 7. 重复删除：第二次应 404（幂等失败而非崩溃）──
{
  const r = await post({ id: 'demo-skill' });
  check('重复卸载：404 而非 500', r.status === 404, `status=${r.status}`);
}

await app.stop();
fs.rmSync(__dir, { recursive: true, force: true });
console.log(`\n=== ${fail ? 'FAILED' : 'ALL PASSED'} — pass=${pass} fail=${fail} ===`);
process.exit(fail ? 1 : 0);
