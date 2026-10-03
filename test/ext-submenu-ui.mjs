// 二级菜单（jsdom 真实 DOM 行为）测试。
//
// 为什么必须用 jsdom 而不是字符串断言：
//   这套逻辑全在**事件与状态**上 —— 点父级要展开、点二级项要切页并收起、
//   点别处要收起、Esc 要收起、两组菜单不能同时展开。字符串断言只能证明
//   "代码写了"，证明不了"点了有反应"。之前就有两处 bug（切页不收起、
//   点外部不收起）是纯字符串断言放过的。
//
// 当前有两组二级菜单，共用同一套 initSubmenu：
//   「记录」#archive-tab  → #archive-submenu  → chats / memory
//   「扩展」#ext-tab      → #ext-submenu      → skills / plugins
// 所以下面按组参数化跑一遍 —— 只测第一组会漏掉"两组同时展开"这类问题。
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

// ── 2) 注入被测实现 + 最小依赖 ──
// 只跑本轮真正新增的三个函数（initSubmenu / syncParentTabsActive + 页面切换），
// 不启动整个应用 —— 那会拖起 SSE 轮询和启动引导，与被测行为无关。
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
// 真实实现还管 usage 分支/滚动复位/各页懒加载，那些与本轮被测行为无关。
const harness = `
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const $ = (sel) => document.querySelector(sel);
  const TAB_VIEWS = {
    chats: 'view-chats', memory: 'view-memory',
    skills: 'view-skills', plugins: 'view-plugins'
  };
  function switchTab(name) {
    window.__lastTab = name;
    for (const v of $$('.view')) v.hidden = v.id !== TAB_VIEWS[name];
    if (typeof syncParentTabsActive === 'function') syncParentTabsActive(name);
    document.dispatchEvent(new CustomEvent('qqagent:tabswitched', { detail: name }));
  }
  function refreshStatus() {}
  const submenus = [];
  ${grab(init, 'initSubmenu')}
  ${grab(init, 'syncParentTabsActive')}
  initSubmenu('archive-tab', 'archive-submenu', ['chats', 'memory']);
  initSubmenu('ext-tab', 'ext-submenu', ['skills', 'plugins']);
`;
window.eval(harness);

const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// ── 3) 两组菜单共用同一套行为，逐组跑 ──
const GROUPS = [
  { name: '记录', tab: 'archive-tab', menu: 'archive-submenu', pages: ['chats', 'memory'], views: ['view-chats', 'view-memory'] },
  { name: '扩展', tab: 'ext-tab', menu: 'ext-submenu', pages: ['skills', 'plugins'], views: ['view-skills', 'view-plugins'] }
];

for (const g of GROUPS) {
  console.log(`\n── 「${g.name}」二级菜单 ──`);
  const tab = document.getElementById(g.tab);
  const menu = document.getElementById(g.menu);
  const subA = menu.querySelector(`[data-sub-tab="${g.pages[0]}"]`);
  const subB = menu.querySelector(`[data-sub-tab="${g.pages[1]}"]`);

  check(!!tab, `「${g.name}」有一级触发器 #${g.tab}`);
  check(!!menu, `「${g.name}」有二级菜单容器 #${g.menu}`);
  check(menu.querySelectorAll('.ext-subitem').length === 2, `「${g.name}」二级菜单两项`);
  check(!!subA && !!subB, `两项都带 data-sub-tab（${g.pages.join(' / ')}）`);
  for (const id of g.views) {
    check(!!document.getElementById(id), `视图容器 ${id} 保留（内容页没合并掉）`);
  }

  // 初始收起
  check(menu.hidden === true, '初始收起');
  check(tab.getAttribute('aria-expanded') === 'false', '初始 aria-expanded=false');

  // 展开 / toggle
  click(tab);
  check(menu.hidden === false, '点父级展开');
  check(tab.classList.contains('ext-open'), '进入 ext-open 态（三角翻转）');
  check(tab.getAttribute('aria-expanded') === 'true', '展开后 aria-expanded=true');
  click(tab);
  check(menu.hidden === true, '再点收起（是 toggle 不是单向展开）');
  check(!tab.classList.contains('ext-open'), '收起后 ext-open 被摘掉');

  // 二级项：切页 + 收起 + 父级保持高亮
  click(tab);
  click(subB);
  check(window.__lastTab === g.pages[1], `点第二项切到 ${g.pages[1]} 页`);
  check(menu.hidden === true, '选完自动收起');
  check(tab.classList.contains('active'), `父级在 ${g.pages[1]} 页保持高亮（共同父级）`);

  click(tab);
  click(subA);
  check(window.__lastTab === g.pages[0], `点第一项切到 ${g.pages[0]} 页`);
  check(tab.classList.contains('active'), `父级在 ${g.pages[0]} 页保持高亮`);

  // 切到别的页签 → 自动收起；切到自家页签 → 保持展开
  click(tab);
  window.eval("switchTab('sessions')");
  check(menu.hidden === true, '切到无关页签后自动收起（监听 qqagent:tabswitched）');
  click(tab);
  window.eval(`switchTab('${g.pages[0]}')`);
  check(menu.hidden === false, '切到自家页面时保持展开（它本来就是这一组的家）');
  click(tab);   // 收起，免得影响下一组

  // 点外部收起 / Esc 收起
  document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check(menu.hidden === true, '点页面其它地方收起');
  click(tab);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(menu.hidden === true, 'Esc 收起');
}

