// 覆盖测试 D：静态界面层
//
// 覆盖：
//   - 样式表结构（主题块不重复、无冲突重复选择器、无死样式、括号平衡）
//   - HTML 本地资源引用全部存在
//   - 主题机制统一（data-theme + qqa-theme）
//   - ui/vendor 下的镜像文件与 src/ 逻辑一致
//   - app.js 引用的 DOM id 都能在某处被创建
//   - 弹窗可访问性（role/aria/Esc 关闭）
//
// 运行：node test/coverage-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, createChecker } from './_harness.mjs';

const c = createChecker('静态界面层覆盖');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const css = read('ui/style.css');
const html = read('ui/index.html');
const landing = read('ui/landing.html');
// M9 拆分：静态扫描面向全部 12 段拼接后的完整代码（与浏览器实际执行的集合一致）
const appJs = (await import('./_ui-load.mjs')).loadUiAppCode().code;

// ── 1. 样式表结构 ────────────────────────────────────────────────────────
c.section('1. 样式表结构');

/** 简易顶层规则解析（与审查脚本一致） */
function parseRules(src) {
  const lines = src.split('\n');
  const rules = [];
  let depth = 0, buf = '', sel = '', start = 0, inComment = false;
  for (let ln = 0; ln < lines.length; ln++) {
    let s = lines[ln].replace(/\/\*.*?\*\//g, '');
    if (inComment) { const e = s.indexOf('*/'); if (e >= 0) { inComment = false; s = s.slice(e + 2); } else continue; }
    const cs = s.indexOf('/*');
    if (cs >= 0) { const ce = s.indexOf('*/', cs); if (ce < 0) { inComment = true; s = s.slice(0, cs); } }
    for (const ch of s) {
      if (ch === '{') { if (depth === 0) { sel = buf.trim(); start = ln + 1; } depth++; buf += ch; }
      else if (ch === '}') { depth--; buf += ch; if (depth === 0) { rules.push({ sel, start, body: buf }); buf = ''; } }
      else buf += ch;
    }
    if (depth === 0) buf = '';
  }
  return rules;
}

await c.check('CSS 大括号平衡', () => {
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  assert.equal(open, close, `{ ${open} vs } ${close}`);
});

const rules = parseRules(css);

await c.check('「？」主题（已移除的彩蛋主题）基础 token 块不得残留', () => {
  // 2026-09 concept2 收敛版把「？」主题整体移除（:root + dark/light 两个 data-theme 块）。
  // 原断言要求该块"恰好出现 1 次"，但主题已删，现改为不得出现。
  const tokenBlocks = rules.filter((r) => /^\s*\[data-theme='\?'\]\s*$/.test(r.sel));
  assert.equal(tokenBlocks.length, 0, `? 主题基础 token 块应已移除，但仍出现 ${tokenBlocks.length} 次：行 ${tokenBlocks.map((r) => r.start).join(', ')}`);
  const banners = (css.match(/「？」主题 v3/g) || []).length;
  assert.equal(banners, 0, `「？」主题 v3 的注释横幅应已移除，但仍出现 ${banners} 次`);
});

await c.check('没有任何选择器被重复定义且属性值冲突', () => {
  const bySel = new Map();
  for (const r of rules) {
    const key = r.sel.replace(/\s+/g, ' ').trim();
    if (!key || key.startsWith('@')) continue;
    if (!bySel.has(key)) bySel.set(key, []);
    bySel.get(key).push(r);
  }
  const conflicts = [];
  for (const [sel, list] of bySel) {
    if (list.length < 2) continue;
    const props = new Map();
    for (const r of list) {
      const inner = r.body.slice(r.body.indexOf('{') + 1, r.body.lastIndexOf('}'));
      for (const decl of inner.split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const p = decl.slice(0, i).trim();
        const v = decl.slice(i + 1).trim();
        if (!p || !v) continue;
        if (!props.has(p)) props.set(p, new Set());
        props.get(p).add(v);
      }
    }
    for (const [p, vals] of props) {
      if (vals.size > 1) conflicts.push(`${sel} { ${p}: ${[...vals].join(' VS ')} }`);
    }
  }
  assert.equal(conflicts.length, 0, `存在 ${conflicts.length} 处冲突：\n  ${conflicts.join('\n  ')}`);
});

await c.check('已删除的「保存栏」相关样式不得残留（组件已改为即时保存）', () => {
  for (const dead of ['.save-bar', '.unsaved-dot', '.saved-pulse', '.saved-flash', '#cfg-save-result', '@keyframes pulseRing', '@keyframes savedFlash']) {
    assert.ok(!css.includes(dead), `样式表里仍残留 ${dead}`);
  }
});

await c.check('引用 @keyframes 动画名都必须有定义（避免写了动画却不生效）', () => {
  const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of css.matchAll(/animation(?:-name)?:\s*([^;}]+)/g)) {
    for (const part of m[1].split(',')) {
      for (const tok of part.trim().split(/\s+/)) {
        if (/^[a-zA-Z][\w-]*$/.test(tok) && !/^(none|infinite|linear|ease|ease-in|ease-out|ease-in-out|forwards|backwards|both|alternate|reverse|running|paused|steps|var)$/.test(tok)) {
          used.add(tok);
        }
      }
    }
  }
  const missing = [...used].filter((k) => !defined.has(k) && !k.startsWith('--'));
  assert.equal(missing.length, 0, `使用了未定义的动画名：${missing.join(', ')}`);
});

