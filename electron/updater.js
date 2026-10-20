// ── 安装版自动更新（electron-updater + GitHub Releases）─────────────────
//
// 分发的两条产线更新方式不同，这里只管**安装版**那条：
//   · 压缩包（pack-release.mjs）：解压覆盖，走 /api/update-check 的"下载 zip"提示；
//   · 安装包（electron-builder NSIS）：本模块，应用内检查 → 后台下载 → 重启安装。
// 两者互不干扰：dev 模式（npm start）和压缩包版都没有 app-update.yml，
// 本模块在 app.isPackaged 为假时直接返回，一行更新逻辑都不执行。
//
// ── 为什么更新源仍是 GitHub Release ──────────────────────────────────────
// package.json 的 build.publish 声明了 provider: github + owner/repo，
// electron-builder 打包时把它写进 resources/app-update.yml；electron-updater 读那份
// 配置去查 latest release，再按 latest.yml 里的 sha512 下载 QQ-Agent-x.y.z-Setup.exe。
// 也就是说**发版流程不变**：还是 gh release create，只是产物多了 exe / latest.yml / blockmap。
//
// ── 静默策略：不打扰 ────────────────────────────────────────────────────
// 机器人是常驻后台的，弹一个"发现新版本"的模态框会打断用户。所以：
//   启动后延迟查一次 → 有新版就**后台下载** → 下完才提示（托盘气泡 + 设置页状态）。
// 用户点"立即重启"才 quitAndInstall；不点也没关系，下次正常退出时自动装
// （autoInstallOnAppQuit）。
//
// ⚠️ 不要在 src/ 里 import 本模块：src/ 同时被 headless（src/server.js）和测试引用，
//    加载 electron-updater 会 require('electron') 失败。壳与核的切面仍然只有
//    electron/main.js 一处。

import { app, Notification } from 'electron';
import { createRequire } from 'node:module';

/** 检查间隔：常驻程序 6 小时一次足够（GitHub API 匿名限流 60 次/小时/IP）。 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动后延迟：先让核心服务、窗口、托盘都就绪，别和首屏抢 IO。 */
const FIRST_CHECK_DELAY_MS = 60 * 1000;

/** 最近一次检查的状态（设置页 / 托盘读它）。 */
const state = {
  enabled: false,          // 本进程是否真的启用了自动更新
  status: 'unsupported',   // unsupported | idle | checking | available | downloading | downloaded | error
  current: '',
  latest: '',
  percent: 0,
  error: '',
  checkedAt: 0
};

/**
 * 创建自动更新控制器。
 *
 * @param {object} opts
 * @param {() => void} opts.onQuitRequested  "立即重启"：由 main.js 走它自己的退出
 *        清理链（core.stop()），清理完再调 install()。
 * @param {(s: object) => void} opts.onChange 状态变化回调（推给 UI / 托盘）。
 */
