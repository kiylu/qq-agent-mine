# Electron 安装包分发与自动更新方案（2026-10-19）

日期：2026-10-19 ｜ 当前版本：0.2.3 ｜ 状态：**待评审**

依据：对 `electron/`、`package.json` 的 `build` 字段、`scripts/pack-release.mjs`、`scripts/release.mjs`、
`build/installer.nsh`、`src/app.js` 的实测分析。

---

## 〇、先说结论

**不麻烦。这个项目已经有 70% 的 Electron 工作做完了。**

它不是"要不要改成 Electron"的问题，而是"**Electron 外壳早已跑通，只是从来没用它发过安装包**"——

- `electron/main.js` 是完整的桌面壳：托盘常驻、单实例锁、关窗到托盘、开机自启、
  退出前 `core.stop()` 清理链、`uncaughtException` 兜底弹窗，注释里还留着
  2026-09-23「双击打不开」的完整排查与修复过程。
- `package.json` 的 `build` 字段是完整的 electron-builder 配置：appId、NSIS 目标、图标、
  `asar: false`（平铺分发）。
- `build/installer.nsh` 是 10KB 的**覆盖升级数据保护**——安装前先把旧版 `data/` 和
  SnowLuma 登录态 robocopy 到 `%LOCALAPPDATA%`，装完再还原。这段的严谨程度
  （文件占用处理、备份成败靠"目标真有东西"判定、失败弹窗告警）超过不少商业软件。
- 工具链已装且**离线缓存齐备**：electron-builder 26.15.3、Electron 33.4.11，
  `~/AppData/Local/electron-builder/Cache` 里 nsis / 7zip / winCodeSign 都在
  （说明这台机器历史上成功构建过）。
- 运行时依赖闭包极小：生产依赖只有 `js-yaml` / `undici` / `ws` 三个，
  collector 实测闭包 **4 个包 2.9 MB**。

**所以真正的改动量不在"打包"，而在三处被 zip 分发时代设定拖住的地方**（见第二节）。

**还有一个额外好消息**（2026-10-19 实测，见第三节附）：

安装版**不需要内置 Node 运行时**就能让用户在 UI 上点「一键安装」跑 `setup.mjs`——
electron.exe 自带 `ELECTRON_RUN_AS_NODE=1` 模式，本身就是一个完整的 Node v20 运行时，
`setup.mjs` 实测直接跑通。额外体积 **0 字节**。

---

## 一、现状：两套分发逻辑并存

| | 压缩包（现有） | 安装包（本文提案） |
|---|---|---|
| 产物 | `qq-agent-x.y.z-日期-full.zip`（~120 MB） | `QQ-Agent-x.y.z-Setup.exe` |
| 启动 | `启动QQ机器人.bat` → `node_modules/electron/dist/electron.exe` | 桌面/开始菜单快捷方式 → `QQ Agent.exe` |
| 运行前置 | 需要 `node + npm`（跑 `npm run setup`） | **不需要 Node 环境** |
| 更新 | 手动重新下载 + 覆盖解压 | 应用内一键 / 静默差分更新 |
| 数据位置 | 项目目录 `data/` | 安装目录 `data/`（同一约定） |
| 卸载 | 删目录 | NSIS 卸载器（保留 `data/`，见 `deleteAppDataOnUninstall: false`） |

**关键事实**：安装版与压缩包版共用同一份 `electron/main.js` 和 `src/`，
`resolveDataDir()` 已经按 `app.isPackaged` 分流——packaged 走 exe 旁边的 `data/`。
也就是说**数据口径两者天然一致**，不存在"两套数据目录"的分裂风险。

---

## 二、实测发现的三个问题

以下三条**都经过实测**（用 electron-builder 26.15.3 源码内的 `FileMatcher` /
`getNodeModuleFileMatcher` / `traversalNodeModulesCollector` API 对当前仓库跑过），不是推测。

### 问题 ①：`build.files` 把安装版的必需文件排掉了

`package.json` 的 `build.files` 现在是：

```json
"files": ["**/*", "!data/**", ..., "!scripts/**", ...]
```

electron-builder 的 `FileMatcher` 会自动在这个清单**后面追加** `!**/node_modules/**`
（源码：`app-builder-lib/out/fileMatcher.js:133-138`——见 `files` 里没有正向
node_modules pattern 时，`customFirstPatterns.push("!**/node_modules/**")`）。

