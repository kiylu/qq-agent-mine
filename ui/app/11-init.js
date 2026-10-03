// 〔页签切换 / 启动〕——M9 拆分第 12 段（末段）
'use strict';
// ── 标签页切换 ──
// ⚠️ 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
//    结果漏了 usage 分支 —— 点「用量」页签只切了视图、从不加载内容，
//    页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
//    两条路径各维护一份必然再次分叉，所以这里只准调 switchTab。
//
// 「记录」「扩展」是特例：它们是**一级触发器 + 二级选择器**（见 initSubmenu），
// 点它们先展开下拉菜单，由二级项再决定切到哪一页。
$$('.tab').forEach((tab) => {
  if (tab.classList.contains('has-sub')) return;   // 绑定在 initSubmenu 里
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── 二级选择器（通用：一级触发器 + 下拉菜单）──
// 设计：一级导航只占一个位。顶栏每多一个平级页签就挤一分，原本 8 项（技能/插件
// 各占一个、存档/记忆各占一个）已经转不开身；合并成「扩展」「记录」两个入口后是 6 项。
// 点击 → 展开选项 → 选完切到对应页并收起。再次点击或点页面其它地方收起。
// 内容仍是各自独立视图 —— 判定方式不同，混一起看不出类型。
//
// 不用「包装 window.switchTab」实现切页联动：这些段是普通脚本（拼接后 eval 执行），
// 顶层 function 声明与 window 属性是否同步并无保证，包装可能不生效。
// 改成让 switchTab 自己在末尾派发事件 —— 见 00-core.js · switchTab 末尾。
//
// @param tabId   一级触发器元素 id（如 'ext-tab'）
// @param menuId  下拉菜单容器 id（如 'ext-submenu'）
// @param pages   该菜单管辖的页签名数组（如 ['skills','plugins']）

/** 已初始化的二级菜单组（「记录」「扩展」）。展开一组时用它关掉另一组。 */
const submenus = [];

function initSubmenu(tabId, menuId, pages) {
  const tab = $('#' + tabId);
  const menu = $('#' + menuId);
  if (!tab || !menu) return;
  const items = () => $$('.ext-subitem', menu);

  // 贴到页签正下方。菜单是 absolute（挂在 body 上），坐标按页签实测位置算 ——
  // 这样顶栏横向滚动时菜单也跟着走，不会错位。
  const position = () => {
    const r = tab.getBoundingClientRect();
    // 顶栏高 44px；留 6px 间隙让它像"掉下来"而不是贴在边框上
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(r.left)}px`;
  };
  const setOpen = (open) => {
    menu.hidden = !open;
    tab.classList.toggle('ext-open', open);
    tab.setAttribute('aria-expanded', String(open));
    // 展开时立刻关掉另一组菜单：两组同时展开会互相盖住
    if (open) {
      for (const other of submenus) if (other !== api) other.close();
      position();
      refreshStatus?.();
    }
  };
  const close = () => setOpen(false);
  const isOpen = () => !menu.hidden;
  const api = { tab, menu, pages, close, isOpen };
  submenus.push(api);

  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    isOpen() ? close() : setOpen(true);
  });
  // 二级项：切到对应页 + 收起菜单
  items().forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
      switchTab(btn.dataset.subTab);
    });
  });
  // 点菜单外部收起
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (menu.contains(e.target) || tab.contains(e.target)) return;
    close();
  });
  // Esc 收起
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { close(); tab.focus(); }
  });
  // 窗口尺寸变化 / 顶栏横向滚动后重新对位
  window.addEventListener('resize', () => { if (isOpen()) position(); });
  $('#tabs')?.addEventListener('scroll', () => { if (isOpen()) position(); }, { passive: true });
  // 切到别的页签时自动收起（否则菜单悬在别的页面上方）
  document.addEventListener('qqagent:tabswitched', (e) => {
    if (!pages.includes(e.detail)) close();
  });
  return api;
}

initSubmenu('archive-tab', 'archive-submenu', ['chats', 'memory']);   // 记录
initSubmenu('ext-tab', 'ext-submenu', ['skills', 'plugins']);       // 扩展

/**
 * 供 switchTab 用：把「记录」「扩展」高亮为当前页。
 * 它们是各自辖下两页的**共同父级** —— 在任一子页都要保持高亮，
 * 否则从「技能」切到「插件」时顶栏会一个高亮都没有，看着像丢了位置。
 */
function syncParentTabsActive(name) {
  for (const s of submenus) {
    s.tab?.classList.toggle('active', s.pages.includes(name));
  }
}

// ── 启动 ──
(async function init() {
  try {
    // 主题：明/暗两档（跟随系统/？已移除）
    applyTheme(getThemePref());
    $('#theme-btn')?.addEventListener('click', cycleTheme);

    // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
    setLoadingStatus('正在启动 QQ Agent 服务…');
    await bootLoop();
    runUpdateCheck();                                 // 启动时静默查一次（失败不打扰）
    setInterval(() => runUpdateCheck(), 3600_000);    // 之后每小时查一次

    // 主题：以后端配置为准（跨设备同步），仅当后端确实存过才覆盖本地
    try {
      const cfg0 = await api('/api/config');
      const t = cfg0?.ui?.theme;
      if (THEME_VALUES.includes(t)) applyTheme(t);
    } catch { /* 接口不可用就用本地的 */ }

    // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
    try {
      const cfg = await api('/api/config');
      const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
      if (!ready) {
        switchTab('settings');
        connectSSE();
        refreshStatus();
        startStatusPoller();
        return;
      }
    } catch { /* 按默认流程走 */ }
    refreshStatus();
    startStatusPoller();
    connectSSE();
    loadSessions();
    loadMemoryView();
    initSessionScrollLoader();
  } catch (err) {
    // 启动链路任何一步抛错都必须摘掉加载遮罩 —— 否则整窗被
    // z-index:999 的 loading-overlay 盖住，用户只看到一片空白。
    console.error('[init] 启动失败:', err);
    try { setLoadingStatus(`启动异常：${err?.message || err}`); } catch { /* ignore */ }
  } finally {
    try { hideLoading(); } catch { /* ignore */ }
  }
})();