export function createUpdater({ onQuitRequested, onChange } = {}) {
  state.current = app.getVersion();
  state.status = 'idle';

  // dev / 压缩包版：没有 app-update.yml，硬启会抛 ENOENT。直接标记为不支持。
  if (!app.isPackaged) {
    state.enabled = false;
    state.status = 'unsupported';
    return controller();
  }

  let autoUpdater;
  try {
    // electron-updater 是 CJS 包，require 时就会 new NsisUpdater()（内部读 electron.app），
    // 所以必须放在 app ready 之后、且用 try 包住 —— 配置缺失不能把主进程带崩。
    const require = createRequire(import.meta.url);
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    state.enabled = false;
    state.status = 'error';
    state.error = `自动更新组件加载失败：${error?.message ?? error}`;
    return controller();
  }

  state.enabled = true;
  state.status = 'idle';

  // 日志接到主进程控制台（会进 data/logs 与 boot-diag 的同一条输出流）
  autoUpdater.logger = {
    info: (m) => console.log('[updater]', m),
    warn: (m) => console.warn('[updater]', m),
    error: (m) => console.error('[updater]', m),
    debug: () => {}
  };
  // 有新版自动下载（不自动装 —— 装是用户点"立即重启"或正常退出时的事）
  autoUpdater.autoDownload = true;
  // 退出时自动装（库默认也是 true，显式写出来：行为要能从代码读出来）
  autoUpdater.autoInstallOnAppQuit = true;
  // 差分下载：NSIS 配了 blockmap 才有意义；失败会自动回落全量，不用手动关
  autoUpdater.disableDifferentialDownload = false;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => {
    set({ status: 'available', latest: String(info?.version || ''), percent: 0 });
  });
  autoUpdater.on('update-not-available', (info) => {
    set({ status: 'idle', latest: String(info?.version || state.current), percent: 0, error: '' });
  });
  autoUpdater.on('download-progress', (p) => {
    set({ status: 'downloading', percent: Math.round(Number(p?.percent) || 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'downloaded', latest: String(info?.version || state.latest), percent: 100 });
    notifyDownloaded();
  });
  autoUpdater.on('error', (error) => {
    // 网络不通 / GitHub 限流 / 签名不符都走这里。不弹框：常驻程序半夜报错没意义，
    // 状态留给设置页，下次检查还会重试。
    set({ status: 'error', error: String(error?.message ?? error) });
  });

  // 启动后延迟查一次，之后每 6 小时一次
  const firstTimer = setTimeout(() => { check(); }, FIRST_CHECK_DELAY_MS);
  firstTimer.unref?.();
  const timer = setInterval(() => { check(); }, CHECK_INTERVAL_MS);
  timer.unref?.();

  return controller();

  // ── 内部 ──
  function controller() {
    return {
      get state() { return { ...state }; },
      get enabled() { return state.enabled; },
      check,
      /** 安装并重启。调用方必须先跑完自己的退出清理（core.stop()）。 */
      install,
      /** 用户点了"立即重启"：交给 main.js 的退出链，清理完再 install。 */
      quitAndInstall: () => { onQuitRequested ? onQuitRequested() : install(); }
    };
  }

  function set(patch) {
    Object.assign(state, patch, { checkedAt: Date.now() });
    try { onChange?.({ ...state }); } catch { /* 通知失败不影响更新流程 */ }
  }

  /**
   * 检查更新。
   *
   * 并发保护：定时检查（每 6 小时）和设置页「立即检查」可能撞在一起。
   * electron-updater 不拒绝重复的 checkForUpdates，重复调用会起两条下载流写同一个
   * 缓存文件 —— 轻则白耗流量，重则 sha512 校验失败。这里用 inFlight 直接复用进行中的那一次。
   */
  let inFlight = null;
  function check() {
    if (!autoUpdater) return Promise.resolve({ ...state });
    // 已下载完就不再查（等用户重启，免得反复下载）
    if (state.status === 'downloaded') return Promise.resolve({ ...state });
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        set({ status: 'checking', error: '' });
        await autoUpdater.checkForUpdates();
      } catch (error) {
        set({ status: 'error', error: String(error?.message ?? error) });
      } finally {
        inFlight = null;
      }
      return { ...state };
    })();
    return inFlight;
  }

  function install() {
    if (!autoUpdater || state.status !== 'downloaded') return false;
    try {
      // (isSilent=false, isForceRunAfter=true)：装完自动拉起新版
      autoUpdater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      set({ status: 'error', error: String(error?.message ?? error) });
      return false;
    }
  }

  /** 下载完成后提示一次：托盘气泡，不打断。 */
  function notifyDownloaded() {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: 'QQ Agent 更新已就绪',
        body: `v${state.latest} 已下载完成，下次退出应用时自动安装；也可以在「设置 → 桌面端」里立即重启更新。`,
        silent: true
      });
      n.on('click', () => { onQuitRequested ? onQuitRequested() : install(); });
      n.show();
    } catch { /* 通知不可用（系统策略/未授权）不算失败 */ }
  }
}
