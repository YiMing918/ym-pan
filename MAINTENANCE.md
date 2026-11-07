# MAINTENANCE.md · 维修与交接手册

## 第一部分：给站长本人（不懂代码也能看懂）

这个站的一切都在**你自己的账号**里：代码在你的 GitHub、站点跑在你的 Cloudflare、域名是你的。它不需要任何人（包括任何 AI）在线才能运行——你平时用它的时候，全程只有你的账号在干活。

你只需要记住三件事：

1. **平时什么都不用管。** 每天有两道自动巡检：仓库里的「看门狗」（GitHub Actions，每天约北京时间 08:23）和站长 AI 侧的巡检（如果还在跑）。域名失效、路线不通这类小毛病，看门狗会自己修好并重新上线。
2. **想知道坏没坏**，打开仓库的 **Issues** 页：有 `watchdog` 标签的帖子就是巡检报告；或者直接打开站点点「③ 接口自检」。
3. **真遇到某家网盘解析不了、又想修的时候**，把下面这段话连同仓库地址发给任何一个 AI 助手（或懂技术的人），对方读完本手册就能接手：

> 这是我的网盘解析站仓库：https://github.com/YiMing918/ym-pan 。请先读 MAINTENANCE.md 和 README.md，按手册的排查顺序定位是哪一家网盘的适配器坏了，对照手册里列的上游项目最新口径修复 functions/api/parse.js 里对应那一家，改完跑 node tests/smoke.mjs 验证通过后再提交（仓库会自动部署）。注意：只用我自己账号的凭证、只返回直链不要中转流量、不要把任何个人信息写进仓库。

唯一可能需要你本人动手的情况：夸克巡检 Cookie 失效时，去站点「② 我的凭证」里重新扫一次码（那是你的账号安全验证，别人替不了）。其余都不用你。

---

## 第二部分：给接手维护者（AI 或开发者）

### 文件地图

| 路径 | 作用 |
|---|---|
| `index.html` | 前端单页：解析框、文件列表、直链三件套、凭证表单（localStorage）、接口自检、夸克扫码绑定巡检凭证 |
| `functions/api/video.js` | 视频解析：9 平台适配器（抖音/快手/微博/小红书/AcFun/B站主力，TikTok/即梦实验，YouTube 只回嵌入说明） |
| `functions/api/parse.js` | 解析层全部逻辑：11 家适配器 + 多路线回退 + 健康检查。顶部 `CONFIG:BEGIN/END` 是易变参数区（蓝奏镜像、123 路线） |
| `functions/api/qr.js` | 夸克扫码登录：`/api/qr`（发码）、`?action=poll`（轮询换 Cookie 存 KV）、`?action=status` |
| `functions/api/patrol.js` | 巡检接口：`POST /api/patrol`，需请求头 `x-patrol-key` = 环境变量 `PATROL_KEY`；用 KV 的 `quark_cookie` 对固定测试分享做真解析并回写轮换 Cookie |
| `scripts/watchdog.py` + `.github/workflows/watchdog.yml` | 仓库看门狗：每日巡检 + CONFIG 区机械自愈 + Issue 留痕 |
| `.github/workflows/deploy.yml` | 部署：push 到 main 时用 Secrets 里的令牌 wrangler 部署到 Pages（无令牌时自动跳过） |
| `tests/smoke.mjs` | 打桩冒烟测试：`node tests/smoke.mjs`（Node ≥ 18，无依赖） |

### 部署侧事实（原作者部署，其余部署者按 README）