await c.check('主题 token 齐备：两个主题都定义了颜色/阴影/前景色变量', () => {
  for (const v of ['--layer-0', '--text', '--muted', '--accent', '--green', '--red', '--orange',
    '--lift-sm', '--lift', '--lift-lg', '--paper-edge', '--depth', '--bevel', '--on-accent', '--overlay']) {
    const hits = (css.match(new RegExp(`\\${v}:`, 'g')) || []).length;
    assert.ok(hits >= 2, `${v} 只出现了 ${hits} 次（至少应在暗/亮两个主题各定义一次）`);
  }
});

// ── 2. HTML 资源引用 ─────────────────────────────────────────────────────
c.section('2. HTML 资源引用与主题机制');

function localRefs(src) {
  const out = [];
  // 只检查"子资源"（script/link/img 的 src/href）。
  // <a href> 是站内导航（落地页部署在官网时 /qq-agent/... 是有效的），不算本地资源；
  // 安装包下载链接另有专门断言。
  for (const m of src.matchAll(/<script[^>]*?src="([^"]+)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/<link[^>]*?href="([^"]+)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/<img[^>]*?src="([^"]+)"/g)) out.push(m[1]);
  return out.filter((u) => !/^(https?:|mailto:|#|data:)/.test(u));
}

await c.check('index.html 的本地资源引用全部存在', () => {
  for (const u of localRefs(html)) {
    const p = path.join(ROOT, 'ui', u.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), `index.html 引用了不存在的资源：${u}`);
  }
});

await c.check('架构描述与「会话延续」对齐（2026-10-03 改造后已不是无状态）', () => {
  const pkgDesc = String(JSON.parse(read('package.json')).description || '');
  assert.ok(pkgDesc.length > 0, 'package.json 缺 description');
  assert.ok(/会话延续/.test(pkgDesc),
    `package.json 的 description 还在说「无状态」：${pkgDesc}`);
  assert.ok(!/无状态/.test(pkgDesc),
    `package.json 的 description 残留「无状态」：${pkgDesc}`);

  // landing 是对外的落地页，宣称与实际架构必须一致（改造后每次触发不再是独立会话）。
  assert.ok(!/无状态/.test(landing),
    'landing.html 还在宣称「无状态会话」—— 架构早已改为会话延续');

  // orchestrator 头注释是新人第一份文档，说反了会直接误导后续改动。
  const orch = read('src/orchestrator.js').slice(0, 2000);
  assert.ok(!/"无状态运行"核心/.test(orch),
    'orchestrator.js 头注释仍称「无状态运行」核心，与 continuation 分支矛盾');
  assert.ok(/会话延续/.test(orch),
    'orchestrator.js 头注释没提会话延续，改动背景丢失');
});

