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
| `functions/api/qrlogin.js` | 访客扫码登录（v1.6）：7 家扫码 + 2 家账密的发码/轮询入口，凭证只回扫码者浏览器、不存服务器 |
| `functions/api/owner.js` | 站长保险箱：口令校验与凭证存取（KV `vault_<drive>`），恢复码与终极重置见保险箱相关章节 |
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
| 光鸭 guangya | `api.guangyapan.com/nd.bizuserres.s/v1/get_share_access_token` → `get_share_page_files_list` → `get_share_download_url`（对照 JxPan） | 免登录可列/取链；受限分享用 gyToken Bearer 兜底、gyRefresh 自动续期 | msg 非 success 即口径变化 |


**夸克扫码（functions/api/qr.js）**：二维码内容 = `https://su.quark.cn/4_eMHBJ?token=…&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400`——**ssb=weblogin 与 uc_biz_str 缺一不可**：ssb 为空时夸克 App 一扫就报「登录请求已过期」，与真过期一模一样，极易误诊（2026-11-07 站长两次扫码失败皆因此）。令牌 getTokenForQrcodeLogin（status 2000000、data.members.token）；轮询 getServiceTicketByQrcodeToken：50004001 等待、50004002 过期、出现 service_ticket 为成功，再走 account/info?st= 换 Cookie、drive-pc config 验活。格式核对自 xiaoya-alist 的 quark_cookie.py。

### 登录口径速查（functions/api/qrlogin.js，v1.6；改版时对照 JxPan 的同名实现）

无状态设计：start 发码并把会话参数回给浏览器，poll 时浏览器带回，服务器不存任何人的凭证；换到的凭证只回扫码者浏览器。看门狗 `probe_qrlogin` 每天逐家调 start 探活，某家改版先在那里报出来，访客可退回手填凭证（两条路互备是定版要求，别删手填）。

实现暗病备忘（后人改 qrlogin.js 前先看）：① **`aesEcbBytes` 必须逐块（16 字节）分别用 CBC 零 IV 加密、每块只取输出首块**，拼起来才是真 ECB。两个方向都踩过：2026-11-08 曾误以为要「整段一次加密再截尾」，那只有第一块对——CBC 会把前块密文异或进后块，多块报文从第二块起全错；2026-11-10 移动登录报文（81 字节）因此被上游解不开、只回「参数错误」，站长扫码确认后网站毫无反应。小飞机时间戳只有 13 字节（单块）所以一直没暴露。WebCrypto CBC 输出尾部自带一个 PKCS#7 填充块，逐块取首块时天然丢弃，不用管。② `Uint8Array.map()` 返回的还是 Uint8Array，回调里算出的 hex 字符串会被转回数字——字节转 hex 必须先 `[...bytes]` 展开成普通数组再 map（小飞机时间戳曾因此拼成十进制乱码、报「系统时间不正确」）。③ 移动签名 `mcSign` 的 quote 必须用**纯 `encodeURIComponent`，`%2F` 绝不能还原成 `/`**：2026-11-10 实测，还原后 base64 报文只要含 `/`（约七成概率）签名就被上游拒（1010010014 签名校验失败），且每轮轮询报文相同、会整场全灭。别信「等价 python quote」的想当然——官方客户端是 JS，照它的口径来。④ 百度 `getqrcode` 返回的 `imgurl` **不带协议头**（`passport.baidu.com/v2/api/qrcode?...`），前端直接塞 `<img src>` 会被当相对路径请求本站域名 → 404 裂图（2026-11-10 站长实测）；start 里必须补全 `https://` 再回。