但 **node_modules 由独立通道打包**（`platformPackager.js:367` → `computeNodeModuleFileSets`），
该通道只读 `files` 里的 `!` 排除项（`fileMatcher.js:176-217`），
所以**运行时依赖不会漏**——实测 collector 收到 `argparse / js-yaml / undici / ws` 4 个包。
Electron 本体走框架通道单独注入，与它在 `devDependencies` 里无关。

真正的漏项是：

| 被排除 | 影响 |
|---|---|
| `scripts/`（含 `setup.mjs` 18KB、`setup-napcat.mjs`） | 安装版用户**没有 Node/npm**，完全没法装 SnowLuma 与便携 QQ |
| `test/` `doc/` | 打包测试与文档，本就不该进安装包（正确） |

`scripts/` 被排除是 zip 时代的设定——README 让用户自己 `npm run setup`。
**改成安装包后这条判断失效**：不是"要不要放开"，是"必须放开"。

### 问题 ②：SnowLuma 与便携 QQ 在安装版里没有着落

这是**最大的设计缺口**，且没有纯技术解：

- **SnowLuma**：`snowlumaDir()` 的兜底路径是 `ROOT/snowluma`，打包后即
  `<安装目录>/resources/app/snowluma`。路径本身可行，
  但 `build.files` 没有排除它、`.gitignore` 却排除了 `snowluma/`——
  仓库里根本没有这个目录，要么安装时下载，要么用户自备。
  且 SnowLuma 是**带 EULA 的独立第三方项目**（[.gitignore](../../.gitignore) 与 README 都明说
  "不随代码分发"），安装包重分发它有许可争议。
- **便携 QQ**：1.6 GB（`scripts/setup.mjs` 明说"README 明确不随代码分发"），
  且是腾讯自研 HummerSetup 安装器、**不接受静默安装参数**。

**结论：安装版不可能做到"装完就能聊"。** 协议端必须由用户首次启动时自行获取。
这不是 bug，是产品形态差异——**也是本方案必须让你做决策的原因**（见第六节）。

### 问题 ③：三处硬编码的 `npm run setup` 会误导安装版用户

| 位置 | 文案 |
|---|---|
| `src/app.js:405` | `便携 QQ 未安装：请先运行 npm run setup` |
| `ui/app/03-snowluma.js:116/122/135` | 三处 `请先运行 npm run setup` |

我 grep 过全项目：**`npm` 没有被 `src/` 代码 spawn 过**，所以不会功能性崩溃，
只是安装版用户照做时发现根本没有 npm。属于文案正确性问题。

### 附带确认（无需改动）

- `src/config.js` 的 `ROOT = src/ 的上级`，`asar: false` 下平铺在
  `resources/app/`，`UI_DIR` / `APP_ROOT`（plugin-loader、markdown-skills）全部正确解析。
- `community_app.py`（`server/`）被 `build.files` 排除，但它只是自托管社区后端的参考实现，
  不被 `src/` 引用（仅注释提及），排除正确。

---

## 三、实施方案：分两步

### 第一步：只改分发形态（低风险，1–2 小时，可随时回退）

**目标**：产出可用的安装包，业务流程**完全不变**（协议端仍按 README 手动准备）。
这一步不碰自动更新、不做首启向导，回退只需改回 `build.files`。

**改动点**

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `package.json` `build.files` | 把 `!scripts/**` 改为 `!scripts/**/*.map`（保留 `setup.mjs` 等脚本本体）；同时确认 `!test/**` `!doc/**` 保持排除 |
| 2 | `package.json` `build.win` | 补 `artifactName` 已有；增加 `publisherName: "Kondius"`，避免匿名发布者 |
| 3 | `scripts/release.mjs` | 产物收集改为同时匹配 `*.zip` 与 `*.exe` 与 `latest.yml`，让 `gh release create` 一次挂全 |
| 4 | `README.md` | 「安装与使用」拆成两栏：压缩包版 / 安装版，安装版去掉所有 `npm` 命令 |
| 5 | 三处 `npm run setup` 文案 | zip 版保留原文案；安装版改为按钮/引导（见下） |

**第 5 点的具体做法**：

```js
// src/app.js:405
const hint = process.env.QQ_AGENT_PACKAGED
  ? '便携 QQ 未安装：请在「SnowLuma」页点「一键安装」'
  : '便携 QQ 未安装：请先运行 npm run setup';
```

