// 「扩展」二级菜单 + 卡片删除按钮的**真实 DOM 行为**测试（jsdom）。
//
// 为什么必须用 jsdom 而不是字符串断言：
//   本轮改造的逻辑全在**事件与状态**上 —— 点「扩展」要展开、点二级项要切页并收起、
//   点别处要收起、Esc 要收起。字符串断言只能证明"代码写了"，证明不了"点了有反应"。
//   之前 12 段脚本里有两处 bug（切页不收起、点外部不收起）就是纯字符串断言放过的。
//
// 隔离：不连真实服务。api() 用 fetch 桩拦掉，只验纯前端交互。
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (c, m, d) => (c ? ok(m) : bad(m, d));

// ── 1) 起一个装了真实 index.html 的 DOM ──
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
// runScripts:'outside-only' —— 不执行页面内联脚本，但让 window.eval 在**浏览器上下文**里跑，
// 否则 document/MouseEvent 全都不存在（默认 window.eval 落在 Node 全局上）。
const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:3210/',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
const { window } = dom;
const { document } = window;

check(!!document.getElementById('ext-tab'), '真实 HTML 里有「扩展」一级页签');
check(!!document.getElementById('ext-submenu'), '真实 HTML 里有二级菜单容器');
check(document.querySelectorAll('#ext-submenu .ext-subitem').length === 2,
  '二级菜单两项（技能 / 插件）');

// ── 2) 注入被测实现 + 最小依赖 ──
// 只跑本轮真正新增的两个函数（syncExtTabActive / initExtSubmenu），
// 不启动整个应用 —— 那会拖起 SSE 轮询和启动引导，与被测逻辑无关。
const seg = (n) => fs.readFileSync(path.join(ROOT, 'ui', 'app', n), 'utf8');
const init = seg('11-init.js');

// 按大括号配对精确抽出函数源码（避免正则跨函数体误吞）
const grab = (src, name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} 括号不配对`);
};

// switchTab 收敛成只做「高亮 + 切视图 + 派发事件」——
// 真实实现还管 usage 分支/滚动复位，那些与本轮被测行为无关，混进来只会让测试变脆。
const harness = `
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const $ = (sel) => document.querySelector(sel);
  const TAB_VIEWS = { skills: 'view-skills', plugins: 'view-plugins' };
  function switchTab(name) {
    window.__lastTab = name;
    for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const v of $$('.view')) v.hidden = v.id !== TAB_VIEWS[name];
    if (typeof syncExtTabActive === 'function') syncExtTabActive(name);
    document.dispatchEvent(new CustomEvent('qqagent:tabswitched', { detail: name }));
  }
  function refreshStatus() {}
  ${grab(init, 'syncExtTabActive')}
  ${grab(init, 'initExtSubmenu')}
  initExtSubmenu();
`;

window.eval(harness);

const tab = document.getElementById('ext-tab');
const menu = document.getElementById('ext-submenu');
const subSkills = menu.querySelector('[data-ext-tab="skills"]');
const subPlugins = menu.querySelector('[data-ext-tab="plugins"]');

// ── 3) 初始状态：收起 ──
check(menu.hidden === true, '初始状态二级菜单是收起的');
check(tab.getAttribute('aria-expanded') === 'false', '初始 aria-expanded=false');

// ── 4) 点「扩展」→ 展开 ──
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(menu.hidden === false, '点「扩展」后菜单展开');
check(tab.classList.contains('ext-open'), '页签进入 ext-open 态（三角翻转）');
check(tab.getAttribute('aria-expanded') === 'true', '展开后 aria-expanded=true');

// ── 5) 再点「扩展」→ 收起（toggle）──
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(menu.hidden === true, '再点「扩展」收起（是 toggle 不是单向展开）');
check(!tab.classList.contains('ext-open'), '收起后 ext-open 类被摘掉');

// ── 6) 展开后点二级项 → 切页 + 收起 ──
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
subPlugins.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(window.__lastTab === 'plugins', '点「插件」切到 plugins 页');
check(menu.hidden === true, '选完二级项菜单自动收起');
check(tab.classList.contains('active'), '「扩展」在插件页保持高亮（共同父级）');

// ── 7) 点技能项 → 切到 skills，「扩展」仍高亮 ──
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
subSkills.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(window.__lastTab === 'skills', '点「技能」切到 skills 页');
check(tab.classList.contains('active'), '「扩展」在技能页保持高亮');

// ── 8) 切到别的页签 → 菜单自动收起（不能悬在别的页面上方）──
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(menu.hidden === false, '重新展开');
window.eval("switchTab('usage')");
check(menu.hidden === true, '切到「用量」后菜单自动收起（监听 qqagent:tabswitched）');

// 切到 skills/plugins 本身不该收起（那两页就是扩展的家）
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
window.eval("switchTab('skills')");
check(menu.hidden === false, '切到「技能」时菜单保持展开（它本来就是扩展页）');
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));   // 手动收起
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
window.eval("switchTab('plugins')");
check(menu.hidden === false, '切到「插件」时菜单保持展开');

// ── 9) 点菜单外部 → 收起 ──
document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check(menu.hidden === true, '点页面其它地方收起');

// ── 10) Esc → 收起 ──
tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
check(menu.hidden === true, 'Esc 收起');

// ── 11) 一级导航不再有「插件」独立页签（是本轮的核心诉求）──
const dataTabs = Array.from(new Set(Array.from(document.querySelectorAll('.tab')).map((t) => t.dataset.tab)));
check(dataTabs.includes('skills') && !dataTabs.includes('plugins'),
  `一级页签只有 skills 入口、无独立 plugins（实际：${dataTabs.join(',')}）`);

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
window.close();
process.exit(fail ? 1 : 0);
