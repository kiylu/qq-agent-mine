# 禁漫漫画下载（jm-comic）v2

给 QQ Agent 加的一个**技能**：群友发来禁漫天堂（JMComic）的漫画 ID，机器人在**后台异步**
下载整本 → **还原竖切打乱** → **合成 PDF** → **上传到提出请求的那个会话**（群文件/私聊文件）。

- 类型：**技能（Skill / LLM 型）** → 放 `skills/`（唯一能注册工具给模型的地方）
- 目录：`<QQ Agent 安装目录>\resources\app\skills\jm-comic\`
- 版本：2.0.0 ｜ 运行时依赖：无（用环境自带 `fetch`；manifest 已声明 `web_fetch`）
- **可选增强**：Python 3 + Pillow（用于还原与 PDF）。没装也能正常下载，只是保留原图
- 默认下载位置：`<QQ Agent 安装目录>\resources\app\data\jm-comic\jm-<ID>\<ID>-<本子名>\`

---

## 1. 怎么用

| 你说的话 | 会发生什么 |
|---|---|
| `jm123456` / `JM-123456` / `帮我下 123456 这本` | 秒回「已开始处理」→ 后台下载→还原→合成 PDF→上传到本群文件→回帖汇报 |
| `https://18comic.vip/album/123456/xxx`（整条链接） | 同上，工具自己从链接里取 ID |
| `@机器人 123456` | 同上（只有 @ 了机器人的纯数字才这样判，避免误伤群里的普通数字） |
| `下好了吗` / `怎么没动静` | 查进度与最近记录 |
| `本地有哪几本` | 列本地收藏 |
| `支持 PDF 吗` / `群文件还有空间吗` | 报环境能力与群文件配额 |
| `今天赢了三把 123456 哈哈` | **不会**触发 |

**为什么是异步**：一本 300 页的漫画要下载+还原+合成几十秒到几分钟。旧版在模型回合里同步跑，
会把模型请求挂住、白烧 token，还可能撞上调用超时；群友连发几本机器人直接卡死。
现在工具调用**立刻返回**，干活全在后台，完成后主动回帖。

## 2. 设置的 20 个开关（控制台 →「技能」→ jm-comic → 齿轮）

**输出与还原**

| 设置 | 默认 | 说明 |
|---|---|---|
| 输出格式 | `pdf` | `images` = 只存原图、零依赖、不上传 PDF |
| 还原竖切打乱 | 开 | 按站点返回的 `scramble_id` 还原成正常可读的图；关掉最快 |
| 合成 PDF 后删除原图 | 关 | 开启后本地只留 PDF，省磁盘。**PDF 生成失败时自动保留原图**；仅在输出格式为 `pdf` 时生效。⚠️ 删了就没有原图，事后无法改画质重做 |
| PDF 画质 | 85 | 嵌入 PDF 的 JPEG 质量 |
| PDF 单页最长边 | 0 | 0=原尺寸；填 1600 可显著减小体积 |

**上传与安全阀**

| 设置 | 默认 | 说明 |
|---|---|---|
| 文件上传到哪 | `request` | 在哪个会话提出就传回哪里；也可选只群/只私聊/不上传 |
| 单文件上传上限 | 200 MB | 超过按下面的开关处理 |
| 超限时直接拒绝 | 关 | 关=自动切成 `.partNofM` 分卷逐个上传 |
| 上传前检查群文件配额 | 开 | 先查数量与空间，不够就提前说明 |
| 允许触发的 QQ | 空 | 留空=所有人；填了就只认管理员/群主 + 名单内的人 |
| 本地文件保留天数 | 7 | 到期自动清理目录；0=永不清理 |
| 群文件保留天数 | 0 | 到期自动删除机器人上传的群文件；0=不删 |

**下载与网络**