由 `electron/main.js` 在 `import('../src/app.js')` **之前**设一次
`process.env.QQ_AGENT_PACKAGED = app.isPackaged ? '1' : ''`。

> 为什么不直接用 `app.isPackaged`：`src/` 被 `src/server.js`（headless）和测试共用，
> 直接 `import('electron')` 会让 headless 崩。用环境变量做**壳与核的唯一切面**，
> 与现有 `QQ_AGENT_DATA_DIR` 完全同一约定。

> 第一步先只改文案（安装版此时还点不动，第二步才把按钮接上 spawn），
> 以免出现"按钮有了但点了没反应"。若希望第一步就完全可用，
> 可把第 5 项直接并用上面的 spawn 代码——它不依赖第二步其他改动。

**验收标准**

```bash
npm run dist              # 新增 script：electron-builder --win --publish never
```

1. 产出 `dist/QQ-Agent-0.2.4-Setup.exe`，可双击安装；
2. 安装后 `resources/app/` 下能看到 `scripts/setup.mjs` 与 `node_modules/{js-yaml,undici,ws}`；
3. 首次启动不弹启动失败框（`data/` 为空能起到控制台）；
4. 覆盖安装一次，确认 `data/` 与登录态保留（`installer.nsh` 已验证过逻辑，需实测）；
5. 卸载时确认 `data/` 未被删除。

**风险**：低。唯一改动的运行时行为是文案分支；打包配置改动不影响 zip 产线。

### 第二步：完整"傻瓜式"安装版（2–3 天，含新代码）

**目标**：安装版用户全程不需要 Node、不需要命令行、不需要手动解压。

**新增内容**（按依赖顺序）：

1. **UI 一键安装协议端**（新 UI，工作量主体）——**不需要内置 Node，见下一节专述**
   - SnowLuma 页检测 `snowluma/` 与 `runtime/qq-portable/` 是否就绪；
   - 未就绪 → 点「一键安装」→ 主进程 spawn `setup.mjs` → stdout 逐行转成进度条；
   - 需要处理 SnowLuma 的 EULA 同意书与下载源可用性（上游分发站失效时的替代路径，
     即 README 里写的手动指定目录）。
2. **`scripts/` 的模块化改造**（**可选优化**，不再是前置条件）
   - `setup.mjs` 现在是 45KB 的顶层 CLI，`import` 即执行 `main()`（无 `invokedDirectly` 守卫）；
   - 若只想 spawn（推荐起步），**不必改造**；
   - 只有当需要"在渲染进程里精细控制单个子步骤/取消单个下载"时，
     才按 `pack-release.mjs` 的模式（`invokedDirectly` 守卫 + 导出纯函数）抽出
     `installSnowluma()` / `installPortableQQ()`。
3. **`electron-updater` 接入**
   - `devDependencies` 加 `electron-updater`；
   - `electron/main.js` 里 `app.whenReady()` 后调 `autoUpdater.checkForUpdatesAndNotify()`，
     更新下载完通过 `update-downloaded` 事件弹窗询问是否重启；
   - 更新源指向 GitHub Releases（`provider: "github"`），或国内 CDN。
4. **更新链路打通**
   - `pack-release.mjs` 追加 electron-builder 产物收集（`dist/*.exe` + `latest.yml`）；
   - `release.mjs` 的 artifact 拼接加上它们；
   - **注意**：`src/app.js:61` 和 `scripts/release.mjs:21` 都写着"不用 electron-updater，
     因为是 zip 分发"——**一旦走 NSIS，这句注释的前提就没了，要同步改掉**，
     否则下一个人会照着注释把自动更新删了。
5. **代码签名**（可选但强烈建议）
   - 未签名 exe 首次启动必弹 SmartScreen「Windows 已保护你的电脑」；
   - 需要 EV/OEV 证书（年费）或至少 OV；也可先接受 SmartScreen，
     靠"仍要运行"人工过（冷启动用户会有流失）。
6. **CI 构建**（可选）
   - 现在打包要走 electron-builder，本地 3–5 分钟 + 需要 nsis/7z 离线缓存；
   - 可加 GitHub Actions 在 tag 推送时构建并上传 Release，本地只发 zip。
   - 注意 SnowLuma/Q 的**许可与体积**决定了它们仍不能进 artifact。