- Cloudflare Pages 项目名 `ym-pan`；部署令牌与账号 ID 在仓库 Secrets（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`），fork 不继承。
- 巡检基础设施（可选）：KV 命名空间绑定变量名 `PAN_KV`；环境变量 `PATROL_KEY`。没配时巡检接口返回「未启用」，不影响解析。
- 回滚：Pages 控制台 → 部署列表 → 选旧部署「回滚」；或 git revert 后 push。

### 排查顺序（哪家坏了修哪家）

1. 先跑站点 `GET /api/parse?action=health` 看各家官网连通性：不通 = 上游维护/封段，等或看第 4 步。
2. 再看报错形状：对照下表定位。
3. 到上游在维护项目取该家最新口径（见「口径来源」），只改 `parse.js` 里对应适配器。
4. 改完跑 `node tests/smoke.mjs`；涉及真实流程的改动还要部署后用真实分享验（需要站长提供其账号凭证在其浏览器里测，维护者不要索要、不要代持凭证）。
5. 提交信息写清：`fix(<drive>): <改了什么>`，push 后等 deploy 工作流变绿，再 curl 线上复验。

### 各家口径速查（与 parse.js 一一对应）

| 盘 | 关键端点 | 凭证 | 常见故障签名 → 处理 |
|---|---|---|---|
| 百度 baidu | 分享页 HTML（sign/timestamp/shareid）→ `share/verify` → `share/list` → `api/sharedownload` | BDUSS | verify -12 = 页面校验没过（先 GET 分享页拿 PANPSC，本代码已做）；9013 = 当日风控量上限，等次日 |
| 阿里 aliyun | `v2/share_link/get_share_token` → `adrive/v2/file/list_by_share` → `v2/file/get_share_link_download_url` | 可匿名；Authorization 更稳 | token 失败多为提取码错或分享取消 |
| 夸克 quark | `drive-pc.quark.cn/1/clouddrive`：`share/sharepage/token` → `share/sharepage/detail` → `file/download`；大文件 `share/sharepage/save` 转存 | 整段 Cookie（`__puus` 会轮换，响应回写 credUpdate） | 41007 = 提取码错；直取失败先查是不是大文件触发转存路线 |
| UC uc | 同夸克，host 换 `pc-api.uc.cn`、pr=UCBrowser | 整段 Cookie | 同夸克 |
| 蓝奏 lanzou | 分享页 → iframe 子页 sign → `ajaxm.php?action=downprocess` | 无 | 页面含 `acw_sc__v2`/`arg1=` 且无 iframe = JS 人机挑战，纯接口无解（已知边界，别在这耗）；某域名连不上 = 看门狗会摘镜像 |
| 移动 cmcc | `share-kd-njs.yun.139.com/.../IOutLink/getOutLinkInfoV6` / `dlFromOutLinkV3` | Authorization 可选 | 实验适配器，字段名变了对照 JxPan 最新代码 |
| 天翼 ctyun | `cloud.189.cn/api/open/share/getShareInfoByCodeV2.action` → `checkAccessCode` → `open/file/listFiles.action` → `open/file/getFileDownloadUrl.action` | Cookie（取链） | 取链失败多为没登录态 |
| 小飞机 feijipan | `api.feijipan.com/ws/share/list` → `/ws/file/redirect` | token 可选 | 同上，实验 |
| 123 pan123 | CONFIG.pan123Bases 两条：`www.123pan.com/api`、`www.123pan.cn/b/api`，`share/list` → `file/download_info` | Authorization（取链） | 5112 = 需登录；两条都连接失败看门狗会报 Issue |
| 迅雷 xunlei | `xluser-ssl.xunlei.com/v1/shield/captcha/init` 换 `x-captcha-token` → `api-pan.xunlei.com/drive/v1/share`(/detail) | Authorization 可选 | captcha/init 不直发令牌 = 触发人工验证，已知难点 |
| 光鸭 guangya | — | — | 筹备中：官方分享接口未公开（设备授权流），不要编假接口 |


**夸克扫码（functions/api/qr.js）**：二维码内容 = `https://su.quark.cn/4_eMHBJ?token=…&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400`——**ssb=weblogin 与 uc_biz_str 缺一不可**：ssb 为空时夸克 App 一扫就报「登录请求已过期」，与真过期一模一样，极易误诊（2026-11-07 站长两次扫码失败皆因此）。令牌 getTokenForQrcodeLogin（status 2000000、data.members.token）；轮询 getServiceTicketByQrcodeToken：50004001 等待、50004002 过期、出现 service_ticket 为成功，再走 account/info?st= 换 Cookie、drive-pc config 验活。格式核对自 xiaoya-alist 的 quark_cookie.py。

### 视频口径速查（functions/api/video.js，改版时对照 MediaGet、ucmao/media-parser、jiuhunwl/short_videos）