| 设置 | 默认 | 说明 |
|---|---|---|
| 下载到哪个目录 | 空 | 空=`resources/app/data/jm-comic` |
| 备用站点域名 | 空 | **域名失效时的救命设置**，一行一个 |
| 每话最多下载多少页 | 500 | 防超长本子 |
| 多章节本子下载全部章节 | 开 | 关掉只下第一话 |
| 同时下载几张图 | 4 | 建议 ≤ 8 |
| 单次请求超时 | 30 秒 | |
| 在群里报进度 | 开 | |

**环境**

| 设置 | 默认 | 说明 |
|---|---|---|
| Python 解释器路径 | 空 | 空=自动探测。填错会**明确告诉你并回退**（不会静默换一个） |
| 启用下载功能 | 开 | 总开关 |

## 3. 三个已知边界

1. **还原需要 Python + Pillow**。没装时自动降级为「原样保存图片」，并在结果里说明原因，
   不会让整个下载失败。安装：`py -m pip install --user pillow`
2. **不提供搜索/分类**，只能按 ID 下（按需求"只保留识别漫画和下载"）。
3. **不支持"群友发图 → 机器人收藏"**。工具拿不到本轮消息（QQ Agent 的既定设计），
   要做得额外挂钩子+消息存档，属于下一版范围。

## 4. 风险须知（改不了，只能接受或规避）

- **传进群文件 = 全体群员可见可下载**。事后删除群文件也**收不回**别人已下载的副本。
  想规避就把「文件上传到哪」设成「只私聊」。
- **机器人账号风控**。往群里传成人类 PDF 比发图更扎眼，可能被限制上传甚至封号。
  建议先在私聊或小号测试群跑通再上大群；「群文件保留天数」设个值可以自动回收。
- **重复请求同一本**：同一会话同一时间只跑一本；下载过的图不会重复下（可补下失败项）。

## 5. 它内部怎么工作（排障时看这段）

```
群友发 jm123456
  └─ 钩子 before-context：识别 ID → 在消息正文补提示 + 记 pendingHint
       └─ 钩子 before-llm-messages：补一条 system 消息，提示模型调用工具
            └─ 工具 jm-comic__download_album
                 ├─ 权限校验（白名单/管理员；发送者来自 before-tool 钩子记的 callerLog）
                 ├─ 入队 → **立刻返回**（不阻塞模型）
                 └─ 后台任务：
                      ① engine.js   下载原图（多域名容错 + AES 解密 + 签名）
                      ② engine.js   现查 scramble_id（写死会把正常图弄花）
                      ③ pdf.js      Python+Pillow：还原竖切 → 合成 PDF
                      ④ upload.js   配额预检 → 上传到目标会话（超限自动分卷）
                      ⑤ 回帖汇报；写入 tasks.json 留痕
```

**接口对齐本地 jmcomic 2.7.7 的移动端实现**：
- `token = md5(秒级时间戳 + 密钥)`，`tokenparam = "<ts>,2.1.7"`
- 响应体是 **AES-256-ECB** 加密的 base64（key = `md5(ts+secret)` 的 32 字节）
- **必须用 App 的 UA**：实测桌面 Chrome UA 会被判 `401 Not legal request`
- 图片直链要带 `v=时间戳`；不带会拿到空数据
- `scramble_id` 由 `/chapter_view_template` 单独返回，用另一把密钥（实测返回 220980）
- 切块数 `N`：`aid < scramble_id → 0`（不还原）；`< 268850 → 10`；否则
  `(md5(aid + 文件名去扩展名) 最后一个十六进制字符的 ASCII % 10或8) * 2 + 2`

### ⚠️ 踩坑记录：参与哈希的文件名**必须去掉扩展名**

这是本技能出过的最严重的一次线上问题，写在这里防止重犯：

`jmcomic` 侧算 N 走的是 `JmImageTool.get_num_by_url()` → `of_file_name(url, True)`，
而 `of_file_name(url, True)` 的第二个参数含义是"**去掉后缀**"，返回的是 `'00001'` 而不是 `'00001.webp'`。
我最初把**带扩展名**的文件名喂进了哈希，于是：