await c.check('landing.html 的本地资源引用全部存在（曾经引用过不存在的 /assets/theme.*）', () => {
  // ⚠️ landing.html 是**部署到官网**的落地页：/assets/theme.* 是站点级主题包，
  // 存在于服务器上而不在本仓库 ui/ 下（本地直开由 .no-theme 兜底，见页面注释）。
  // 站级资源只校验路径前缀；与页面同目录的相对文件（如群二维码）必须本地存在。
  for (const u of localRefs(landing)) {
    if (/^\/(assets|vendor)\//.test(u)) continue;   // 站级资源，服务器侧存在
    // 群二维码图片：随 ui/ 一起分发（landing.html 落地页引用）。
    if (u === 'group-qrcode.jpg') {
      const p = path.join(ROOT, 'ui', u);
      assert.ok(fs.existsSync(p), `landing.html 引用的群二维码不存在：${u}`);
      continue;
    }
    if (u.startsWith('/')) {
      assert.fail(`landing.html 不应引用其它本地根路径资源：${u}`);
    } else {
      const p = path.join(ROOT, 'ui', u);
      assert.ok(fs.existsSync(p), `landing.html 引用了不存在的同目录资源：${u}`);
    }
  }
});

await c.check('两个页面的主题机制统一：data-theme + qqa-theme', () => {
  // landing.html 跟随**主站**的主题约定（localStorage 'theme' 键 + html.light/dark），
  // 与控制台（qqa-theme 键）是两套刻意的口径 —— 只对 index.html 校验控制台约定。
  for (const [name, src] of [['index.html', html]]) {
    assert.ok(/qqa-theme/.test(src), `${name} 未使用 qqa-theme 键`);
    assert.ok(/data-theme/.test(src), `${name} 未使用 data-theme 属性`);
    assert.ok(!/localStorage\.getItem\('theme'\)/.test(src), `${name} 仍在读旧的 'theme' 键`);
    assert.ok(!/html\.dark\s*\{/.test(src), `${name} 仍在使用 html.dark 选择器（永远不会命中）`);
  }
});

// ── 2.1 页签与视图容器必须成对 ───────────────────────────────────────────
//
// 加页签时最容易漏掉的第二步：只在 nav 里加了按钮，忘了加 <section id="view-xxx">。
// 后果是点上去"什么也不发生"（switchTab 把视图全隐藏了，但没有一个匹配），
// 而且不报错 —— 正是最该由静态检查兜住的一类。

c.section('2.1 页签 ↔ 视图容器');

await c.check('每个页签都有对应的 view-<name> 容器', () => {
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 5, `页签数量异常（${tabs.length}）：${tabs.join(', ')}`);
  const missing = tabs.filter((t) => !html.includes(`id="view-${t}"`));
  assert.equal(missing.length, 0,
    `这些页签没有对应的视图容器（点上去会没有任何反应）：${missing.join(', ')}`);
});

await c.check('「扩展」是技能/插件的共同父级页签（二级选择器）', () => {
  // 2026-10-03：技能、插件合并为一级菜单「扩展」，内容仍分两页。
  // 所以一级 nav 里只该有「扩展」（data-tab="skills"），「插件」降为二级项。
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.includes('skills'), '找不到一级「扩展」页签（data-tab="skills"）');
  // 「插件」不再是一级页签（否则又变回两个平级页签，合并就白做了）
  assert.ok(!tabs.includes('plugins'),
    `「插件」不应再是一级页签，实际一级页签：${tabs.join(' → ')}`);
  // 二级选择器与两个选项（属性名是 data-sub-tab，两组菜单共用）
  assert.ok(html.includes('id="ext-submenu"'), '缺少二级选择器容器 #ext-submenu');
  assert.ok(html.includes('id="ext-tab"'), '缺少一级触发器 #ext-tab');
  assert.ok(/data-sub-tab="skills"/.test(html), '二级选择器缺少「技能」项');
  assert.ok(/data-sub-tab="plugins"/.test(html), '二级选择器缺少「插件」项');
  // 两个视图容器也都得在（内容页没合并掉）
  for (const id of ['view-skills', 'view-plugins']) {
    assert.ok(html.includes(`id="${id}"`), `缺少视图容器 ${id}`);
  }
});

await c.check('「记录」是存档/记忆的共同父级页签（二级选择器）', () => {
  // 2026-10-03：存档、记忆合并为一级菜单「记录」，内容仍分两页。
  const tabs = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.includes('chats'), '找不到一级「记录」页签（data-tab="chats"）');
  assert.ok(!tabs.includes('memory'),
    `「记忆」不应再是一级页签，实际一级页签：${tabs.join(' → ')}`);
  assert.ok(html.includes('id="archive-submenu"'), '缺少二级选择器容器 #archive-submenu');
  assert.ok(html.includes('id="archive-tab"'), '缺少一级触发器 #archive-tab');
  assert.ok(/data-sub-tab="chats"/.test(html), '二级选择器缺少「存档」项');
  assert.ok(/data-sub-tab="memory"/.test(html), '二级选择器缺少「记忆」项');
  for (const id of ['view-chats', 'view-memory']) {
    assert.ok(html.includes(`id="${id}"`), `缺少视图容器 ${id}`);
  }
  // 两组合并后顶栏从 8 项收到 6 项
  assert.strictEqual(tabs.length, 6, `一级页签应为 6 项，实际 ${tabs.length}：${tabs.join(' → ')}`);
});