- **抖音**：iesdouyin 分享页（移动 UA）→ `window._ROUTER_DATA`（转义形态，提取器已处理去转义）→ `videoInfoRes.item_list[0]`；去水印 `/playwm/`→`/play/` + `ratio=720p`→`1080p`。失效特征：无 `_ROUTER_DATA` 或 item_list 空。
- **快手**：`kuaishou.com/fw/photo/{photoId}`（风控换 `m.gifshow.com`）→ 正则抠 `photoUrl/photoH265Url/caption/coverUrls`。失效特征：落登录页/空壳。
- **微博**：游客凭证 `passport.weibo.com/visitor/genvisitor`→`visitor?a=incarnate` 换 SUB（模块缓存 20 分钟）→ `weibo.com/ajax/statuses/show`（必须 `X-Requested-With`）→ `page_info.media_info.playback_list`（过滤 `meta.type=3` 预览图）；fid 走 `tv/api/component`；降级 `m.weibo.cn/statuses/show`。失效特征：返回 HTML = 凭证失效或丢请求头。
- **小红书**：xhslink 跟随后保留 `xsec_token`，手机 UA → `window.__INITIAL_STATE__`（undefined→null）→ `noteData.data.noteData` 或 `noteDetailMap`；视频优先 `video.consumer.originVideoKey` 拼 `sns-video-bd.xhscdn.com`，流选型避开 `streamType` 259/309（小程序水印流）。
- **AcFun**：`window.pageInfo.currentVideoInfo.ksPlayJson` → `adaptationSet[0].representation[]`（m3u8 多档）。
- **B站**：`x/web-interface/view` 拿 cid → `x/player/playurl`（fnval=0 单文件≈480p；fnval=4048 DASH 游客≈720p）；页面 `__playinfo__` 兜底；CDN 必须带 Referer；-352/412 = 风控。1080p 需登录，本站不收账号、不假装能给。
- **TikTok**（实验）：网页 SSR `__UNIVERSAL_DATA_FOR_REHYDRATION__` 的 `itemStruct.video.playAddr`（忌用 downloadAddr=水印版）；兜底 `api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=`。数据中心 IP 常被拦，失败属预期内。
- **即梦**（实验）：落地页 query 的 id → `share/landing_page` 拿 metadata（注意 download_info.url 是 Logo 水印版）→ POST `mweb/v1/get_item_info` 取 `transcoded_video.origin.video_url`（带 `lr=display_watermark` 的也是水印版）。
- **YouTube**：服务端基本不可行（机器人墙 + PO Token），只回 embed/watch，不要试图接第三方解析池。

看门狗视频探针（`probe_video`）与网盘探针同理：假链接的可接受报错集合，任一命中即正常；2026-11-07 网盘探针曾因「假 ID 能穿过识别层、上游结构化报错才是健康形状」误报 5 家，已按线上真实报错校准——以后新增探针先拿线上真实报错定集合，别凭适配器文案猜。

### 口径来源（改版时对照这些在维护的项目）

- ByLsPro/JxPan `_worker.js`（移动/天翼/小飞机/123/UC/夸克/光鸭的 Workers 口径）
- hmjz100/LinkSwift（九家，浏览器同源口径，尤其百度 AccessToken 新路线、迅雷、光鸭）
- yuantuo666/baiduwp（百度历史蓝本，已不活跃，只看逻辑）
- qaiu/netdisk-fast-download（蓝奏/123/移动口径与限制实测）
- OpenListTeam/OpenList 与 AList 驱动源码（光鸭、迅雷、阿里开放平台）

### 看门狗规则（scripts/watchdog.py）

- 只允许改 CONFIG 区两个数组：`lanzouMirrors`（连接级死的摘掉、活的排前，至少保留 2 个）、`pan123Bases`（主死备活才交换）。
- 提交后用 `gh workflow run deploy.yml` 触发部署（GITHUB_TOKEN 的 push 不自动触发其他工作流，这是 GitHub 的规则）。
- 异常开/更新 `watchdog` 标签 Issue；全恢复自动关闭。
- **不要扩大它的权限**：不许改 CONFIG 区以外的代码、不许碰凭证逻辑。需要动逻辑的修复走人工/AI 按上面 SOP 做。

### 巡检（真解析自检）