| 哈希输入 | N | 与官方成品逐像素差异 |
|---|---|---|
| `00001`（正确口径） | **4** | 平均 **1.38**（仅 JPEG 压缩噪声）✅ |
| `00001.webp`（错误口径） | 12 | 平均 **58.07**（完全不同的图）❌ |

后果很隐蔽：**"还原"反而把本来正确的图弄花**，而老本子（`aid < scramble_id`）算出来都是 0、
根本不做还原，所以看起来"老本子没事、新本子花"——像是"新本子算法变了"，其实是输入口径错了。

定位方法（可复用）：用官方库 `jmcomic.download_album()` 下同一本，把它的成品和我们的解码结果
**逐像素比对**（`PIL.ImageChops.difference`）。差异应该是 JPEG 压缩级别的（平均 < 2），
如果平均几十，就是算法/参数错了。

现在 `jm_worker.py --selftest` 固化了 6 个切块数用例（含本事故的本尊 `JM1465595/00001.webp`），
`selftest.mjs` 每次都会跑它。

**验证过的协议端能力**（2026-09-30 实跑）：
`upload_group_file` 吃本地绝对路径、返回 `file_id`；`upload_file: false` = 只入库不发消息；
`get_group_file_system_info` 给出数量/空间上限；`delete_group_file` 按 `file_id` 删除；
机器人上传群文件**不需要是管理员**。

## 6. 出问题了怎么查

| 现象 | 先看这里 |
|---|---|
| 「技能」页看不到卡片 | 文件是否在 `resources\app\skills\jm-comic\`（**不是**项目根下的 skills） |
| 卡片显示"加载失败" | 页面会给出原文；多半是 `skill.json` 有 BOM 或引号写错 |
| 发 ID 没反应 | 模型没调用工具：看 `GET /api/tools/availability` 的 `reason` |
| 回复"所有禁漫域名都连不上" | 站点换域名 → 把可用域名填进「备用站点域名」 |
| 回复"站点拒绝了本机 IP" | 需要系统级代理（本技能跟随系统代理，不单独配置） |
| 提示 PDF 没生成 | 用 `storage` 工具看能力状态；多半是没装 Pillow 或 Python 路径填错 |
| 部分图片失败 | 站点限速。**重发同一个 ID 会接着补下**（已下好的不重下） |
| **图"还原"后反而更花** | 切块数口径错了。用 `python jm_worker.py --selftest` 自检；现在已内置回归用例 |
| 老本子正常、新本子花 | 老本子 `aid < scramble_id` 本来就不还原（N=0）；新本子才走还原，见上面的踩坑记录 |
| 上传失败"空间不足/数量已满" | 清理群文件，或调小「群文件保留天数」 |
| 上传失败"私聊文件发送失败" | 部分协议端不支持私聊文件，改用群内发起 |

运行时自检（热重载落盘即生效，不用重启）：

```powershell
$h = @{ Origin = 'http://127.0.0.1:3210' }
(Invoke-WebRequest 'http://127.0.0.1:3210/api/skills' -UseBasicParsing -Headers $h).Content |
  ConvertFrom-Json | Select-Object -ExpandProperty skills |
  Where-Object { $_.id -eq 'jm-comic' } |
  Format-List id,kind,loaded,active,loadError,lastError,toolIds

(Invoke-WebRequest 'http://127.0.0.1:3210/api/tools/availability' -UseBasicParsing -Headers $h).Content |
  ConvertFrom-Json | Select-Object -ExpandProperty tools |
  Where-Object { $_.id -like 'jm-comic__*' } | Format-Table id,enabled,reason -AutoSize
```

期望：`loaded=True active=True loadError=''`，`toolIds` 为
`jm-comic__download_album`、`jm-comic__task_status`、`jm-comic__library`、`jm-comic__storage`。

## 7. 自测

```powershell
# 先切到技能目录（命令里的 . 就是它）
cd "<QQ Agent 安装目录>\resources\app\skills\jm-comic"
$node = "<QQ Agent 安装目录>\resources\app\snowluma\node.exe"