await c.check('二级菜单是通用实现（两组共用一套逻辑，不是复制两份）', () => {
  assert.ok(/function initSubmenu\(tabId, menuId, pages\)/.test(appJs), '缺少通用的 initSubmenu');
  assert.ok(!/function initExtSubmenu/.test(appJs), '旧的单组实现 initExtSubmenu 应该已被泛化替换');
  assert.ok(/initSubmenu\('archive-tab', 'archive-submenu', \['chats', 'memory'\]\)/.test(appJs),
    '没有用 initSubmenu 初始化「记录」组');
  assert.ok(/initSubmenu\('ext-tab', 'ext-submenu', \['skills', 'plugins'\]\)/.test(appJs),
    '没有用 initSubmenu 初始化「扩展」组');
  // 两组互斥：展开一组要关掉另一组，否则会互相盖住
  assert.ok(/for \(const other of submenus\) if \(other !== api\) other\.close\(\)/.test(appJs),
    '二级菜单之间没有互斥逻辑（展开两组会互相盖住）');
  // 切页高亮：父级页签要在自家两页都保持高亮
  assert.ok(/function syncParentTabsActive/.test(appJs), '缺少 syncParentTabsActive');
});

await c.check('「意见收集」入口已移除', () => {
  assert.ok(!/id="feedback-btn"/.test(html), 'index.html 里仍有「意见收集」按钮');
  assert.ok(!/feedback-btn/.test(appJs), 'JS 里仍有 feedback-btn 绑定');
  // 删按钮后这些都成了没人调用的孤本，一并清掉。
  // 判据是「有没有被调用/定义」，不能只搜名字 —— 刻意留的说明注释里
  // 会出现这些词（记录移除决策），那是文档不是死代码。
  const code = appJs.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const dead of ['openFeedbackModal', 'FB_DRAFT_KEY', 'fbCompressImage', 'fbLoadDraft', 'doUploadFeedback']) {
    assert.ok(!new RegExp(dead).test(code), `删入口后 ${dead} 成了孤本，应一并移除`);
  }
  // 连带死样式（同样跳过注释，那里记着"已移除"）
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\.fb-imgs/.test(cssCode), 'style.css 里仍有 .fb-imgs（意见收集的附图九宫格）');
});