### 附：UI 一键 setup —— 不需要内置 Node（2026-10-19 实测补充）

**结论：不需要往安装包里塞 Node 运行时，额外体积 0 字节。**

electron-builder 打出的 `QQ Agent.exe` 与开发时用的 `electron.exe` 是同一个东西，
它自带 `ELECTRON_RUN_AS_NODE=1` 模式，此时就是一个**完整的 Node v20 运行时**
（Electron 33.4.11 → Node 20.18.3，满足 `engines: node >=20`）。

**实测记录**（在本仓库直接跑过，非推断）：

| 验证项 | 结果 |
|---|---|
| `ELECTRON_RUN_AS_NODE=1 electron.exe -e "process.version"` | ✅ `v20.18.3` |
| `ELECTRON_RUN_AS_NODE=1 electron.exe scripts/setup.mjs --check` | ✅ **直接跑通，输出与 npm 版一致** |
| 内置模块 `node:fs` / `node:zlib` / `node:crypto` / `node:os` | ✅ 全部可用 |
| `spawn('powershell', ...)`（`setup.mjs` 与 `src/app.js` 都要用） | ✅ 可用 |
| `fetch` | ✅ 有 |

> 关于 subprocess 那次报错：初次测试报 `Get-CimInstance : 无效查询`，
> 是因为本机当时没跑 `QQ.exe`。我用**普通 Node 跑了同一条命令做对照组，
> 报完全相同的错** → 确认是环境问题，不是 Electron 限制。

**为什么 `setup.mjs` 恰好能直接 spawn**（省掉了改造工作）：

- **完全非交互**：全文无 `readline` / `prompt` / `stdin` 读取 → spawn 后不需要给它造终端；
- **零第三方依赖**：只用 `node:` 内置模块 + `scripts/lib/{download,qq-installer}.mjs`
  两个本地文件 → 不需要 node_modules；
- **自带进度输出**：下载是流式 + 增量哈希，stdout 有可解析的进度文本。

**实现方式**（spawn，而非 import）：

```js
// electron/main.js 或 src/app.js
const child = spawn(process.execPath, ['scripts/setup.mjs', ...args], {
  cwd: ROOT,                       // resources/app
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true,
});
child.stdout.on('data', (d) => { /* 逐行推进度条 */ });
```

> ⚠️ **不能 `import()` 它**：实测 `import('./scripts/setup.mjs')` 会**直接触发 `main()`**
> （`setup.mjs:959` 是裸的 `main().catch(...)`，没有 `invokedDirectly` 守卫）。
> 这反过来说明 spawn 方案更好——**进程隔离，setup 崩了不会带走主进程**，
> 进度则靠解析 stdout 拿。

**两个必须知道的后果**：