| 家 | 起始 | 轮询/确认 | 产出凭证 | 易变点 |
|---|---|---|---|---|
| 百度 baidu | passport `v2/api/getqrcode`（tpl=netdisk）→ sign/imgurl | `channel/unicast` 长轮询 → `v3/login/main/qrbdusslogin` 换 cookie | bduss（+stoken） | tpl 与 apiver=v3 |
| 阿里 aliyun | `passport.alipan.com/mini_login.htm` 抠 `_csrf_token` → `newlogin/qrcode/generate.do`（fromSite=52） | `newlogin/qrcode/query.do`，CONFIRMED 后 bizExt(base64) 里 `pds_login_result` | aliAuth + aliRefresh；parse 时 `open.aliyundrive.com/oauth/access_token`（client_id `25dzX3vbYqktVxyX`）自动换新 | csrf 正则、umidToken 造法 |
| 夸克 quark | `uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=<uuid>`（POST 无 body）→ 令牌在 `data.members.token`（不是 data.token！）；码内容 ssb=weblogin 必带（同巡检 qr.js，已实证实现，勿改走 api.open.uc.cn） | GET `uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken`（带同一 request_id）→ 正则抠 service_ticket；50004002=过期/未注册（含刚发码未扫时的 Token Not Found，前端按过期自动换新码）、20000/50000/50004003=已扫；换票：`pan.quark.cn/account/info?st=` → `pan.quark.cn/` 收 Cookie（须含 `__puus`/`__pus`）→ `drive-pc config` 复核 status=200 | quarkCookie | members 层级、uc_biz_str |
| UC uc | `api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin`（POST 表单 client_id=381），令牌同在 `data.members.token`；码内容 `su.uc.cn/1_n0ZCv` | `api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken`（POST 表单）→ `data.members.service_ticket`；换票照 xiaoya：`drive.uc.cn/account/info?st=` → `pc-api.uc.cn file/sort`（UC浏览器 UA）补 `__puus` | ucCookie | client_id、biz_str（照 xiaoya-alist uc_cookie.py） |
| 移动 cmcc | `yun.139.com/orchestration/auth-rebuild/key/v1.0/getRsaPublicKey`（签名头）→ RSA 加密自造 AES 密钥得 skey；码 = `yun.139.com/w/#/qrcLogin?sID&dID&cType=9` | `permission/v1.0/login`：AES-ECB 加密 `{dycPwd:sid,loginStyle:QRCode}`；resultCode 0 成功 / 200059541 等待 / …548 已扫 / …542/549 过期；令牌拼 `Basic pc:手机号:authToken` | cmccAuth | 签名 = MD5(纯 encodeURIComponent 后逐字排序的 JSON 的 b64) + MD5(时间:nonce) 再 MD5 拼接大写（%2F 不还原，见暗病备忘③）；AES 必须真 ECB 逐块加密（见暗病备忘①）；client `10701`、version `7.17.2`、channel `1000101` |
| 天翼 ctyun | 跟随 `cloud.189.cn/api/portal/unifyLoginForPC.action`（appId `8025431004`）跳转收 cookie 抠 lt/reqId → `open.e.189.cn/api/logbox/oauth2/getUUID.do` | `qrcodeLoginState.do` 出 redirectUrl → `api.cloud.189.cn/getSessionForPC.action` 换 session 并收 `COOKIE_LOGIN_USER`/`SSON`，合并成整段 Cookie | ctCookie | lt/reqId 抠取正则、appId |
| 光鸭 guangya | `account.guangyapan.com/v1/auth/device/code`（client_id `aMe-8VSlkrbQXpUR`、scope `user profile sso offline_access`） | `v1/auth/token` 设备码授权；error=authorization_pending 等待、expired_token 过期 | gyToken + gyRefresh | client_id |
| 小飞机 feijipan（账密） | 无扫码：`api.feijipan.com/ws/login?uuid&devType=6&devCode&devModel=chrome&devVersion=151&timestamp=<AES>&appToken=&extra=2`，body `{loginName, loginPwd}` 明文（HTTPS） | timestamp = AES-128-ECB(毫秒时间戳字符串， key=`dingHao-disk-app`) 的大写 hex；报「时间」错时用全新加密时间戳重试一次（明文时间戳必被拒，2026-11-08 已实测） | fjToken = data.appToken | 密码绝不落盘/进日志（本站与看门狗都不碰）；服务器时钟偏差大时会报「系统时间不正确」 |
| 123 pan123（账密） | 无扫码：POST `<base>/user/sign_in`，base 三域名互备 `api.123278.com/api`、`login.123pan.com/api`、`www.123pan.cn/b/api`，body `{type:1, passport:<注册手机号>, password}`（明文走 HTTPS），头带 `platform: web` | code=0 且 `data.token` → p123Token（parse 侧自动补 Bearer 前缀）；passport 必须是注册手机号，非手机号官方直接拒 | 密码绝不落盘/进日志。**2026-11-10 真账号实测定版：123 官方按登录来源 IP 做风控，本站请求从 Cloudflare 境外节点发出会被判「境外登录风险」并要求短信/微信验证——账密通道在本站形态下走不通**，主路线改为手填 Authorization（用户在自己设备浏览器登录官网取）；账密表单保留，命中风控文案时 qrlogin 会直接指路手填。短信验证码登录已查死、别再试（2026-11-10 晚扒官网现行前端代码实锤）：发码接口 `user/get_vCodeV2` 必须带阿里云无痕验证码产出的 `CaptchaVerifyParam`+`SceneId`，只能在官网页面内由官方 SDK 生成，服务端无法代发（验码走 `v_code/check`）；浏览器端代登录亦不可行——123 接口对站外 Origin 无 CORS 放行（实测预检无 `Access-Control-Allow-Origin`）；开放平台令牌只能管本人文件与本人分享的创建/列表，解析不了任意分享链接，不顶用。手填令牌按设备取（存储键名 `authorToken`，官网 getLogin/主包代码已核实）：电脑 F12 请求头 / 安卓 Chrome 书签脚本 / 苹果 Safari 用快捷指令「在网页上运行 JavaScript」读同一键名——但站长 iPhone 真机多轮实测（允许运行脚本开、共享表单显示开、输入类型只留 Safari 网页、首跑已点允许）仍静默无输出，连 `completion('测试123')` 常量都不出结果，原因未明；站内与 README 口径已注明此 iOS 风险并给电脑 F12 兜底，勿再陪用户逐项排查此路 |
| 迅雷 xunlei（无通道） | 做不了，别再试：照 OpenList thunder 驱动复刻全套账密登录（core login v3 + div101 设备签名 + captcha 签名链）实测，上游对新会话恒回 `userinfo_expired`「登录态已过期」并要官方 App 会话验证（review/creditkey），服务端无路；扫码通道也不存在 | — | 维持手填 xlAuth；除非迅雷官方放出网页扫码或免会话验证的登录口，否则不立项 |