await c.check('活跃设置可手动输入触发概率且与滑条同步', () => {
  assert.ok(/id="ac-prob-input"/.test(appJs), '缺少概率输入框 #ac-prob-input');
  assert.ok(/syncProbBox = \(\)/.test(appJs), '缺少 syncProbBox（滑条 → 输入框方向）');
  // 输入 → 滑条：按 3 档正向公式反解，**不能**用 tierToSlider(3, pct)
  // （它把端点取整到档位中心，0% 会落到 20 = 2 档，语义错位）。
  assert.ok(/const probToPos = \(pct\) =>/.test(appJs), '缺少 probToPos 换算函数');
  assert.ok(/tier2End \+ \(p \/ 100\) \* \(B2\.tier3End - B2\.tier2End\)/.test(appJs),
    'probToPos 没有按 3 档正向公式反解（pos = tier2End + pct/100 × 段长）');
  assert.ok(!/tierToSlider\(\{ contextTier: 3/.test(appJs),
    'probToPos 用 tierToSlider(3, pct) 换算 —— 端点会被取整到 2/4 档（0% 变"仅关键词响应"）');
  // 两个方向都要接上：滑条动 → 输入框跟；输入框改 → 滑条跟
  assert.ok(/onInput:[\s\S]{0,600}syncProbBox\(\)/.test(appJs), '拖滑条时没有同步概率输入框');
  assert.ok(/function refreshAfterValueChange[\s\S]{0,400}syncProbBox\(\)/.test(appJs),
    'refreshAfterValueChange 里没有同步概率输入框');
  assert.ok(/\.ac-prob-row/.test(css), 'style.css 里缺少 .ac-prob-row 样式');
});

await c.check('概率输入框：移除原生微调箭头且不挤压右侧说明', () => {
  // 1) 悬停时 Chrome/Edge 会冒出的上下箭头，跟右边的 % 后缀抢位置。
  //    appearance:textfield 是标准去法，::-webkit-*-spin-button 是 Chrome/Edge 去法，
  //    Firefox 只认前一个；-moz-appearance 是老 Gecko 的等价写法。
  const cssClean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/appearance:\s*textfield/.test(cssClean),
    '没有 appearance:textfield —— 数字输入框的原生上下箭头没去掉（Firefox 不生效）');
  assert.ok(/::-webkit-(outer|inner)-spin-button[\s\S]{0,120}-webkit-appearance:\s*none/.test(cssClean),
    '没有禁用 ::-webkit-*-spin-button —— Chrome/Edge 悬停时仍会冒出原生箭头');

  // 2) 宽度层叠：.inp-wrap .inp { width:auto }（第 1800 行附近）与本块的选择器
  //    **同为一个 class 层级时后者胜出**，输入框会按固有宽度涨到 ~150px、撑破
  //    92px 的 .inp-wrap 并压进 hint 的地盘，flex-wrap 再把说明挤到输入框底部。
  //    这里算出真正命中的最高优先级规则，防止有人改回单 class 写法。
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssClean)) !== null) {
    const sel = m[1].trim();
    if (!/\.inp-wrap\s+\.inp\b/.test(sel)) continue;   // 只看会命中本 input 的规则
    const w = (m[2].match(/(^|;)\s*width\s*:\s*([^;]+)/) || [])[2];
    if (!w) continue;
    const ids = (sel.match(/#[\w-]+/g) || []).length;
    const cls = (sel.match(/\.[\w-]+/g) || []).length + ((sel.match(/\[[^\]]+\]/) || []).length);
    rules.push({ sel, width: w.trim(), spec: ids * 100 + cls * 10 });
  }
  const win = rules.reduce((a, b) => (b.spec >= a.spec ? b : a));
  assert.strictEqual(win.width, '100%',
    `命中概率输入框的最高优先级规则是「${win.sel}」width:${win.width} —— `
    + '应让输入框填满 .inp-wrap 的 92px；width:auto 会撑破容器并压住右侧说明');
  // 说明文字与输入框要有明确间距：gap 或 margin 至少给到 8px。
  const gap = (cssClean.match(/\.ac-prob-row\s*\{[^}]*gap:\s*(\d+)px/) || [])[1];
  const hintML = (cssClean.match(/\.ac-prob-hint\s*\{[^}]*margin:[^;]*?(\d+)px/) || [])[1];
  assert.ok(Number(gap) >= 8 || Number(hintML) >= 4,
    `概率输入框与右侧说明间距过小（gap:${gap || '无'}px, hint margin-left:${hintML || '0'}px）`);
});

await c.check('添加模态框有独立的口令入口（不再强开市场网页）', () => {
  assert.ok(/id="addmod-code"/.test(appJs), '缺少「通过口令添加」入口按钮');
  // 口令入口必须是**只开口令框、不开网页**；去市场入口才开网页。
  // 按「事件绑定处」定位，而不是模板里 id 首次出现的位置（模板在前，
  // 那个位置之后的第一个 handler 不是口令按钮的 handler）。
  const codeHandler = appJs.slice(appJs.indexOf("#addmod-code')"));
  assert.ok(codeHandler.includes('openInstallCodeModal()'),
    '口令入口没有调用 openInstallCodeModal');
  assert.ok(!codeHandler.slice(0, codeHandler.indexOf("#addmod-market')"))
    .includes('window.open'),
    '口令入口不该打开市场网页（那是「去市场」入口的职责）');
});

await c.check('切换页签会加载对应页（switchTab 里两个分支都在）', () => {
  // 只加按钮不加分支 = 点进去是空白页（容器存在但没有渲染逻辑）
  assert.ok(/name === 'skills'\)\s*loadModulePage\('skill'\)/.test(appJs),
    "switchTab 里没有 skills 分支");
  assert.ok(/name === 'plugins'\)\s*loadModulePage\('plugin'\)/.test(appJs),
    "switchTab 里没有 plugins 分支");
});

await c.check('技能页与插件页按 kind 隔离（不会把插件渲染进技能页）', () => {
  // 两页共用 renderModulePage，靠 kind 过滤。过滤条件一旦写错，
  // 两页会显示一样的内容 —— 静态上先盯住"过滤用的是 kind、不是 source"。
  const m = /function renderModulePage\(kind\)[\s\S]*?\n  const items = (.+?);/.exec(appJs);
  assert.ok(m, '找不到 renderModulePage 里的条目过滤');
  assert.ok(/s\.kind === meta\.kind/.test(m[1]),
    `条目过滤没有按 kind 判型：${m[1]}`);
});