// ── 4) 两组菜单不能同时展开（会互相盖住）──
console.log('\n── 两组菜单互斥 ──');
const archiveTab = document.getElementById('archive-tab');
const archiveMenu = document.getElementById('archive-submenu');
const extMenu = document.getElementById('ext-submenu');
click(archiveTab);
check(archiveMenu.hidden === false, '先展开「记录」');
click(document.getElementById('ext-tab'));
check(extMenu.hidden === false, '再展开「扩展」');
check(archiveMenu.hidden === true, '「记录」被自动收起（两组不同时展开）');
click(document.getElementById('ext-tab'));

// ── 5) 导航结构：一级页签里不再有平级的 存档 / 记忆 / 插件 ──
console.log('\n── 导航结构 ──');
const dataTabs = Array.from(new Set(Array.from(document.querySelectorAll('.tab')).map((t) => t.dataset.tab)));
check(dataTabs.length === 6, `一级页签 6 项（实际 ${dataTabs.length}：${dataTabs.join(',')}）`);
check(dataTabs.includes('chats') && !dataTabs.includes('memory'),
  '「记忆」不再是平级一级页签（并入「记录」）');
check(dataTabs.includes('skills') && !dataTabs.includes('plugins'),
  '「插件」不再是平级一级页签（并入「扩展」）');

// 存档页仍可直达：switchTab('chats') 必须走通（金句上传的 enterQuoteMode 依赖它）
window.eval("switchTab('chats')");
check(window.__lastTab === 'chats', 'switchTab("chats") 仍能直达存档页（程序内跳转依赖它）');
check(document.getElementById('view-chats').hidden === false, '存档视图真的显示了');
window.eval("switchTab('memory')");
check(document.getElementById('view-memory').hidden === false, '记忆视图真的显示了');
check(document.getElementById('view-chats').hidden === true, '切走后存档视图隐藏');

// 意见收集入口已移除
check(!document.getElementById('feedback-btn'), '「意见收集」按钮已从顶栏移除');

// ── 6) 触发概率手动输入 ⇄ 滑条 的换算 ──
// 这段是数值逻辑，纯静态断言挡不住错位（第一版就写反了公式：
// 输入 0% 落到 2 档、100% 落到 4 档，语义完全反了），所以真跑一遍。
console.log('\n── 触发概率 ⇄ 滑条换算 ──');
{
  const community = seg('09-community.js');
  // 连签名一起抽（函数体里用了参数 pct / p，只抽 body 会 ReferenceError）
  const m = /const probToPos = \(pct\) => \{[\s\S]*?\n {2}\};/.exec(community);
  check(!!m, '能从 09-community.js 里抽出 probToPos');
  if (m) {
    const { sliderToTier, TIER_SLIDER_BANDS: B } = await import('../src/tier-slider.js');
    // eslint-disable-next-line no-new-func
    const probToPos = new Function('TIER_SLIDER_BANDS', m[0].replace(/^const probToPos = /, 'return '))(B);
    // 端点也算 —— 0% / 100% 恰恰是最容易落错档位的两个值
    let wrongTier = 0; let maxErr = 0; let worstAt = -1;
    for (let pct = 0; pct <= 100; pct++) {
      const r = sliderToTier(probToPos(pct));
      if (r.tier !== 3) { if (wrongTier < 3) console.log(`      pct=${pct} → ${r.tier} 档`); wrongTier++; }
      const err = Math.abs(r.randomPercent - pct);
      if (err > maxErr) { maxErr = err; worstAt = pct; }
    }
    check(wrongTier === 0, `0~100% 全部落在 3 档（错位 ${wrongTier} 个）`);
    check(maxErr < 1, `往返误差 ${maxErr.toFixed(2)}% @ ${worstAt}%（<1% 属取整噪声）`);
    // 抽样核对具体数值
    const s50 = sliderToTier(probToPos(50));
    check(s50.tier === 3 && s50.randomPercent === 50, `50% → ${s50.tier} 档 / ${s50.randomPercent}%`);
    const s0 = sliderToTier(probToPos(0));
    check(s0.tier === 3 && s0.randomPercent === 0, `0% → ${s0.tier} 档 / ${s0.randomPercent}%（不能落到 2 档）`);
    const s100 = sliderToTier(probToPos(100));
    check(s100.tier === 3 && s100.randomPercent === 100, `100% → ${s100.tier} 档 / ${s100.randomPercent}%（不能落到 4 档）`);
  }
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
window.close();
process.exit(fail ? 1 : 0);