1. **写入位置**：setup 装出来的是 `resources/app/snowluma/` 与 `resources/app/runtime/`。
   若用户装到 `Program Files` 需要管理员权限——本项目 NSIS 是 `perMachine: false` +
   `allowElevation: false`，默认落 `%LOCALAPPDATA%\Programs\`，通常可写；
   少数 ACL 异常的机器会失败，UI 需给出"以管理员身份运行"的明确提示。
2. **与自动更新的关系（利好）**：electron-updater 的差分更新**只覆盖安装清单内的文件**，
   用户后装的 `snowluma/` 不在清单里 → 更新后协议端**自动保留，无需重装**。
   反之 `runtime/qq-portable`（1.6 GB）也同理不会被反复重下。

---

## 四、风险评估

| 风险 | 等级 | 说明与缓解 |
|---|---|---|
| 覆盖升级丢数据 | **中** | `installer.nsh` 的逻辑已经写得很稳（备份→判定→还原），但**从未实测过**。第一步验收第 4 项必须真机覆盖一次 |
| 安装版"装完打不开" | 中 | 数据为空时控制台能否起到？`resolveDataDir()` 会建空 `data/`，需实测首启 |
| 三方许可（SnowLuma） | **高** | EULA 限制重分发。安装包绝不可内置 SnowLuma 二进制，只能装完由用户触发下载。**这是硬约束，不是技术选择**。好在"下载"这一步可以完全在 UI 内完成（一键 setup），用户无感知 |
| 安装版写 `resources/app/` 权限不足 | 中 | 一键 setup 要往安装目录写 110 MB + 1.6 GB。默认装 `%LOCALAPPDATA%\Programs` 通常可写，ACL 异常机器会失败 → UI 需给"以管理员身份运行"提示 |
| QQ 便携包体积 | 高 | 1.6 GB，且腾讯 HummerSetup 不接受静默安装参数。同上不可内置，但**可通过 UI 一键 setup 自行获取** |
| SmartScreen 拦截 | 高 | 未签名 exe 的转化损失。第二步才需决策（买证书 or 接受摩擦） |
| GitHub 更新源可达性 | 中 | 国内用户直连 `api.github.com` 不稳。electron-updater 支持自定义 URL，可指向 CDN |
| 两份产物维护成本 | 低 | zip 产线完全独立（`pack-release.mjs`），可并行维护；也可在第二步后停掉 zip |

---

## 五、需要你决策的问题

1. **走哪一步？**
   - 只做第一步（1–2h，换分发形态，更新仍手动）——风险最小，立刻可发安装包；
   - 直接做到第二步完整版（2–3 天）——体验最好，但要先做 `scripts/` 模块化改造 + 首启向导。

2. **zip 产线保留吗？**
   - 保留：两类用户都覆盖，维护两份产物列表（`release.mjs` 需要同时发 zip + exe）；
   - 淘汰：安装版 + 自动更新足够，README 可大幅简化。

3. **安装版用户怎么装协议端？**（这是产品体验的核心分歧）
   - A：UI 内「一键安装」按钮，应用内下载（spawn `setup.mjs`，**不需要脚本模块化改造**，
     实测 `setup.mjs` 可直接在 Electron-as-Node 下跑）；
   - B：README 引导手动放置 `snowluma/` 目录（工作量最小，但不够"傻瓜"）；
   - C：第一步用 B 兜底文案，第二步补 A 按钮（推荐——先落地再打磨）。

4. **代码签名买不买证书？**
   - 不买：接受 SmartScreen 摩擦；
   - 买 OV（约千元/年）：消除 SmartScreen；
   - 买 EV（更贵）：SmartScreen 立即信任 + 可做内核驱动签名（本项用不到）。

---

## 六、我的建议

**走 1 + 2保留zip + 3C + 4暂不买。**

理由：第一步把"能不能发安装包"这件事**当天验证掉**（含覆盖升级这个最危险的未实测路径），
而 zip 产线零改动、随时可回退。第二步的首启一键安装和自动更新是独立的体验增量，
且**都不需要大改现有代码**（一键 setup 是 spawn，自动更新是加一个依赖），
等第一步真机验证通过、确认没有隐藏坑（尤其覆盖升级）再投入，沉没成本最低。

> 补一句：如果你觉得"装完不能聊"不可接受，也可以**第一步就把一键安装一起做掉**——
> 它只依赖 `scripts/` 进包 + 一个 spawn + 一个按钮，不必等第二步。

---

## 附：实测方法与可复现脚本

本文的结论均可复现。两个验证脚本当时的临时产物已删除，方法记录如下：

1. **文件匹配验证**：用 `app-builder-lib/out/fileMatcher.js` 导出的
   `getNodeModuleFileMatcher` / `FileMatcher`，喂入 `package.json` 的 `build.files`，
   观察最终 pattern 列表与各路径的进出判定。
2. **依赖闭包验证**：用 `node-module-collector` 的 `TRAVERSAL` collector
   （`getCollectorByPackageManager(PM.TRAVERSAL, ROOT, tmpDir)`）收集生产依赖，
   实测得 4 个包 / 2.9 MB。
3. **路径解析验证**：按 `resources/app/src/config.js` 的位置反推
   `ROOT` / `UI_DIR` / `snowlumaDir()` 的打包后实际值。
4. **Electron-as-Node 验证**（一键 setup 的依据）：
   `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe <script>`
   依次验证 `process.version` / `setup.mjs --check` / 内置模块 / `spawn`。
   subprocess 一项须用普通 Node 做对照组，否则会把"本机没跑 QQ"误判成 Electron 缺陷。

> 若要把这两条固化成回归测试，可放到 `test/` 下（项目已有
> `test/pack-release-test.mjs` 的 `excludeReason` 测试先例），
> 新增 `test/build-files-match-test.mjs`，防止以后有人改 `build.files`
> 又把 `scripts/` 排掉而不自知。