# 46 项确定性用例（假 api/ctx + 假站点 + 真跑 Python/PDF），不联网
& $node selftest.mjs --no-live

# 额外做一次真实站点端到端
& $node selftest.mjs --live-id=422444

# Python 不在 PATH 上时可以显式指定
& $node selftest.mjs --no-live --python="C:\Python313\python.exe"
```

覆盖：清单/工具注册/设置键一致性、参数边界、钩子四种触发（含"不触发"）、权限拒绝、
异步队列与重复请求、假站点端到端落盘、配额预检、上传通道（群/私聊/分卷/文件不存在）、
Python PDF 真跑、切块数 N 的口径回归、路径回退标记、降级路径、storage 自检。
未探测到 Python 时，PDF/还原相关用例会自动 skip（不会误报失败）。

## 8. 把技能分享给别人

**QQ Agent 没有"从本地 zip 导入"的界面**——它的 zip 安装只走市场口令
（`POST /api/market/install {code}`，服务器按 code 下发包）。所以分享方式只有两种：

| 方式 | 做法 | 适合 |
|---|---|---|
| **直接给文件夹**（推荐） | 把 `jm-comic` 文件夹发给对方，让他放进 `<安装目录>\resources\app\skills\`，**不用重启** | 熟人、少量分发 |
| 走市场 | 点技能卡片上的 ⬆ 上传 → 审核通过后拿到口令，对方输口令安装 | 公开分享 |

打包成 zip 也可以（本目录已用 QQ Agent 的安装校验代码 `src/zip-install.js` 实测通过：
9 个文件、解压 134 KB、无禁用后缀、根目录会被正确剥掉）。但务必提醒对方：

1. **解压后不要多套一层**：正确是 `skills\jm-comic\skill.json`，
   错误是 `skills\jm-comic\jm-comic\skill.json`
2. **是 `resources\app\skills\`**，不是安装根目录下的 `skills\`（放错会静默加载 0 个）
3. **想要还原 + PDF 需要 Python 3 + Pillow**：`py -m pip install --user pillow`
   没装也能下载，只是不还原、不出 PDF

目录里附了一份写给"收到的人"看的 `安装说明.txt`，可以直接连包发出去。

> 分享前请自查：本目录**不应**包含任何个人路径（早期版本在 `selftest.mjs`/`pdf.js` 里
> 写死过本机 Python 路径，已改为自动探测）。可用下面这句扫一遍：
> ```powershell
> Select-String -Path .\* -Pattern 'C:\\Users\\|AppData\\Local\\Programs' -Encoding UTF8
> ```

## 9. 文件清单

| 文件 | 作用 |
|---|---|
| `skill.json` | 清单：id、20 项设置表单、提示词片段 |
| `index.js` | 主编排：4 个工具 + 3 个钩子 + 异步任务队列 + 权限 + 清理 + 通知 |
| `engine.js` | 下载引擎：接口签名/AES 解密/多域名容错/图片下载/scramble_id |
| `pdf.js` | Python 桥：解释器探测（带回退标记）、worker 调用、进度流解析 |
| `jm_worker.py` | Python 工作进程：竖切还原 + 合成 PDF（只做图像，不发网络请求） |
| `upload.js` | 群/私聊文件上传、配额预检、分卷、按 file_id 删除 |
| `selftest.mjs` | 自测脚手架（不影响加载） |
| `_verify_descramble.py` / `_calibrate_scramble.py` | 开发期核对算法与 `scramble_id` 的工具 |
| `README.md` | 本文件 |

> 免责：本技能只做"按 ID 下载并整理成 PDF"，不搜索、不传播、不展示内容。
> 请自行确认所在地区法律与站点条款，仅用于个人学习与研究。