### 视频口径速查（functions/api/video.js，改版时对照 MediaGet、ucmao/media-parser、jiuhunwl/short_videos）

- **抖音**：iesdouyin 分享页（移动 UA）→ `window._ROUTER_DATA`（转义形态，提取器已处理去转义）→ `videoInfoRes.item_list[0]`；去水印 `/playwm/`→`/play/` + `ratio=720p`→`1080p`。失效特征：无 `_ROUTER_DATA` 或 item_list 空。
- **快手**：`kuaishou.com/fw/photo/{photoId}`（风控换 `m.gifshow.com`）→ 正则抠 `photoUrl/photoH265Url/caption/coverUrls`。失效特征：落登录页/空壳。
- **微博**：游客票据按 yt-dlp 现行口径（2026-11-09 重做）：`passport.weibo.com/visitor/genvisitor`（POST，`cb=gen_callback` + `fp` 指纹载荷）→ `visitor?a=incarnate`（w/c 按响应 `new_tid`/`confidence` 拼）换全套 Cookie（SUB/SUBP 等，模块缓存 20 分钟）→ 帖子走 `weibo.com/ajax/statuses/show`（必须 `X-Requested-With`）→ `page_info.media_info.playback_list`（过滤 `meta.type=3` 预览图）；fid 走 `tv/api/component`：body 为 `data={"Component_Play_Playinfo":{"oid":…}}`（字段名是 data、不做 URL 编码）、Referer 用专页地址，组件只取 `mid` 再走帖子接口（comp.urls 仅作旧形状兼容）；ajax/组件回 HTML（被跳 passport）时强制刷新票据重试一次；降级 `m.weibo.cn/statuses/show`。失效特征：返回 HTML = 票据失效或丢请求头。旧口径（genvisitor 无 fp、incarnate 写死 w=2&c=095、组件 body 拿组件名当字段名）曾致 fid 路线全灭，勿回退。
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
2. **可用性探针**（真样本、拉字节）：看门狗 probe_usability——抖音/快手/微博/AcFun 用固定公开样本真解析后 Range 拉字节（微博按结果自带的 needReferer 拉）、AcFun 拉清单+首分片；阿里用公开样本验匿名 token→列目录链（取链需凭证，止于列表层）。样本失效与口径变了都会报，靠每日巡检（助理侧）分辨并更换样本。（2026-11-09 补）样本按「链接形态/路线」覆盖而非只按平台：微博帖子链与专页 fid 链是两条不同路线，此前样本只有帖子链老帖，专页路线全灭数日未被发现；现微博双样本（帖子链 + 专页链），新增路线上线须同步加样本。
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