await c.check('landing.html 的下载链接带版本号（官网同目录部署，相对路径即可）', () => {
  // 2026-09-07 起下载链接刻意改为"带版本号的相对路径"（commit e359c29）：
  // 安装包与落地页同目录部署在官网，相对路径在部署环境有效；
  // "必须绝对地址"的旧断言是按本地服务口径写的，与部署事实相反。
  const m = /href="([^"]*qq-agent-v[\d.]+-setup\.exe)"/.exec(landing);
  assert.ok(m, '找不到安装包下载链接');
  assert.ok(/^[\w.-]+\.exe$/.test(m[1]), `应为同目录相对文件名（带版本号），实际：${m[1]}`);
});

// ── 3. vendor 镜像一致性 ─────────────────────────────────────────────────
c.section('3. vendor 镜像一致性');

await c.check('ui/vendor/tier-slider.js 与 src/tier-slider.js 的逻辑一致（去掉注释后逐字相同）', () => {
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  const a = strip(read('src/tier-slider.js'));
  const b = strip(read('ui/vendor/tier-slider.js'));
  assert.equal(a, b, '两份 tier-slider 已经漂移：前端实际用的是 ui/vendor 那份，后端用 src/ 那份');
});

await c.check('ui/vendor/price-match.js 与 src/model-prices.js 的 matchPriceTable 对同一输入结果一致', async () => {
  const { matchPriceTable: backend } = await import('../src/model-prices.js');
  const { matchPriceTable: frontend } = await import('../ui/vendor/price-match.js');
  const { listOfficialPrices } = await import('../src/model-prices.js');
  const table = listOfficialPrices();
  for (const id of table.slice(0, 12).map((x) => x.id)) {
    const a = backend(id, table);
    const b = frontend(id, table);
    assert.ok(Boolean(a) === Boolean(b), `模型 ${id} 命中结果不一致：后端=${Boolean(a)} 前端=${Boolean(b)}`);
  }
});

// ── 4. DOM id 交叉检查 ───────────────────────────────────────────────────
c.section('4. DOM id 交叉检查');

await c.check('app.js 里 $(\'#id\') / getElementById 引用的 id 都能被创建', () => {
  const declared = new Set();
  // index.html 里静态声明的
  for (const m of html.matchAll(/\bid="([\w-]+)"/g)) declared.add(m[1]);
  // app.js 模板字符串里创建的字面量 id
  for (const m of appJs.matchAll(/\bid="([\w-]+)"/g)) declared.add(m[1]);
  // app.js 里用 JS 赋值的 id（如 vhs.id = 'chaos-vhs'）
  for (const m of appJs.matchAll(/\.id\s*=\s*'([\w-]+)'/g)) declared.add(m[1]);
  // 动态拼接的 id（id="${...}"）无法静态判断，忽略
  // 运行时动态拼接的选择器（'#' + fieldId）：按已知动态名单豁免
  const DYNAMIC_IDS = new Set([
    // switchHtml(id, …) 生成 id="${id}" 的开关；静态扫描看不到模板内部，按字面量调用豁免
    'cfg-useofficialprice', 'cfg-tools-enabled', 'cfg-imagesend',
    'cfg-persona-unified', 'cfg-autostart', 'cfg-closetray', 'cfg-showvision',
    'cfg-proactive', 'cfg-sticker', 'cfg-websearch', 'cfg-allowallwhenempty',
    'cfg-mem-consolidate', 'cfg-mem-usechat'
  ]);
  const refs = new Set();
  for (const m of appJs.matchAll(/\$\('#([\w-]+)'\)/g)) refs.add(m[1]);
  for (const m of appJs.matchAll(/getElementById\('([\w-]+)'\)/g)) refs.add(m[1]);
  const missing = [...refs].filter((id) => !declared.has(id) && !DYNAMIC_IDS.has(id));
  assert.equal(missing.length, 0, `这些 id 被引用但从未创建：${missing.join(', ')}`);
});

// ── 5. 可访问性 ──────────────────────────────────────────────────────────
c.section('5. 可访问性');