- 站长在页面「② 我的凭证 → 夸克扫码绑定」扫一次码，Cookie 存入 KV `quark_cookie`（扫码接口 `/api/qr`；已绑定时重绑需巡检口令）。
- 外部巡检（站长 AI 侧 cron）每日调 `POST /api/patrol`（带 `x-patrol-key`）对一个固定测试分享真解析；口令与测试分享不在本仓库（在站长侧保存），fork 部署没有这两样，巡检自然不启用。
- 巡检返回 `stage=cred` = Cookie 失效，通知站长重扫码；`stage=token/list/download` 失败 = 口径问题，按 SOP 修 parse.js（patrol.js 里是同一套夸克端点的精简副本，修口径时两处一起看）。

### 红线

- 只用访客/站长**自己账号**的凭证；禁止公共账号池。
- 只返回直链，**禁止代理/中转文件流量**（Cloudflare 条款 + 免费额度）。
- 仓库禁止出现站长个人信息：域名、邮箱、IP、属地、运营商一律不进；预览图只用示例数据。
- 英文标识保留原文并配中文备注（站长既定偏好）。

## 直链可用性监测（2026-11-07 站长要求补上）
「解析出链接」不等于「链接能下载」：微博直链不带 Referer 直接 403、阿里匿名能列目录不能取链，都是签发成功但不可用的实例。监测口径因此分三层，缺一层都是盲区：
1. **结构探针**（假链接）：验识别与上游报错形状，抓口径变更。
2. **可用性探针**（真样本、拉字节）：看门狗 probe_usability——抖音/快手/微博/AcFun 用固定公开样本真解析后 Range 拉字节（微博按结果自带的 needReferer 拉）、AcFun 拉清单+首分片；阿里用公开样本验匿名 token→列目录链（取链需凭证，止于列表层）。样本失效与口径变了都会报，靠每日巡检（助理侧）分辨并更换样本。
3. **真解析巡检**（夸克，带站长凭证）：签发后带会话拉字节（linkProbe），是唯一带凭证的字节级验证；其余需凭证的家（百度/UC/123 等）凭证只在访客浏览器里，自动监测够不着——口径靠结构探针+同系实现兜底。
新适配器上线标准：必须配一条可用性探针或巡检覆盖，否则只能算「结构通过」。

## 站长保险箱（v1.3）
- 组件：functions/api/owner.js（status/open-setup/setpass/verify/changepass/vault/unvault）+ parse.js 的 x-owner-pass 兜底 + 首页「站长保险箱」卡。数据在 KV：owner_hash（口令 SHA-256）、owner_setup_until（设置窗口截止毫秒）、vault_<drive>（各家凭证 JSON，键名与前端凭证表一致）。
- 开设置窗口：POST /api/owner {action:'open-setup'} 带 x-patrol-key（口令在站长侧保管文件 patrol_key.txt），30 分钟内站长在页面自设口令。重置口令（窗口内再 setpass）会清空全部 vault_*。
- 夸克兜底顺序：本次请求自带 > 保险箱 vault_quark > 巡检绑定 quark_cookie。
- 故障排查：保险箱不可用先看 KV 绑定 PAN_KV；口令忘了 = 开窗口重置（凭证需重存，属预期）；保险箱异常不影响无口令解析（parse.js 已 try/catch 隔离）。

## 保险箱口令恢复（v1.3.1，三层都不依赖任何人）
1. 恢复码（首选）：设/重置口令时页面会签发一串恢复码（只显示一次，站长自存）。忘口令 → 站内「忘口令？用恢复码重置」→ 输恢复码+新口令。重置会清保险箱并签发新恢复码。
2. 设置窗口：助理用巡检口令开 30 分钟窗口后直接 setpass（便民路，非唯一路）。
3. 终极重置（恢复码也丢了）：站长登录自己的 Cloudflare 后台（部署本站的那个账号）→ 左侧「存储和数据库 / Workers KV」→ 打开 ym-pan-kv → 搜索 owner_ 删掉 owner_hash、owner_recovery_hash 两个键 → 再搜 vault_ 把开头的键全删 → 回网站保险箱处重新设口令（未设状态可直接设，无需窗口）→ 重新存凭证。