await c.check('弹窗外壳带 role="dialog" / aria-modal，且集成 Esc 关闭与焦点管理', () => {
  const m = /function modelModalShell\([\s\S]*?\n\}/.exec(appJs);
  assert.ok(m, '找不到 modelModalShell');
  const body = m[0];
  assert.ok(/role="dialog"/.test(body), '弹窗缺少 role="dialog"');
  assert.ok(/aria-modal="true"/.test(body), '弹窗缺少 aria-modal');
  assert.ok(/aria-label="关闭"/.test(body), '关闭按钮缺少 aria-label');
  assert.ok(/Escape/.test(body), '弹窗未处理 Esc 关闭');
  assert.ok(/focus\(/.test(body), '弹窗未做焦点管理');
});

await c.check('所有「×」图标按钮都有 aria-label', () => {
  const missing = [];
  for (const m of appJs.matchAll(/<button[^>]*>[×✕✖]<\/button>/g)) {
    if (!/aria-label=/.test(m[0])) missing.push(m[0]);
  }
  for (const m of html.matchAll(/<button[^>]*>[×✕✖]<\/button>/g)) {
    if (!/aria-label=/.test(m[0])) missing.push(m[0]);
  }
  assert.equal(missing.length, 0, `缺少 aria-label 的关闭按钮：\n  ${missing.join('\n  ')}`);
});

await c.check('index.html 里的纯图标按钮都有 aria-label 或可见文字', () => {
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const text = m[2].replace(/<[^>]*>/g, '').trim();
    if (text) continue;                      // 有可见文字
    assert.ok(/aria-label=/.test(attrs), `图标按钮缺少 aria-label：<button${attrs}>`);
  }
});

await c.check('主题切换按钮有 aria-label（键盘/读屏可用）', () => {
  assert.ok(/id="theme-btn"[^>]*aria-label=/.test(html), '#theme-btn 缺少 aria-label');
});

// ── 6. 会话延续徽标（②P1/P2 的排障展示）────────────────────────────────
c.section('6. 会话延续徽标');
await c.check('会话详情渲染两种延续徽标（续用 / 新开）', () => {
  assert.ok(appJs.includes('cont-badge'), '应有 cont-badge 徽标类');
  assert.ok(/mode === 'continuation'/.test(appJs), '应区分 continuation 模式');
  assert.ok(/mode === 'fresh'/.test(appJs), '应区分 fresh 模式');
  assert.ok(appJs.includes('cont.reason'), 'fresh 徽标应带上 reason（为什么没续上）');
});
await c.check('延续徽标样式与类名一致（.cont-badge + .cont-cont/.cont-fresh）', () => {
  assert.ok(css.includes('.cont-badge'), 'CSS 缺少 .cont-badge');
  assert.ok(css.includes('.cont-cont'), 'CSS 缺少 .cont-cont（续用态）');
  assert.ok(css.includes('.cont-fresh'), 'CSS 缺少 .cont-fresh（新开态）');
});

// ── 7. 单次会话缓存命中率展示 ────────────────────────────────────────────
// 用量页只给全时段汇总，会话页要能单独看"这一次"的命中率。口径必须与
// 后端 llm.js 的 cacheHitRate 一致（cachedTokens / promptTokens），否则前后对不上。
c.section('7. 会话缓存命中率展示');
await c.check('前端有单次命中率计算函数，且口径与后端一致', () => {
  assert.ok(appJs.includes('function usageCacheHitRate'), '应导出 usageCacheHitRate 计算函数');
  assert.ok(/cachedTokens[\s\S]{0,80}promptTokens/.test(appJs)
    || /promptTokens[\s\S]{0,80}cachedTokens/.test(appJs),
    'usageCacheHitRate 应基于 cachedTokens / promptTokens 计算');
});
await c.check('会话卡片与会话详情都展示命中率', () => {
  assert.ok(appJs.includes('sess-hit'), '会话卡片缺少命中率徽标（sess-hit）');
  assert.ok(appJs.includes('sess-hit-line'), '会话详情缺少命中率行（sess-hit-line）');
  assert.ok(css.includes('.sess-hit'), 'CSS 缺少 .sess-hit 样式');
});
await c.check('空会话不显示命中率（避免误导性的 0%）', () => {
  // 只有 promptTokens > 0（确实调用过模型）才渲染命中率
  assert.ok(/promptTokens\)\s*\|\|\s*0\)\s*>\s*0/.test(appJs),
    '命中率应仅在 promptTokens > 0 时展示');
});

// ── 8. 记忆页「查看思维链」模块 ───────────────────────────────────────────
// 思维链 = 活跃缓冲里的 messages（跨轮保留的"自己想过什么"）。UI 必须：
//   ① 有入口（折叠块 + 惰性加载，不在打开记忆页时就拉大 JSON）
//   ② 打到 /thoughts 接口
//   ③ 渲染函数把三类消息（user/assistant/tool）都覆盖
c.section('8. 记忆页查看思维链模块');
await c.check('记忆页有「查看思维链」入口，且惰性加载', () => {
  assert.ok(appJs.includes('mem-thoughts-fold'), '缺少思维链折叠块入口');
  assert.ok(appJs.includes("'toggle'"), '思维链模块应惰性加载（toggle 时才请求）');
  assert.ok(appJs.includes('/thoughts'), '思维链模块应请求 /thoughts 接口');
});
await c.check('思维链渲染函数覆盖三类消息', () => {
  assert.ok(appJs.includes('function renderThoughts'), '缺少 renderThoughts 渲染函数');
  // 三类角色标签靠动态类名 mem-thought-${kind} 区分（user / assistant / tool）
  assert.ok(/mem-thought-\$\{kind\}/.test(appJs), '思维链卡片应带动态类型类名 mem-thought-${kind}');
  assert.ok(appJs.includes('think-call'), '应渲染工具调用卡片（think-call）');
  assert.ok(appJs.includes('tool_calls'), '应处理 assistant 的 tool_calls');
  assert.ok(css.includes('.mem-thought'), 'CSS 缺少 .mem-thought 样式');
});
await c.check('思维链角色查表的 key 与 kindOf 返回值对齐（防 undefined）', () => {
  // 曾经的 bug：kindOf 返回 think/tool-result/user，但查表写的是 assistant/tool，
  // 结果 assistant 条目渲染成 "undefined #2"。这里静态校验两者的 key 集合一致。
  const kinds = [...appJs.matchAll(/return '(think|tool-result|user)';/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 3, `kindOf 应返回三种 kind，实际：${kinds.join(',')}`);
  for (const table of ['roleLabel', 'roleIcon']) {
    const m = new RegExp(`const ${table} = \\{([^}]*)\\}`).exec(appJs);
    assert.ok(m, `找不到 ${table} 定义`);
    for (const k of kinds) {
      assert.ok(new RegExp(`['"]?${k}['"]?\\s*:`).test(m[1]),
        `${table} 缺少 key「${k}」—— 与 kindOf 返回值不一致，会渲染成 undefined`);
    }
  }
});

// ── 9. 技能页缓存影响徽标 ─────────────────────────────────────────────────
// 会话延续改造后，外部 Skill 的动态 promptSections / 改写 system 的
// before-llm-messages 会打断延续或击穿缓存。技能页要给出可见提示。
c.section('9. 技能页缓存影响徽标');
await c.check('技能页拉取体检结果并存入 state', () => {
  assert.ok(appJs.includes('/api/skills/cache-impact'), '应请求 /api/skills/cache-impact');
  assert.ok(appJs.includes('state.skillCacheImpact'), '体检结果应存入 state.skillCacheImpact');
});
await c.check('卡片渲染缓存影响徽标，且只在非 ok 时出现', () => {
  assert.ok(appJs.includes('skill-cache-badge'), '应有缓存影响徽标（skill-cache-badge）');
  assert.ok(/ci\.level\s*!==\s*'ok'/.test(appJs), '徽标应仅在 level !== ok 时渲染');
  // 档位类名是动态拼的：skill-cache-${ci.level}（danger / warn）
  assert.ok(/skill-cache-\$\{esc\(ci\.level\)\}/.test(appJs), '应有动态档位类名 skill-cache-${ci.level}');
  assert.ok(/'danger'/.test(appJs) && /'warn'/.test(appJs), '应区分 danger / warn 文案');
});
await c.check('徽标样式齐备且用主题变量上色', () => {
  assert.ok(css.includes('.skill-cache-badge'), 'CSS 缺少 .skill-cache-badge');
  assert.ok(css.includes('.skill-cache-danger'), 'CSS 缺少 .skill-cache-danger');
  assert.ok(css.includes('.skill-cache-warn'), 'CSS 缺少 .skill-cache-warn');
  assert.ok(/\.skill-cache-danger[\s\S]{0,120}var\(--err/.test(css), 'danger 应用 --err 上色');
  assert.ok(/\.skill-cache-warn[\s\S]{0,120}var\(--warn/.test(css), 'warn 应用 --warn 上色');
});

c.finish();
