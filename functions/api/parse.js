// YM 网盘解析 · Pages Functions 解析层
// 口径：只用访客自己账号的凭证调用各网盘官方/网页接口，只返回直链，绝不中转文件流量。
// POST /api/parse {drive, action:'list'|'download', url, pwd, cred:{}, ctx:{}, file:{}}
// GET  /api/parse → 服务信息与支持列表
// 凭证优先级：请求自带（页面存在访客浏览器里） > 环境变量兜底（部署者可选配）

const UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DRIVES = {
  baidu:    { name: '百度网盘', tier: 1 },
  aliyun:   { name: '阿里云盘', tier: 1 },
  quark:    { name: '夸克网盘', tier: 1 },
  uc:       { name: 'UC 网盘', tier: 1 },
  lanzou:   { name: '蓝奏云', tier: 1 },
  cmcc:     { name: '移动云盘', tier: 2 },
  ctyun:    { name: '天翼云盘', tier: 2 },
  feijipan: { name: '小飞机网盘', tier: 2 },
  pan123:   { name: '123 云盘', tier: 2 },
  xunlei:   { name: '迅雷云盘', tier: 2 },
  guangya:  { name: '光鸭云盘', tier: 2 }, // 实验：设备码扫码授权 + 分享接口（口径对照 JxPan）
};

/* ==== CONFIG:BEGIN 易变参数区（看门狗/维护者只改这里的值，不动下面的逻辑）====
   lanzouMirrors：蓝奏官方等价域名，失效的会被看门狗摘掉、活的排前面；
   pan123Bases：123 的两条接口路线，按顺序尝试，第一条通就用第一条。 */
const CONFIG = {
  lanzouMirrors: ['lanzoui.com', 'lanzoux.com', 'lanzouo.com', 'lanzouq.com', 'lanzoup.com', 'lanzouh.com'],
  pan123Bases: ['https://www.123pan.cn/b/api', 'https://www.123pan.com/api'],
};
/* ==== CONFIG:END ==== */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const ok = (extra) => json({ ok: true, ...extra });
const fail = (error, extra) => json({ ok: false, error, ...extra });

class Jar {
  constructor(init = '') {
    this.map = new Map();
    if (init) for (const part of init.split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) this.map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  absorb(resp) {
    let list = [];
    try { list = resp.headers.getSetCookie ? resp.headers.getSetCookie() : []; } catch (e) {}
    if (!list.length) {
      const sc = resp.headers.get('set-cookie');
      if (sc) list = sc.split(/,(?=[^;,= ]+=)/);
    }
    for (const s of list) {
      const main = s.split(';')[0];
      const i = main.indexOf('=');
      if (i > 0) this.map.set(main.slice(0, i).trim(), main.slice(i + 1).trim());
    }
  }
  get(k) { return this.map.get(k); }
  str() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function req(url, { method = 'GET', headers = {}, body, jar, redirect = 'follow', ua = UA_PC } = {}) {
  const h = { 'User-Agent': ua, ...headers };
  if (jar) h['Cookie'] = jar.str();
  const resp = await fetch(url, { method, headers: h, body, redirect });
  if (jar) jar.absorb(resp);
  return resp;
}
async function reqJson(url, opts = {}) {
  const resp = await req(url, opts);
  const text = await resp.text();
  try { return { resp, data: JSON.parse(text), text }; }
  catch (e) { return { resp, data: null, text }; }
}
const form = (obj) => new URLSearchParams(obj).toString();
function fmtErr(prefix, data, map = {}) {
  const code = data && (data.errno !== undefined ? data.errno : data.code !== undefined ? data.code : data.error_code);
  if (code !== undefined && map[code]) return `${prefix}：${map[code]}`;
  const msg = data && (data.errmsg || data.message || data.msg || data.error_description || data.show_msg);
  return `${prefix}${code !== undefined ? `（错误 ${code}）` : ''}${msg ? `：${msg}` : ''}`;
}

/* ================= 百度网盘 =================
   流程（对照 baiduwp / LinkSwift 口径）：GET 分享页拿 PANPSC 与 sign/timestamp/uk/shareid
   → POST share/verify 验提取码得 randsk(BDCLND) → share/list 列目录
   → POST api/sharedownload 取 dlink。只需 BDUSS；STOKEN 非必需。 */
const bd = {
  cred(cred, env) {
    const bduss = (cred.bduss || env.BDUSS || '').trim();
    if (!bduss) throw new Error('未填百度 BDUSS：请在「凭证」里粘贴你自己百度账号的 BDUSS（只存你浏览器）');
    const jar = new Jar(`BDUSS=${bduss}` + (cred.stoken ? `; STOKEN=${cred.stoken.trim()}` : ''));
    return jar;
  },
  surl(url) {
    let m = url.match(/pan\.baidu\.com\/s\/1([A-Za-z0-9_-]+)/) || url.match(/pan\.baidu\.com\/s\/([A-Za-z0-9_-]+)/)
      || url.match(/[?&]surl=([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('没认出百度分享链接（应是 pan.baidu.com/s/…）');
    return m[1];
  },
  async open(url, pwd, cred, env) {
    const surl = bd.surl(url);
    const jar = bd.cred(cred, env);
    const page = await req(`https://pan.baidu.com/s/1${surl}`, { jar });
    const html = await page.text();
    const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };
    const meta = {
      surl,
      uk: pick(/"share_uk":(\d+)/) || pick(/"uk":(\d+)/),
      shareid: pick(/"shareid":(\d+)/),
      sign: pick(/"sign":"([^"]+)"/),
      timestamp: pick(/"timestamp":(\d+)/),
    };
    if (!meta.shareid) throw new Error('分享页没读到 shareid：链接失效、被取消，或百度改版了分享页结构');
    const v = await reqJson(`https://pan.baidu.com/share/verify?surl=${surl}&channel=chunlei&web=1&app_id=250528&clienttype=0`, {
      method: 'POST', jar,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `https://pan.baidu.com/s/1${surl}` },
      body: form({ pwd: pwd || '', vcode: '', vcode_str: '' }),
    });
    if (!v.data || v.data.errno !== 0) {
      throw new Error(fmtErr('提取码验证失败', v.data, {
        '-9': '提取码不正确', '-12': '验证被拒（页面校验未过），请稍后重试',
        '-62': '触发百度验证码，稍后再试或换网络', '105': '分享不存在或已取消',
      }));
    }
    const randsk = jar.get('BDCLND');
    if (!randsk) throw new Error('验证通过但没拿到 randsk（BDCLND），百度流程有变');
    meta.randsk = decodeURIComponent(randsk);
    meta.jar = jar.str();
    return meta;
  },
  async list(url, pwd, cred, env, ctx) {
    let meta = ctx && ctx.shareid ? ctx : null;
    let dir = (ctx && ctx.dir) || '/';
    if (!meta) { meta = await bd.open(url, pwd, cred, env); dir = '/'; }
    const jar = new Jar(meta.jar);
    const api = `https://pan.baidu.com/share/list?app_id=250528&channel=chunlei&clienttype=0&web=1`
      + `&uk=${meta.uk}&shareid=${meta.shareid}&order=other&desc=1&showempty=0&page=1&num=100`
      + `&dir=${encodeURIComponent(dir)}&sekey=${encodeURIComponent(meta.randsk)}`;
    const r = await reqJson(api, { jar, headers: { Referer: 'https://pan.baidu.com/' } });
    if (!r.data || r.data.errno !== 0) throw new Error(fmtErr('列目录失败', r.data, { '-9': '目录不存在或凭证失效' }));
    const files = (r.data.list || []).map(f => ({
      id: String(f.fs_id), name: f.server_filename, size: f.size || 0,
      dir: f.isdir === 1 || f.isdir === '1', path: f.path,
    }));
    return { ctx: { ...meta, dir }, files, path: dir };
  },
  async download(cred, env, ctx, file) {
    if (!ctx || !ctx.shareid) throw new Error('会话已过期，请重新解析一次');
    const jar = new Jar(ctx.jar);
    const r = await reqJson(`https://pan.baidu.com/api/sharedownload?app_id=250528&channel=chunlei&clienttype=12&web=1&sign=${ctx.sign}&timestamp=${ctx.timestamp}`, {
      method: 'POST', jar,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://pan.baidu.com/' },
      body: form({
        encrypt: '0', extra: JSON.stringify({ sekey: ctx.randsk }),
        fid_list: `[${file.id}]`, primaryid: ctx.shareid, uk: ctx.uk, product: 'share', type: 'nolimit',
      }),
    });
    if (!r.data || r.data.errno !== 0 || !r.data.list || !r.data.list[0] || !r.data.list[0].dlink) {
      throw new Error(fmtErr('取直链失败', r.data, {
        '9013': '今日解析量触发百度风控（约 200–300GB 上限），明天再试',
        '8001': '需要先转存才能下载（文件受限）', '31390': '触发百度风控，请稍后再试',
        '-21': '签名过期，请重新解析一次',
      }));
    }
    return {
      url: r.data.list[0].dlink, name: file.name,
      headers: { 'User-Agent': 'netdisk;P2SP;2.2.60.26', Cookie: `BDUSS=${(cred.bduss || env.BDUSS || '').trim()}` },
      note: '百度直链必须带下面的 UA 和你的 BDUSS Cookie 才能下载：复制到 1DM+/ADM 时把请求头一起填上，或用 aria2 命令。链接约 8 小时有效。',
    };
  },
};

/* ================= 阿里云盘 =================
   分享：get_share_token（匿名+提取码）→ list_by_share → get_share_link_download_url。
   填了自己的 Authorization 时一并带上（更稳、少限流）。 */
const ali = {
  id(url) {
    const m = url.match(/(?:aliyundrive|alipan)\.com\/s\/([A-Za-z0-9]+)/);
    if (!m) throw new Error('没认出阿里分享链接（应是 aliyundrive.com/s/… 或 alipan.com/s/…）');
    return m[1];
  },
  headers(cred, token) {
    const h = { 'Content-Type': 'application/json', Referer: 'https://www.aliyundrive.com/', Origin: 'https://www.aliyundrive.com' };
    if (token) h['x-share-token'] = token;
    if (cred.aliAuth) h['Authorization'] = cred.aliAuth.trim().startsWith('Bearer') ? cred.aliAuth.trim() : `Bearer ${cred.aliAuth.trim()}`;
    return h;
  },
  // 有刷新令牌（扫码登录存的）时，先换一张新鲜的访问令牌再干活，并回写新令牌
  async auth(cred) {
    if (!cred.aliRefresh) return { cred, upd: null };
    try {
      const tj = await reqJson('https://open.aliyundrive.com/oauth/access_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: '25dzX3vbYqktVxyX', grant_type: 'refresh_token', refresh_token: cred.aliRefresh }),
      });
      if (tj.data && tj.data.access_token) {
        const fields = { aliAuth: tj.data.access_token };
        if (tj.data.refresh_token) fields.aliRefresh = tj.data.refresh_token;
        return { cred: { ...cred, aliAuth: tj.data.access_token }, upd: { fields } };
      }
    } catch { /* 换失败就用现存的 aliAuth 兜底 */ }
    return { cred, upd: null };
  },
  async list(url, pwd, cred, env, ctx) {
    const { cred: ec, upd } = await ali.auth(cred);
    const shareId = (ctx && ctx.shareId) || ali.id(url);
    let token = ctx && ctx.token;
    if (!token) {
      const t = await reqJson('https://api.aliyundrive.com/v2/share_link/get_share_token', {
        method: 'POST', headers: ali.headers(ec), body: JSON.stringify({ share_id: shareId, share_pwd: pwd || '' }),
      });
      if (!t.data || !t.data.share_token) throw new Error(fmtErr('获取分享令牌失败', t.data, { '400': '提取码不正确或分享已取消' }));
      token = t.data.share_token;
    }
    const parent = (ctx && ctx.dir) || 'root';
    const r = await reqJson('https://api.aliyundrive.com/adrive/v2/file/list_by_share', {
      method: 'POST', headers: ali.headers(ec, token),
      body: JSON.stringify({ share_id: shareId, parent_file_id: parent, limit: 100, order_by: 'name', order_direction: 'ASC' }),
    });
    if (!r.data || !Array.isArray(r.data.items)) throw new Error(fmtErr('列目录失败', r.data));
    const files = r.data.items.map(f => ({
      id: f.file_id, name: f.name, size: f.size || 0, dir: f.type === 'folder',
    }));
    return { ctx: { shareId, token, dir: parent }, files, path: parent === 'root' ? '/' : parent, ...(upd ? { credUpdate: upd } : {}) };
  },
  async download(cred, env, ctx, file) {
    if (!ctx || !ctx.token) throw new Error('会话已过期，请重新解析一次');
    const { cred: ec, upd } = await ali.auth(cred);
    const r = await reqJson('https://api.aliyundrive.com/v2/file/get_share_link_download_url', {
      method: 'POST', headers: ali.headers(ec, ctx.token),
      body: JSON.stringify({ share_id: ctx.shareId, file_id: file.id, expire_sec: 14400 }),
    });
    if (!r.data || !r.data.download_url) {
      if (!ec.aliAuth && !cred.aliRefresh) throw new Error('阿里现在要求登录才能取下载直链，匿名只能看目录。请在下方「② 我的凭证」里用扫码登录阿里（推荐）或填上你的 Authorization，再点取链。');
      throw new Error(fmtErr('取直链失败', r.data));
    }
    return {
      url: r.data.download_url, name: file.name,
      headers: { Referer: 'https://www.aliyundrive.com/' },
      note: '阿里直链带 Referer 校验：下载器里把 Referer 填上即可；链接有效期较短（约几小时），过期重新解析。',
      ...(upd ? { credUpdate: upd } : {}),
    };
  },
};

/* ================= 夸克 / UC（同系双网关） =================
   流程：sharepage/token 拿 stoken → sharepage/detail 列目录
   → 小文件直接 file/download；大文件先 sharepage/save 转存到自己盘再取链。
   凭证 = 整段 Cookie；夸克 __puus 会轮换，响应里回吐新 Cookie 让页面自动回写（自动更新）。 */
function quarkFamily(host, pr, label) {
  const base = `https://${host}/1/clouddrive`;
  // __dt/__t 必须每次请求新鲜生成：老实现模块加载时算一次终身复用，属可疑暗病（2026-11-10 对照现行实现修正）
  const qNow = () => `pr=${pr}&fr=pc&uc_param_str=&__dt=${600 + Math.floor(Math.random() * 9000)}&__t=${Date.now()}`;
  const q = qNow();
  function cookieOf(cred, env) {
    const c = (cred.cookie || env.CRED_COOKIE || '').trim();
    if (!c) throw new Error(`未填${label} Cookie：请在「凭证」里粘贴你自己${label}账号的整段 Cookie（只存你浏览器）`);
    return c;
  }
  async function call(path, { method = 'GET', body, cred, env, jar } = {}) {
    const j = jar || new Jar(cookieOf(cred, env));
    const r = await reqJson(`${base}${path}?${qNow()}`, {
      method, jar: j,
      headers: { 'Content-Type': 'application/json', Referer: `https://${host.split('/')[0]}/`, Origin: `https://${host.split('/')[0]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { r, jar: j };
  }
  return {
    id(url) {
      const m = url.match(/\/s\/([A-Za-z0-9]+)/);
      if (!m) throw new Error(`没认出${label}分享链接`);
      return m[1];
    },
    async list(url, pwd, cred, env, ctx) {
      const pwdId = (ctx && ctx.pwdId) || this.id(url);
      let stoken = ctx && ctx.stoken;
      const jar = new Jar(cookieOf(cred, env));
      if (!stoken) {
        const t = await reqJson(`${base}/share/sharepage/token?${qNow()}`, {
          method: 'POST', jar,
          headers: { 'Content-Type': 'application/json', Referer: `https://${host.split('/')[0]}/` },
          body: JSON.stringify({ pwd_id: pwdId, passcode: pwd || '' }),
        });
        if (!t.data || t.data.status !== 200 || !t.data.data || !t.data.data.stoken) {
          throw new Error(fmtErr('获取分享令牌失败', t.data, { 41007: '提取码不正确' }));
        }
        stoken = t.data.data.stoken;
      }
      const pdir = (ctx && ctx.dir) || '0';
      const u = `${base}/share/sharepage/detail?${qNow()}&pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=${pdir}&force=0&_page=1&_size=100&_sort=file_type:asc,file_name:asc`;
      const rr = await reqJson(u, { jar, headers: { Referer: `https://${host.split('/')[0]}/` } });
      if (!rr.data || rr.data.status !== 200 || !rr.data.data) throw new Error(fmtErr('列目录失败', rr.data));
      const list = rr.data.data.list || [];
      const files = list.map(f => ({
        id: f.fid, name: f.file_name, size: f.size || 0, dir: !!f.dir,
        token: f.share_fid_token || '',
      }));
      return { ctx: { pwdId, stoken, dir: pdir, cookie: jar.str() }, files, path: pdir === '0' ? '/' : pdir, credUpdate: { cookie: jar.str() } };
    },
    async download(cred, env, ctx, file) {
      if (!ctx || !ctx.stoken) throw new Error('会话已过期，请重新解析一次');
      // file/download 必须带官方 PC 客户端 UA（LinkSwift/kownload 同口径，2026-11-11 00:29 巡检实证）：
      // 网页 UA 会被当游客档，大文件恒回 23018 大小限制；客户端 UA + 登录 Cookie 直取 96MB 文件成功、拉字节 206。
      const DL_UA = host.includes('quark')
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
      const dlCall = async (jarOrNull, body) => {
        const r = await reqJson(`${base}/file/download?${qNow()}`, {
          method: 'POST', ...(jarOrNull ? { jar: jarOrNull } : {}),
          headers: { 'Content-Type': 'application/json', Referer: `https://${host.split('/')[0]}/`, 'User-Agent': DL_UA },
          body: JSON.stringify(body),
        });
        if (r.data && r.data.status === 200 && r.data.data && r.data.data[0] && r.data.data[0].download_url) return r.data.data[0].download_url;
        throw Object.assign(new Error(fmtErr('取直链失败', r.data, { '23018': '文件超出大小限制（游客约 50MB；已登录仍被限多为账号会员档限制，建议用官方 App/客户端打开这个文件）' })), { raw: r.data });
      };
      // 路线 A（2026-11-10 新增，YunX 实测）：游客免转存——不带登录 Cookie，body 带 pwd_id/stoken，
      // 小文件（夸克约 ≤50MB，风控浮动）直接出链，不占自己网盘空间
      try {
        const url = await dlCall(null, { fids: [file.id], fids_token: file.token ? [file.token] : [], pwd_id: ctx.pwdId, stoken: ctx.stoken });
        return { url, name: file.name, headers: { 'User-Agent': DL_UA }, note: `${label}游客直链（免转存），有时效，过期重新解析。` };
      } catch { /* 游客路线不通（多为大文件 23018），回落登录路线 */ }
      const jar = new Jar(ctx.cookie || cookieOf(cred, env));
      const dl = (fid, fidToken) => dlCall(jar, { fids: [fid], fids_token: fidToken ? [fidToken] : [], pwd_id: ctx.pwdId, stoken: ctx.stoken });
      let url;
      try {
        url = await dl(file.id, file.token);
      } catch (e) {
        // 大文件直取失败 → 转存到自己盘根目录后取链
        const save = await reqJson(`${base}/share/sharepage/save?${qNow()}`, {
          method: 'POST', jar,
          headers: { 'Content-Type': 'application/json', Referer: `https://${host.split('/')[0]}/` },
          body: JSON.stringify({ fid_list: [file.id], fid_token_list: file.token ? [file.token] : [], to_pdir_fid: '0', pwd_id: ctx.pwdId, stoken: ctx.stoken, pdir_fid: '0', scene: 'link' }),
        });
        if (!save.data || save.data.status !== 200 || !save.data.data || !save.data.data.task_id) {
          throw new Error(`${e.message}；转存也失败：${fmtErr('', save.data)}（可能未登录、空间不足或文件违规）`);
        }
        const taskId = save.data.data.task_id;
        // 必须轮询到 status==2（完成）才取新 fid：老实现一见 save_as 就取，
        // 转存没真正完成时取链回空 download_url（2026-11-10 真测个案的头号嫌疑）
        let savedFid = '';
        for (let i = 0; i < 15 && !savedFid; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const t = await reqJson(`${base}/task?${qNow()}&task_id=${taskId}&retry_index=${i}`, { jar, headers: { Referer: `https://${host.split('/')[0]}/` } });
          const td = t.data && t.data.data;
          if (!td) continue;
          if (td.status === 3) throw new Error('转存失败（上游任务报错，多为账号空间不足或文件违规）');
          if (td.status === 2 && td.save_as && td.save_as.save_as_top_fids && td.save_as.save_as_top_fids[0]) {
            savedFid = td.save_as.save_as_top_fids[0];
          }
        }
        if (!savedFid) throw new Error('转存超时：文件可能较大，请到夸克/UC 里确认是否已存入后重试');
        // 转存件已是自己盘里的文件：取链 body 只能有 fids（现行实现口径）；
        // 带 pwd_id/stoken/fids_token 会被上游拒——这是「转存成功但取链失败」的另一嫌疑（2026-11-10 复测后修正）
        url = await dlCall(jar, { fids: [savedFid] });
      }
      return {
        url, name: file.name,
        headers: { Cookie: jar.str(), 'User-Agent': DL_UA },
        note: `${label}直链要带你的 Cookie 和客户端 UA 才能下载（下方「链接+请求头」已配好，整段复制到下载器）。转存过的文件会留在你自己网盘根目录，可自行删除。`,
        credUpdate: { cookie: jar.str() },
      };
    },
  };
}
const quark = quarkFamily('drive-pc.quark.cn', 'ucpro', '夸克');
const uc = quarkFamily('pc-api.uc.cn', 'UCBrowser', 'UC');

/* ================= 蓝奏云（免登录 · 多域名互备） =================
   老流程：分享页 → iframe(/fn/ 或 /tp/) 子页拿 sign → POST ajaxm.php?action=downprocess。
   蓝奏官方有多个等价域名，主域被挑战/被墙时同码换域名重试（天然多路由）。
   2026 起部分页面带 acw_sc__v2 JS 挑战，纯接口可能被拦——失败即如实报错。 */
const LANZOU_MIRRORS = CONFIG.lanzouMirrors;
const lz = {
  hosts(url) {
    const m = url.match(/([A-Za-z0-9-]+)\.(lanzou[a-z]?\.com|ilanzou\.com|lanzoui\.com)/i);
    const code = (url.match(/\/([A-Za-z0-9_-]{5,})(?:[?#]|$)/) || [])[1];
    if (!code) throw new Error('没认出蓝奏分享链接');
    const seen = new Set(); const list = [];
    const fm = url.match(/^https:\/\/([A-Za-z0-9.-]+)/);
    const first = fm ? fm[1] : null; // 非 https 输入不再抛 TypeError，退回镜像域名轮试
    for (const h of [first, ...LANZOU_MIRRORS.map(d => (m ? m[1] + '.' : 'ww') + d), ...LANZOU_MIRRORS.map(d => 'ww.' + d)]) {
      if (h && !seen.has(h)) { seen.add(h); list.push(h); }
    }
    return { code, hosts: list };
  },
  async list(url) {
    const { code, hosts } = lz.hosts(url);
    let lastErr = null;
    for (const host of hosts.slice(0, 5)) {
      try {
        const pageUrl = `https://${host}/${code}`;
        const r1 = await req(pageUrl, { headers: { Referer: `https://${host}/` } });
        const html = await r1.text();
        if (/acw_sc__v2|arg1=/.test(html) && !/iframe/i.test(html)) throw new Error('蓝奏触发了 JS 人机挑战（acw_sc__v2），纯接口过不了');
        if (/文件不存在|分享已取消|链接已失效/.test(html)) throw new Error('分享不存在或已取消');
        const fn = html.match(/src="(\/fn\?[^"]+|\/tp\/[^"]+)"/) || html.match(/(?:iframe[^>]*src=)["']([^"']+)["']/);
        let sign = '', ajaxdata = '', fileId = code;
        // ajaxm 的 file 参数要的是主页里的数字 fid，不是分享代码（2026-11-10 真测定位）
        const fidM = html.match(/var\s+fid\s*=\s*(\d+)/);
        if (fidM) fileId = fidM[1];
        if (fn) {
          const sub = fn[1].startsWith('http') ? fn[1] : `https://${host}${fn[1]}`;
          const sm = sub.match(/file=([A-Za-z0-9_-]+)/); if (sm && !fidM) fileId = sm[1];
          const r2 = await req(sub, { headers: { Referer: pageUrl } });
          const h2 = await r2.text();
          // 现行口径：wp_sign + ajaxdata（websignkey/signs），data 里 sign 直接引用 wp_sign 变量
          const wp = h2.match(/wp_sign\s*=\s*'([^']+)'/);
          const ad = h2.match(/ajaxdata\s*=\s*'([^']+)'/);
          if (wp) sign = wp[1];
          if (ad) ajaxdata = ad[1];
          if (!sign) {
            const s = h2.match(/'sign'\s*:\s*'([^']+)'/) || h2.match(/sign\s*=\s*'([^']+)'/) || h2.match(/name="sign"[^>]*value="([^"]+)"/) || h2.match(/data\s*:\s*\{[^}]*sign:'([^']+)'/);
            if (s) sign = s[1];
          }
        }
        if (!sign) {
          const s = html.match(/'sign'\s*:\s*'([^']+)'/) || html.match(/wp_sign\s*=\s*'([^']+)'/);
          if (s) sign = s[1];
        }
        if (!sign) throw new Error('没在页面里找到 sign（蓝奏改版或该链接是文件夹分享）');
        return { single: true, ctx: { host, sign, ajaxdata, fileId }, host };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('蓝奏全域名都解析失败');
  },
  async resolveLink(ctx, pwd) {
    const { host, sign, ajaxdata, fileId } = ctx;
    // 现行口径带 websignkey/signs/ves；旧页面没有 ajaxdata 时退回老字段集
    const fields = ajaxdata
      ? { action: 'downprocess', websignkey: ajaxdata, signs: ajaxdata, sign, websign: '', kd: '1', ves: '1' }
      : { action: 'downprocess', sign, kd: '1' };
    if (pwd) fields.p = pwd;
    else if (!ajaxdata) fields.p = '';
    const H = { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `https://${host}/` };
    // 现行取链端点是独立的 apifile 域（2026-11-10 真测定位：老 ajaxm.php 已改口径、恒回「密码错误」）
    const endpoints = [
      `https://apifile.woozooo.com/ajaxfile.php?file=${fileId}`,
      `https://apifile.lanzouw.com/ajaxfile.php?file=${fileId}`,
      `https://${host}/ajaxm.php?file=${fileId}`,
    ];
    let lastErr = null;
    for (const ep of endpoints) {
      try {
        const r = await reqJson(ep, { method: 'POST', headers: H, body: form(fields) });
        if (r.data && r.data.zt === 1 && r.data.url) {
          return { url: `${r.data.dom}/file/${r.data.url}`, headers: {}, note: '蓝奏单文件上限约 100MB；直链直接交给下载器即可。' };
        }
        lastErr = new Error(fmtErr('蓝奏取链失败', r.data && { code: r.data.zt, message: r.data.inf }));
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('蓝奏取链失败');
  },
};

/* ================= 移动云盘 139 =================
   2026-11-10 按现行规格重写（YunX-Desktop 规格文档 + 调研互证）：
   分享网关 share-kd-njs.yun.139.com 的 IOutLink 系列，请求/响应体须 AES-128-CBC 加密
   （固定 key，body=base64(IV‖密文)，响应同法解密、gzip 魔数先解压，失败回退明文）。
   列目录匿名（不带 Authorization/mcloud 头），靠设备头 + 完整字段集，否则 9530；
   取链不匿名：body 须带完整账号（从 cmccAuth 的 Basic pc:<账号>:<token> 中段解出）+ mcloud-sign。 */
function md5(input) {
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  const bytes = [...new TextEncoder().encode(input)];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) % 256);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) M.push(bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D; D = C; C = B;
      B = (B + rotl((A + F + K[i] + M[g]) | 0, S[i])) | 0; A = tmp;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const hex = n => [0, 8, 16, 24].map(s => ((n >>> s) & 0xff).toString(16).padStart(2, '0')).join('');
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}
const CMCC_AES_KEY = new TextEncoder().encode('PVGDwmcvfs1uV3d1');
const b64FromBytes = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(s); };
const bytesFromB64 = b64 => Uint8Array.from(atob(String(b64).replace(/\s/g, '')), c => c.charCodeAt(0));
async function cmccEncrypt(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', CMCC_AES_KEY, { name: 'AES-CBC' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(plain)));
  const all = new Uint8Array(16 + ct.length); all.set(iv); all.set(ct, 16);
  return b64FromBytes(all);
}
async function cmccDecryptText(text) {
  const t = String(text || '').trim();
  if (t.startsWith('{')) return t;
  const raw = bytesFromB64(t);
  const key = await crypto.subtle.importKey('raw', CMCC_AES_KEY, { name: 'AES-CBC' }, false, ['decrypt']);
  let pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: raw.subarray(0, 16) }, key, raw.subarray(16)));
  if (pt.length > 2 && pt[0] === 0x1f && pt[1] === 0x8b) {
    const stream = new Blob([pt]).stream().pipeThrough(new DecompressionStream('gzip'));
    pt = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new TextDecoder().decode(pt);
}
const CMCC_SHARE_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'hcy-cool-flag': '1',
  'x-deviceinfo': '||3|12.27.0|||||chrome 150.0.0.0|360X444|zh-cn|||',
  'x-huawei-channelsrc': '10245500',
  'x-mm-source': '0002',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  Origin: 'https://yun.139.com', Referer: 'https://yun.139.com/', Accept: 'application/json, text/plain, */*',
};
function cmccSign(plainJson) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const parts = {}; for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  const ts = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  const pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rand = ''; const rb = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) rand += pool[rb[i] % 62];
  const sorted = [...encodeURIComponent(plainJson)].sort().join('');
  const b64 = b64FromBytes(new TextEncoder().encode(sorted));
  const sign = md5(md5(b64) + md5(`${ts}:${rand}`)).toUpperCase();
  return `${ts},${rand},${sign}`;
}
const cmcc = {
  id(url) {
    const m = url.match(/[?&]linkId=([A-Za-z0-9_-]+)/) || url.match(/yun\.139\.com\/shareweb\/.*?\/w\/i\/([A-Za-z0-9_-]+)/) || url.match(/yun\.139\.com\/w\/([A-Za-z0-9_-]+)/) || url.match(/\/i\/([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('没认出移动云盘分享（需带 linkId 的链接，或 yun.139.com/w/…）');
    return m[1];
  },
  async call(path, plainObj, { sign = false, auth = '' } = {}) {
    const plain = JSON.stringify(plainObj);
    const headers = { ...CMCC_SHARE_HEADERS };
    if (sign) headers['mcloud-sign'] = cmccSign(plain);
    if (auth) headers['Authorization'] = auth;
    const res = await fetch(`https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/${path}`, {
      method: 'POST', headers, body: await cmccEncrypt(plain),
    });
    const rawText = await res.text();
    let data = null;
    try { data = JSON.parse(await cmccDecryptText(rawText)); } catch { try { data = JSON.parse(rawText); } catch { /* keep null */ } }
    return data;
  },
  checkOk(d, what, userPwd = true) {
    if (!d) throw new Error(`移动云盘${what}失败（上游没回数据）`);
    const rc = d.resultCode !== undefined && d.resultCode !== null ? String(d.resultCode) : '';
    if (rc && rc !== '0') {
      if (rc === '9188') throw new Error(userPwd ? '移动云盘提取码不正确' : '这个移动分享需要提取码（自动获取没成功），请填上提取码再试');
      if (rc === '200000727') throw new Error('移动云盘分享不存在或已取消');
      if (rc === '9530') throw new Error('移动云盘接口拒绝了请求（字段/设备头不全，属本站适配问题）');
      throw new Error(`移动云盘${what}失败（${d.desc || rc}）`);
    }
    if (d.success === false) throw new Error(`移动云盘${what}失败（${d.desc || '上游拒绝'}）`);
    return d.data || {};
  },
  account(cred) {
    const auth = (cred && cred.cmccAuth || '').trim();
    const m = auth.match(/^Basic\s+(.+)$/i);
    if (!m) return '';
    try {
      const dec = atob(m[1].replace(/\s/g, ''));
      const parts = dec.split(':');
      return parts.length >= 3 ? parts[1] : '';
    } catch { return ''; }
  },
  async general(linkId) {
    try {
      const d = await cmcc.call('getOutLinkGeneral', { getOutLinkGeneralReq: { linkID: linkId, isPasswd: 1, account: '' } });
      const data = cmcc.checkOk(d, '读取分享信息');
      const g = data.getOutLinkGeneralResp && data.getOutLinkGeneralResp.outLinkGeneral && data.getOutLinkGeneralResp.outLinkGeneral[0];
      return g ? { title: g.lkName || '', passwd: g.passwd || '' } : {};
    } catch { return {}; }
  },
  async list(url, pwd, cred, ctx) {
    const linkId = (ctx && ctx.linkId) || cmcc.id(url);
    const userPwd = !!(pwd || (ctx && ctx.passwd));
    let passwd = pwd || (ctx && ctx.passwd) || '';
    let title = '';
    if (!passwd && !(ctx && ctx.dir)) {
      const g = await cmcc.general(linkId);
      title = g.title || ''; passwd = g.passwd || '';
    }
    const pCaID = (ctx && ctx.dir) ? String(ctx.dir) : 'root';
    const files = [];
    for (let begin = 1; begin <= 20000; begin += 200) {
      const d = await cmcc.call('getOutLinkInfoV6', { getOutLinkInfoReq: { account: '', linkID: linkId, passwd, caSrt: 1, coSrt: 1, srtDr: 0, bNum: begin, pCaID, eNum: begin + 199 } });
      const data = cmcc.checkOk(d, '列目录', userPwd);
      const ca = Array.isArray(data.caLst) ? data.caLst : [];
      const co = Array.isArray(data.coLst) ? data.coLst : [];
      for (const f of ca) files.push({ id: String(f.caID || ''), name: f.caName || '', size: 0, dir: true });
      for (const f of co) files.push({ id: String(f.coID || ''), name: f.coName || '', size: f.coSize || 0, dir: f.isdir === true || f.coType === 2 });
      if (ca.length + co.length < 200) break;
    }
    return { ctx: { linkId, passwd }, files, path: '/', route: '分享网关·加密口径', title };
  },
  async download(cred, env, ctx, file) {
    const account = cmcc.account(cred);
    if (!account) throw new Error('移动云盘取链需要先登录：在「存凭证」里扫码登录移动云盘（或填 Authorization），账号会随凭证一起用来取链；只列目录不需要登录');
    const d = await cmcc.call('dlFromOutLinkV3', { dlFromOutLinkReqV3: { account, linkID: ctx.linkId, coIDLst: { item: [String(file.id)] }, commonAccountInfo: { account, accountType: 1 } } }, { sign: true, auth: (cred.cmccAuth || '').trim() });
    const data = (d && d.data) || {};
    const url = data.redrUrl || data.presentURL || data.downloadUrl || '';
    if (!url) {
      const rc = d && d.resultCode !== undefined ? String(d.resultCode) : '';
      throw new Error(`移动云盘取链失败${rc ? `（${(d && d.desc) || rc}）` : ''}`);
    }
    return { url, name: file.name, headers: {}, note: '移动云盘直链约 15 分钟有效，过期重新解析。' };
  },
};

/* ================= 天翼云盘（实验） =================
   接口口径：cloud.189.cn open/share 系列（getShareInfoByCodeV2 / checkAccessCode / getFileDownloadUrl）。
   下载一步通常要求登录态：凭证里可填天翼 Cookie。 */
/* 天翼口径 2026-11-10 按现行实现重写（油猴 555404 源码实证）：
   getShareInfoByCodeV2 须带签名头四件套（Signature=MD5(参数+Timestamp+AppKey 字典序 k=v 拼接)）；
   列目录走 listShareDir（不签名，靠 Referer + 分享 Cookie）；响应大整数 id 先包字符串防精度丢失。 */
const CT_APPKEY = '600100422';
function ctSign(params) {
  const s = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return md5(s);
}
function ctParse(text) {
  const t = String(text || '');
  if (t.trim().startsWith('<')) {
    const tag = n => { const m = t.match(new RegExp(`<${n}>([^<]*)</${n}>`, 'i')); return m ? m[1] : ''; };
    return { res_code: parseInt(tag('res_code') || '0', 10), res_message: tag('res_message'), shareId: tag('shareId'), fileId: tag('fileId'), shareMode: tag('shareMode') || '0', fileName: tag('fileName'), isFolder: tag('isFolder') === 'true', _xml: true };
  }
  const fixed = t.replace(/"(id|fileId|parentId|shareId)":"?(\d{15,})"?/g, '"$1":"$2"');
  return JSON.parse(fixed);
}
const ctyun = {
  code(url) {
    const m = url.match(/[?&]code=([A-Za-z0-9]+)/) || url.match(/cloud\.189\.cn\/t\/([A-Za-z0-9]+)/) || url.match(/cloud\.189\.cn\/web\/share\?code=([A-Za-z0-9]+)/);
    if (!m) throw new Error('没认出天翼分享链接（应是 cloud.189.cn/t/… 或带 code= 的链接）');
    return m[1];
  },
  async list(url, pwd, cred, ctx) {
    const code = (ctx && ctx.code) || ctyun.code(url);
    const accessCode = pwd || (ctx && ctx.accessCode) || '';
    let shareId = (ctx && ctx.shareId) || '';
    let shareMode = (ctx && ctx.shareMode) || '0';
    let rootId = (ctx && ctx.rootId) || '';
    let shareFileName = '';
    if (!ctx || !ctx.dir) {
      if (accessCode) {
        try {
          const chk = await req(`https://cloud.189.cn/api/open/share/checkAccessCode.action?shareCode=${encodeURIComponent(code)}&accessCode=${encodeURIComponent(accessCode)}`, { headers: { Accept: 'application/json;charset=UTF-8', Referer: 'https://cloud.189.cn/web/main/' } });
          const cd = ctParse(await chk.text());
          if (cd && cd.shareId) shareId = String(cd.shareId);
        } catch { /* 验码失败不致命，下一步签名接口会再判 */ }
      }
      const ts = String(Date.now());
      const params = { shareCode: code, accessCode };
      const sig = ctSign({ ...params, Timestamp: ts, AppKey: CT_APPKEY });
      const infoRes = await req(`https://cloud.189.cn/api/open/share/getShareInfoByCodeV2.action?${new URLSearchParams(params)}`, {
        headers: { Accept: 'application/json;charset=UTF-8', 'Sign-Type': '1', Signature: sig, Timestamp: ts, AppKey: CT_APPKEY, Referer: 'https://cloud.189.cn/web/main/' },
      });
      const infoText = await infoRes.text();
      if (!infoText || !infoText.trim()) throw new Error('天翼分享接口回了空响应（多半是该分享需要登录后查看，或分享已失效）');
      let info;
      try { info = ctParse(infoText); } catch { throw new Error('天翼分享信息解析失败（接口返回格式异常）'); }
      if (!info || info.res_code !== 0) {
        if (info && info.res_code === 40401 && !accessCode) throw new Error('这个天翼分享需要访问码，请补上提取码');
        if (info && (info.res_code === 'ShareInfoNotFound' || info.res_code === 'ShareNotFound' || info.res_code === -1 || info.res_code === '-1')) throw new Error('天翼分享不存在或已取消');
        if (info && info.res_code === 'ShareExpiredError') throw new Error('天翼分享已过期');
        if (info && info.res_code === 'needAccessCode') throw new Error('这个天翼分享需要访问码，请补上提取码');
        throw new Error(`天翼列目录失败${info && info.res_message ? `：${info.res_message}` : `（res_code ${info && info.res_code}）`}`);
      }
      shareId = String(info.shareId || shareId || '');
      shareMode = String(info.shareMode || '0');
      rootId = String(info.fileId || '');
      shareFileName = info.fileName || '';
      var infoIsFolder = info.isFolder;
    }
    const dirId = (ctx && ctx.dir) || rootId;
    const files = [];
    for (let page = 1; page <= 50; page++) {
      const params = {
        pageNum: String(page), pageSize: '100', fileId: String(dirId), shareDirFileId: String(dirId),
        isFolder: 'true', shareId: String(shareId), shareMode: String(shareMode), iconOption: '5',
        orderBy: 'lastOpTime', descending: 'true', accessCode,
      };
      const headers = { Accept: 'application/json;charset=UTF-8', Referer: 'https://cloud.189.cn/web/main/' };
      const cookieParts = [];
      if (code && accessCode) cookieParts.push(`share_${code}=${accessCode}`);
      if (cred.ctCookie) cookieParts.push(cred.ctCookie.trim());
      if (cookieParts.length) headers['Cookie'] = cookieParts.join('; ');
      const r = await req(`https://cloud.189.cn/api/open/share/listShareDir.action?${new URLSearchParams(params)}`, { headers });
      const text = await r.text();
      let data = null;
      try { data = ctParse(text); } catch { break; }
      if (!data || data.res_code !== 0) {
        if (page === 1 && files.length === 0) {
          if (data && data.res_code === 'FileNotFound') break; // 单文件分享会走到这，靠下面的兜底
          throw new Error(`天翼列目录失败${data && data.res_message ? `：${data.res_message}` : ''}`);
        }
        break;
      }
      const ao = data.fileListAO || {};
      const fl = Array.isArray(ao.fileList) ? ao.fileList : [];
      const fo = Array.isArray(ao.folderList) ? ao.folderList : [];
      for (const f of fo) files.push({ id: String(f.id), name: f.name, size: 0, dir: true });
      for (const f of fl) files.push({ id: String(f.id), name: f.name, size: f.size || 0, dir: false });
      if (fl.length + fo.length < 100) break;
    }
    if (!files.length && shareFileName && rootId && !infoIsFolder) {
      files.push({ id: String(rootId), name: shareFileName, size: 0, dir: false });
    }
    return { ctx: { code, accessCode, shareId, shareMode, rootId }, files, path: '/', route: '签名口径' };
  },
  async download(cred, env, ctx, file) {
    const jar = new Jar(cred.ctCookie || '');
    const r = await reqJson(`https://cloud.189.cn/api/open/file/getFileDownloadUrl.action?noCache=${Math.random()}&fileId=${file.id}`, { jar, headers: { Referer: 'https://cloud.189.cn/web/main/' } });
    const url = r.data && (r.data.fileDownloadUrl || (r.data.data && r.data.data.fileDownloadUrl));
    if (!url) throw new Error(fmtErr('天翼取链失败', r.data) + '（天翼下载多半要求登录态：请在凭证里填天翼 Cookie 后重试）');
    return { url, name: file.name, headers: { Cookie: cred.ctCookie || '' }, note: '天翼直链有时效，且可能校验 Cookie。' };
  },
};

/* ================= 小飞机网盘（实验） =================
   现行口径（2026-11-10 全量真测后改版）：旧 /ws/share/list 已被上游废弃
   （key/shareId/shareKey 三种参数名都回「分享id不能为空」），改走分享页同款
   recommend/list + file/redirect 签名流（开源实现 fjp-down 验证）：
   timestamp/downloadId/auth 均为 AES-128-ECB（key=dingHao-disk-app）大写 hex，
   逐块 CBC 零 IV 取首块（与 qrlogin.js 的 aesEcbBytes 同法）。
   旧 share/list 保留为兜底路线（文件夹导航只剩这条）。 */
async function fjAesEcbBytes(keyStr, plainBytes) {
  const keyBytes = new TextEncoder().encode(keyStr);
  const padLen = 16 - (plainBytes.length % 16);
  const padded = new Uint8Array(plainBytes.length + padLen);
  padded.set(plainBytes); padded.fill(padLen, plainBytes.length);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
  const iv = new Uint8Array(16);
  const out = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, padded.subarray(off, off + 16));
    out.set(new Uint8Array(enc, 0, 16), off);
  }
  return out;
}
const fjAesHex = async plain => [...(await fjAesEcbBytes('dingHao-disk-app', new TextEncoder().encode(plain)))].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
function fjUuid() {
  const chars = [];
  const bytes = new Uint8Array(21);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 21; i++) {
    const b = bytes[i] & 0x3f;
    if (b < 36) chars.push('0123456789abcdefghijklmnopqrstuvwxyz'[b]);
    else if (b < 62) chars.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ'[b - 36]);
    else if (b > 62) chars.push('-');
    else chars.push('_');
  }
  return chars.join('');
}
const feijipan = {
  key(url) {
    const m = url.match(/feijipan\.com\/s\/([A-Za-z0-9_-]+)/) || url.match(/[?&](?:k|key|shareId)=([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('没认出小飞机分享链接（应是 feijipan.com/s/…）');
    return m[1];
  },
  headers(cred) {
    const h = { 'Content-Type': 'application/json', Referer: 'https://www.feijipan.com/' };
    if (cred.fjToken) h['Authorization'] = cred.fjToken.trim();
    return h;
  },
  async list(url, pwd, cred, ctx) {
    const key = (ctx && ctx.key) || feijipan.key(url);
    let firstErr = null;
    if (!ctx || !ctx.dir) {
      // 路线 A：recommend/list（现行分享页口径）
      // 上游对部分服务器出口 IP 会回空名单/拒答，换 uuid 重试可换出口、多试几次成功率明显高（2026-11-10 真测观察）
      let sawOkEmpty = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt) await new Promise(r => setTimeout(r, 1200));
          const uuid = fjUuid();
          const ts = await fjAesHex(String(Date.now()));
          let u = `https://api.feijipan.com/ws/recommend/list?devType=3&devModel=Chrome&uuid=${uuid}&extra=2&timestamp=${ts}&shareId=${encodeURIComponent(key)}&type=0&offset=1&limit=110`;
          if (pwd) u += `&code=${encodeURIComponent(pwd)}`;
          const r = await reqJson(u, { method: 'POST', headers: { Referer: 'https://share.feijipan.com/' } });
          const d = r.data;
          if (!(d && d.code === 200 && Array.isArray(d.list))) throw new Error(fmtErr('小飞机列目录失败', d));
          const files = [];
          let userId = d.userId ? String(d.userId) : '';
          const pushF = f => {
            const fu = f.userId || f.uid || '';
            if (fu && !userId) userId = String(fu);
            files.push({
              id: String(f.fileId || f.id || ''), name: f.fileName || f.name || '',
              size: f.fileSize || f.size || 0, dir: f.fileType === 2 || f.isFolder === true,
              userId: fu ? String(fu) : '',
            });
          };
          for (const item of d.list) {
            if (item.userId && !userId) userId = String(item.userId);
            if (Array.isArray(item.fileList) && item.fileList.length) item.fileList.forEach(pushF);
            else if (item.fileId || item.fileName) pushF(item);
          }
          if (!files.length) { sawOkEmpty = true; throw new Error('__EMPTY__'); }
          return { ctx: { key, userId, uuid }, files, path: '/', route: '推荐接口' };
        } catch (e) { if (e.message !== '__EMPTY__') firstErr = e; }
      }
      if (sawOkEmpty && !firstErr) throw new Error(pwd ? '小飞机分享里没找到文件（提取码可能不对，或分享已失效）' : '小飞机分享里没找到文件（可能需要提取码，或分享已失效）');
    }
    // 路线 B：旧 share/list 兜底（文件夹导航只剩这条；上游恢复即生效）
    const r = await reqJson('https://api.feijipan.com/ws/share/list', {
      method: 'POST', headers: feijipan.headers(cred),
      body: JSON.stringify({ key, code: pwd || '', folderId: (ctx && ctx.dir) || 0, page: 1, pageSize: 100 }),
    });
    const d = r.data;
    const list = d && (d.data && (d.data.list || d.data.files) || d.list);
    if (!list) throw new Error(fmtErr('小飞机列目录失败', d) + (firstErr ? `；主路线也失败：${firstErr.message}` : ''));
    const files = list.map(f => ({
      id: String(f.fileId || f.id), name: f.fileName || f.name,
      size: f.fileSize || f.size || 0, dir: f.fileType === 'folder' || f.isFolder === true || f.type === 1,
    }));
    return { ctx: { key }, files, path: '/', route: '旧接口兜底' };
  },
  async download(cred, env, ctx, file) {
    // 现行签名流：downloadId=AES(fileId|userId)、auth=AES(fileId|时间戳)
    // uuid 必须与列目录那次同一个（上游按 uuid 绑会话，换 uuid 会被拒）
    const dlUserId = (file && file.userId) || (ctx && ctx.userId) || '';
    // 注意：userId 经常为空——上游 list 响应多数不带这个字段，fjp-down 同样拿空值拼 AES 也能过，别拿它当门槛
    if (ctx && ctx.key) {
      try {
        const now = Date.now();
        const downloadId = await fjAesHex(`${file.id}|${dlUserId}`);
        const ts = await fjAesHex(String(now));
        const auth = await fjAesHex(`${file.id}|${now}`);
        const u = `https://api.feijipan.com/ws/file/redirect?downloadId=${downloadId}&enable=1&devType=3&uuid=${ctx.uuid || fjUuid()}&timestamp=${ts}&auth=${auth}&shareId=${encodeURIComponent(ctx.key)}`;
        const r = await req(u, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Referer: 'https://www.feijix.com/',
            'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site',
          },
          redirect: 'manual',
        });
        const loc = r.headers.get('location');
        if (loc) return { url: loc, name: file.name, headers: {}, note: '小飞机直链有时效，过期重新解析。' };
        const t = await r.text();
        try {
          const d = JSON.parse(t);
          const ju = d && (d.url || d.location || (d.data && (d.data.url || d.data.downloadUrl)));
          if (ju) return { url: ju, name: file.name, headers: {}, note: '小飞机直链有时效，过期重新解析。' };
        } catch (e) {}
        var fjDbg = `签名流回 HTTP ${r.status}：${t.slice(0, 140)}`;
      } catch (e) { var fjDbg = `签名流异常：${e.message}`; }
    }
    // 兜底：旧 POST 路线（带登录 token 时可能可用）
    const r = await req('https://api.feijipan.com/ws/file/redirect', {
      method: 'POST', headers: feijipan.headers(cred), redirect: 'manual',
      body: JSON.stringify({ fileId: file.id }),
    });
    const loc = r.headers.get('location');
    if (loc) return { url: loc, name: file.name, headers: {}, note: '小飞机直链有时效，过期重新解析。' };
    const t = await r.text();
    try {
      const d = JSON.parse(t);
      const u = d.data && (d.data.url || d.data.downloadUrl);
      if (u) return { url: u, name: file.name, headers: {}, note: '小飞机直链有时效，过期重新解析。' };
    } catch (e) {}
    throw new Error(`小飞机取链失败：两条路线都没拿到跳转地址（userId=${dlUserId ? '有' : '空'} uuid=${ctx && ctx.uuid ? '有' : '空'}${typeof fjDbg !== 'undefined' ? '；' + fjDbg : ''}）`);
  },
};

/* ================= 123 云盘（实验 · 双路线互备） =================
   路线 A：www.123pan.com/api；路线 B：www.123pan.cn/b/api（在维护项目 JxPan 的口径）。
   列目录可匿名；取链多数情况需要自己的 Authorization（JWT）。 */
/* 123 口径 2026-11-10 按现行规格重写（YunX 规格 + 云梭实测）：
   列目录换现行匿名端点 yun.123pan.cn/b/api/share/get（只带 Dart UA、无 token；
   无提取码时必须整参省略 SharePwd，next 恒 0 靠 Page 翻页）；
   取链走 www.123865.com/b/api/share/download/info + CRC32 客户端签名，
   先匿名试、失败再带站长 Authorization 重试（双通道）；DownloadURL 需解 Base64 包装并跟跳转。 */
const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); } return t; })();
function crc32hex(str) {
  let c = 0xFFFFFFFF;
  for (const b of new TextEncoder().encode(str)) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16);
}
function p123Auth() {
  const ts = Math.floor(Date.now() / 1000);
  const d = new Date((ts + 57600) * 1000);
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;
  const SUB = 'adefghlmyijnopkqrstubcvwsz';
  const authKey = crc32hex([...stamp].map(ch => SUB[Number(ch)]).join(''));
  const rand = Math.floor(Math.random() * 10000000);
  const authValue = `${ts}-${rand}-${crc32hex(`${ts}|${rand}|/b/api/share/download/info|web|3|${authKey}`)}`;
  return { 'auth-key': authKey, 'auth-value': authValue };
}
const pan123 = {
  key(url) {
    const m = url.match(/(?:123pan\.com|123pan\.cn|123684\.com|123865\.com|123912\.com)\/s\/([A-Za-z0-9-]+)/)
      || url.match(/share\.123pan\.cn\/123pan\/([A-Za-z0-9-]+)/);
    if (!m) throw new Error('没认出 123 分享链接');
    return m[1];
  },
  async tryList(host, key, pwd, parentId) {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const params = new URLSearchParams({ limit: '100', next: '0', orderBy: 'file_name', orderDirection: 'asc', shareKey: key, ParentFileId: String(parentId || 0), Page: String(page) });
      if (pwd) params.set('SharePwd', pwd);
      const r = await reqJson(`https://${host}/b/api/share/get?${params}`, { headers: { 'User-Agent': 'Dart/3.12 (dart:io)' } });
      if (!r.data || r.data.code !== 0 || !r.data.data) throw new Error(fmtErr('123 列目录失败', r.data, { '5112': '该分享受限（5112）' }));
      const list = r.data.data.InfoList || [];
      all.push(...list);
      if (r.data.data.Next === '-1' || !list.length) break;
    }
    return all;
  },
  async list(url, pwd, cred, env, ctx) {
    const key = (ctx && ctx.key) || pan123.key(url);
    const parentId = (ctx && ctx.dir) || '0';
    let items, route;
    try { items = await pan123.tryList('yun.123pan.cn', key, pwd, parentId); route = '现行匿名接口'; }
    catch (e1) {
      try { items = await pan123.tryList('www.123865.com', key, pwd, parentId); route = '现行匿名接口（备域名）'; }
      catch (e2) { throw new Error(`${e1.message}；备用路线也失败：${e2.message}`); }
    }
    const files = items.map(f => ({
      id: String(f.FileId), name: f.FileName, size: f.Size || 0,
      dir: f.Type === 1 || f.Type === '1', etag: f.Etag || '', s3: f.S3KeyFlag || '',
    }));
    return { ctx: { key, dir: parentId, route }, files, path: parentId === '0' ? '/' : parentId, route };
  },
  decodeUrl(u) {
    let s = String(u || '').trim();
    const pm = s.match(/[?&]params=([A-Za-z0-9_-]+)/);
    if (pm) {
      try { const dec = atob(pm[1].replace(/-/g, '+').replace(/_/g, '/')); if (/^https?:\/\//.test(dec)) return dec; } catch { /* fallthrough */ }
    }
    if (!/^https?:\/\//.test(s) && /^[A-Za-z0-9+/=\s]+$/.test(s)) {
      try { const dec = atob(s.replace(/\s/g, '')); if (/^https?:\/\//.test(dec)) return dec; } catch { /* fallthrough */ }
    }
    return s;
  },
  async resolveHops(u) {
    let cur = u;
    for (let hop = 0; hop < 5; hop++) {
      const resp = await fetch(cur, { redirect: 'manual', headers: { 'User-Agent': 'Dart/3.12 (dart:io)', Referer: 'https://yun.123pan.cn/' } });
      const loc = resp.headers.get('location');
      if (resp.status >= 300 && resp.status < 400 && loc) { cur = loc; continue; }
      const ct = resp.headers.get('content-type') || '';
      const clen = Number(resp.headers.get('content-length') || 0);
      if (/json/.test(ct) || (clen > 0 && clen <= 8192)) {
        try {
          const j = JSON.parse(await resp.text());
          const ru = j && j.data && j.data.redirect_url;
          if (ru) { cur = ru; continue; }
        } catch { /* not json */ }
      }
      break;
    }
    return cur;
  },
  async download(cred, env, ctx, file) {
    const payload = { ShareKey: ctx.key, FileID: Number(file.id) || file.id, S3KeyFlag: file.s3 || '', Size: file.size || 0, Etag: file.etag || '' };
    const attempt = async withAuth => {
      const loginuuid = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
      const h = { 'Content-Type': 'application/json', platform: 'android', 'app-version': '39', loginuuid, ...p123Auth() };
      if (withAuth && cred.p123Token) {
        const t = cred.p123Token.trim();
        h['authorization'] = t.startsWith('Bearer') ? t : `Bearer ${t}`;
      }
      const r = await reqJson('https://www.123865.com/b/api/share/download/info', { method: 'POST', headers: h, body: JSON.stringify(payload) });
      return r.data;
    };
    let data = await attempt(false);
    let u = data && data.data && data.data.DownloadURL;
    let authed = false;
    if (!u && cred.p123Token) { data = await attempt(true); u = data && data.data && data.data.DownloadURL; authed = true; }
    if (!u) {
      const code = data && data.code;
      if (code === 5112 || code === 401) throw new Error(cred.p123Token ? '123 取链被拒（5112）：可能超出免费流量额度或该文件需付费下载' : '123 取链需要登录（5112）：请在保险箱/凭证里存入你 123 账号的 Authorization 后重试；小文件偶尔可匿名直下，这个没轮上');
      throw new Error(fmtErr('123 取链失败', data));
    }
    const real = await pan123.resolveHops(pan123.decodeUrl(u));
    return { url: real, name: file.name, headers: { Referer: 'https://yun.123pan.cn/' }, note: `123 直链有时效，下载时须带 Referer。${authed ? '（本次走了你的登录令牌通道）' : '（本次匿名通道直下）'}` };
  },
};

/* ================= 迅雷云盘（实验） =================
   分享口径（panweb-parser 逆向笔记）：api-pan.xunlei.com/drive/v1/share，
   每类请求都要 x-captcha-token —— 先调 xluser-ssl 的 captcha/init 换取（低风险时直发）。 */
const XL_CLIENT_ID = 'XQPcCPdgZmIQB9Vw';
/* 迅雷 captcha 口径 2026-11-10 按现行实现重写（OpenList 驱动源码 + panweb-parser 实测）：
   老实现用假 sign（'1.'+时间戳）+ 每次随机新设备从机房出口请求，等于最差信誉组合，永远拿不到令牌。
   现行三段：① 安卓身份自算 sign（盐表公开稳定，游客列目录用，设备号持久化复用）；
   ② 保险箱存了抓包三件套（xlCaptchaSign/xlCaptchaTs/xlUserId）时用存的 sign 换新令牌（sign 无时效校验）；
   ③ 上游回验证页 url 时把链接原样透传给用户，让他在自己浏览器里完成验证。 */
const XL_ANDROID = {
  clientId: 'Xp6vsxz_7IYVw2BB', version: '8.31.0.9726', pkg: 'com.xunlei.downloadprovider',
  salts: ['9uJNVj/wLmdwKrJaVj/omlQ', 'Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf', 'Eb+L7Ce+Ej48u', 'jKY0', 'ASr0zCl6v8W4aidjPK5KHd1Lq3t+vBFf41dqv5+fnOd', 'wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK', 'gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O', '5IiCoM9B1/788ntB', 'P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf', '+oK0AN'],
  ua: 'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)',
};
const xunlei = {
  deviceId() { return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''); },
  async captchaInit(body) {
    const r = await reqJson('https://xluser-ssl.xunlei.com/v1/shield/captcha/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://pan.xunlei.com/' },
      body: JSON.stringify(body),
    });
    const d = r.data || {};
    const token = d.captcha_token || (d.data && d.data.captcha_token);
    if (token) return token;
    const verifyUrl = d.url || (d.data && d.data.url);
    if (verifyUrl) throw new Error(`迅雷要求先完成一次人工验证：请在你自己的浏览器/手机上打开这个链接完成验证，然后回来重试解析：${verifyUrl}`);
    throw new Error('迅雷验证码令牌获取失败（captcha/init 未直发令牌）');
  },
  // 安卓身份自算 sign（游客段）：设备号优先用存量 xlDeviceId，没有就生成并回写持久化——频繁换设备号会被风控盯上
  async captchaAndroid(action, cred) {
    const stored = (cred.xlDeviceId || '').trim();
    const did = /^[0-9a-f]{32}$/.test(stored) ? stored : xunlei.deviceId();
    const ts = String(Date.now());
    let str = XL_ANDROID.clientId + XL_ANDROID.version + XL_ANDROID.pkg + did + ts;
    for (const salt of XL_ANDROID.salts) str = md5(str + salt);
    const token = await xunlei.captchaInit({
      client_id: XL_ANDROID.clientId, device_id: did, action,
      meta: { username: '', phone_number: '', email: '', package_name: XL_ANDROID.pkg, client_version: XL_ANDROID.version, captcha_sign: '1.' + str, timestamp: ts, user_id: '0' },
      redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
    });
    return { token, did, clientId: XL_ANDROID.clientId, ua: XL_ANDROID.ua, newDid: did !== stored };
  },
  // 存量 sign 通道（登录段）：用保险箱里抓包存的 captcha_sign+timestamp 原样 re-init 换新令牌
  async captchaStored(action, cred) {
    const did = /^[0-9a-f]{32}$/.test((cred.xlDeviceId || '').trim()) ? cred.xlDeviceId.trim() : xunlei.deviceId();
    const token = await xunlei.captchaInit({
      client_id: (cred.xlClientId || '').trim() || XL_CLIENT_ID, device_id: did, action,
      meta: { username: '', phone_number: '', email: '', package_name: 'pan.xunlei.com', client_version: (cred.xlClientVersion || '').trim() || '1.92.89', captcha_sign: cred.xlCaptchaSign.trim(), timestamp: String(cred.xlCaptchaTs).trim(), user_id: (cred.xlUserId || '').trim() },
      captcha_token: '',
      redirect_uri: 'xlaccsdk01://xunlei.com/callback?state=harbor',
    });
    return { token, did, clientId: (cred.xlClientId || '').trim() || XL_CLIENT_ID };
  },
  async captcha(action, cred) {
    if (cred.xlCaptchaSign && cred.xlCaptchaTs) return xunlei.captchaStored(action, cred);
    return xunlei.captchaAndroid(action, cred);
  },
  headers(cap, cred) {
    const h = {
      'x-client-id': cap.clientId || XL_CLIENT_ID, 'x-device-id': cap.did, 'x-captcha-token': cap.token,
      Referer: 'https://pan.xunlei.com/', Origin: 'https://pan.xunlei.com',
    };
    if (cap.ua) h['User-Agent'] = cap.ua;
    if (cred.xlAuth) h['Authorization'] = cred.xlAuth.trim();
    return h;
  },
  // 有刷新令牌（扫码登录存的）时，先换一张新鲜的访问令牌再干活，并回写新令牌（网页版 client 无 secret，与扫码同通道）
  async auth(cred) {
    if (!cred.xlRefresh) return { cred, upd: null };
    try {
      const tj = await reqJson('https://xluser-ssl.xunlei.com/v1/auth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://pan.xunlei.com/' },
        body: JSON.stringify({ client_id: 'XW5SkOhLDjnOZP7J', grant_type: 'refresh_token', refresh_token: cred.xlRefresh }),
      });
      if (tj.data && tj.data.access_token) {
        const fields = { xlAuth: 'Bearer ' + tj.data.access_token };
        if (tj.data.refresh_token) fields.xlRefresh = tj.data.refresh_token;
        return { cred: { ...cred, xlAuth: fields.xlAuth }, upd: { fields } };
      }
    } catch { /* 换失败就用现存的 xlAuth 兜底 */ }
    return { cred, upd: null };
  },
  id(url) {
    const m = url.match(/pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('没认出迅雷分享链接（应是 pan.xunlei.com/s/…）');
    return m[1];
  },
  async list(url, pwd, cred, env, ctx) {
    const shareId = (ctx && ctx.shareId) || xunlei.id(url);
    const u = new URL(url);
    const pass = pwd || u.searchParams.get('pwd') || '';
    const api = `https://api-pan.xunlei.com/drive/v1/share?share_id=${shareId}&pass_code=${encodeURIComponent(pass)}&pass_code_token=${encodeURIComponent((ctx && ctx.passToken) || '')}&limit=100&page_token=&scene=NORMAL&order=DEFAULT_ORDER`;
    const callList = async (cap, credForHeaders) => {
      const r = await reqJson(api, { headers: xunlei.headers(cap, credForHeaders) });
      if (!r.data || r.data.error) throw new Error(fmtErr('迅雷列目录失败', { code: r.data && r.data.error_code, message: r.data && (r.data.error_description || r.data.error) }));
      return r.data;
    };
    // 通道一：安卓身份游客列目录（不带登录态）——现行工具的 scan 段标准做法
    try {
      const cap = await xunlei.captchaAndroid('get:/drive/v1/share', cred);
      const data = await callList(cap, {});
      const files = (data.files || []).map(f => ({ id: f.id, name: f.name, size: Number(f.size || 0), dir: f.kind === 'drive#folder' }));
      return {
        ctx: { shareId, passToken: data.pass_code_token || '', capToken: cap.token, capDid: cap.did },
        files, path: '/', route: '安卓身份游客',
        ...(cap.newDid ? { credUpdate: { fields: { xlDeviceId: cap.did } } } : {}),
      };
    } catch (e1) {
      // 通道二：登录态（扫码存的令牌 + 存量 sign/安卓身份令牌）
      if (!cred.xlAuth && !cred.xlRefresh) throw e1;
      const { cred: ec, upd } = await xunlei.auth(cred);
      const cap = await xunlei.captcha('get:/drive/v1/share', ec);
      const data = await callList(cap, ec);
      const files = (data.files || []).map(f => ({ id: f.id, name: f.name, size: Number(f.size || 0), dir: f.kind === 'drive#folder' }));
      const updFields = { ...(upd ? upd.fields : {}), ...(cap.newDid ? { xlDeviceId: cap.did } : {}) };
      return {
        ctx: { shareId, passToken: data.pass_code_token || '', capToken: cap.token, capDid: cap.did },
        files, path: '/', route: '登录态',
        ...(Object.keys(updFields).length ? { credUpdate: { fields: updFields } } : {}),
      };
    }
  },
  async download(cred, env, ctx, file) {
    const { cred: ec, upd } = await xunlei.auth(cred);
    const cap = await xunlei.captcha('get:/drive/v1/share/detail', ec);
    const r = await reqJson(`https://api-pan.xunlei.com/drive/v1/share/detail?share_id=${ctx.shareId}&file_id=${file.id}&pass_code_token=${encodeURIComponent(ctx.passToken || '')}`, {
      headers: xunlei.headers(cap, ec),
    });
    const f = r.data && (r.data.file_info || r.data);
    const u2 = f && (f.web_content_link || (f.links && f.links[0] && (f.links[0].url || f.links[0].token)));
    if (!u2) throw new Error(fmtErr('迅雷取链失败', { code: r.data && r.data.error_code, message: r.data && r.data.error_description }) + '（迅雷分享常要求先转存到自己盘才能取链；若反复失败，可在保险箱补存迅雷抓包三件套 sign 后再试）');
    const updFields = { ...(upd ? upd.fields : {}), ...(cap.newDid ? { xlDeviceId: cap.did } : {}) };
    return { url: u2, name: file.name, headers: {}, note: '迅雷直链有时效，过期重新解析。', ...(Object.keys(updFields).length ? { credUpdate: { fields: updFields } } : {}) };
  },
};

/* ================= 光鸭云盘（实验） =================
   分享：get_share_access_token（匿名+提取码）→ get_share_page_files_list → get_share_download_url。
   扫码登录（设备码流）存的访问/刷新令牌用于取链兜底与自动续期（口径对照 JxPan）。 */
const GY_API = 'https://api.guangyapan.com';
const GY_CLIENT = 'aMe-8VSlkrbQXpUR';
const gy = {
  id(url) {
    const m = url.match(/guangyapan\.com\/s\/([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('没认出光鸭分享链接（应是 guangyapan.com/s/…）');
    return m[1];
  },
  headers(cred) {
    const h = { 'Content-Type': 'application/json', Origin: 'https://www.guangyapan.com', Referer: 'https://www.guangyapan.com/' };
    if (cred && cred.gyToken) h.Authorization = `Bearer ${cred.gyToken}`;
    return h;
  },
  async refresh(cred) {
    if (!cred.gyRefresh) return null;
    try {
      const r = await reqJson('https://account.guangyapan.com/v1/auth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: cred.gyRefresh, client_id: GY_CLIENT }),
      });
      if (r.data && r.data.access_token) {
        return { token: r.data.access_token, fields: { gyToken: r.data.access_token, ...(r.data.refresh_token ? { gyRefresh: r.data.refresh_token } : {}) } };
      }
    } catch { /* 续期失败按原样报错 */ }
    return null;
  },
  async shareToken(shareId, code) {
    const r = await reqJson(`${GY_API}/nd.bizuserres.s/v1/get_share_access_token`, {
      method: 'POST', headers: gy.headers(null), body: JSON.stringify({ shareId, code: code || '' }),
    });
    if (!r.data || !r.data.data || !r.data.data.accessToken) {
      throw new Error(fmtErr('获取光鸭分享令牌失败（提取码不对或分享已取消？）', r.data));
    }
    return r.data.data.accessToken;
  },
  async list(url, pwd, cred, env, ctx) {
    const shareId = (ctx && ctx.shareId) || gy.id(url);
    let code = pwd || '';
    if (!code) { const cm = url.match(/[?&]code=([A-Za-z0-9]+)/); if (cm) code = cm[1]; }
    const token = (ctx && ctx.token) || await gy.shareToken(shareId, code);
    const parent = (ctx && ctx.dir) || '';
    const r = await reqJson(`${GY_API}/nd.bizuserres.s/v1/get_share_page_files_list`, {
      method: 'POST', headers: gy.headers(null),
      body: JSON.stringify({ accessToken: token, parentId: parent, page: 1, pageSize: 100, orderBy: 0, sortType: 0 }),
    });
    if (!r.data || !r.data.data || !Array.isArray(r.data.data.list)) throw new Error(fmtErr('光鸭列目录失败', r.data));
    const files = r.data.data.list.map(f => ({
      id: f.fileId || f.id || f.resId,
      name: f.fileName || f.name,
      size: f.fileSize || f.size || 0,
      dir: f.resType === 2 || f.fileType === 0 || f.type === 0 || !!f.isFolder,
    }));
    return { ctx: { shareId, token, dir: parent }, files, path: parent ? parent : '/' };
  },
  async download(cred, env, ctx, file) {
    if (!ctx || !ctx.token) throw new Error('会话已过期，请重新解析一次');
    const tryGet = async (c) => {
      const r = await reqJson(`${GY_API}/nd.bizuserres.s/v1/get_share_download_url`, {
        method: 'POST', headers: gy.headers(c), body: JSON.stringify({ fileId: file.id, accessToken: ctx.token }),
      });
      const d = r.data && r.data.data;
      if (!d) return null;
      return typeof d === 'string' ? d : (d.signedURL || d.url || d.downloadUrl || null);
    };
    let link = await tryGet(null).catch(() => null);
    let upd = null;
    if (!link && cred.gyToken) link = await tryGet(cred).catch(() => null);
    if (!link && cred.gyRefresh) {
      const rf = await gy.refresh(cred);
      if (rf) { upd = { fields: rf.fields }; link = await tryGet({ gyToken: rf.token }).catch(() => null); }
    }
    if (!link) throw new Error('光鸭取直链失败：可能需要先在「② 我的凭证」里扫码登录光鸭再重试（大文件/受限分享要登录态）');
    return { url: link, name: file.name, note: '光鸭直链有效期较短，过期重新解析。', ...(upd ? { credUpdate: upd } : {}) };
  },
};

/* ================= 路由 ================= */
const ADAPTERS = {
  baidu: {
    credKeys: ['bduss', 'stoken'],
    list: (b, env) => bd.list(b.url, b.pwd, b.cred, env, b.ctx),
    download: (b, env) => bd.download(b.cred, env, b.ctx, b.file),
  },
  aliyun: {
    credKeys: ['aliAuth'],
    list: (b, env) => ali.list(b.url, b.pwd, b.cred, env, b.ctx),
    download: (b, env) => ali.download(b.cred, env, b.ctx, b.file),
  },
  quark: {
    credKeys: ['cookie'],
    credEnv: 'QUARK_COOKIE',
    list: (b, env) => quark.list(b.url, b.pwd, { cookie: b.cred.quarkCookie }, env, b.ctx),
    download: (b, env) => quark.download({ cookie: b.cred.quarkCookie }, env, b.ctx, b.file),
  },
  uc: {
    credKeys: ['cookie'],
    credEnv: 'UC_COOKIE',
    list: (b, env) => uc.list(b.url, b.pwd, { cookie: b.cred.ucCookie }, env, b.ctx),
    download: (b, env) => uc.download({ cookie: b.cred.ucCookie }, env, b.ctx, b.file),
  },
  lanzou: {
    credKeys: [],
    list: async (b) => {
      const first = await lz.list(b.url);
      const res = await lz.resolveLink(first.ctx, b.pwd);
      return { single: true, ctx: first.ctx, route: `域名 ${first.host}`, ...res };
    },
  },
  cmcc: {
    credKeys: ['cmccAuth'],
    list: (b, env) => cmcc.list(b.url, b.pwd, b.cred, b.ctx),
    download: (b, env) => cmcc.download(b.cred, env, b.ctx, b.file),
  },
  ctyun: {
    credKeys: ['ctCookie'],
    list: (b, env) => ctyun.list(b.url, b.pwd, b.cred, b.ctx),
    download: (b, env) => ctyun.download(b.cred, env, b.ctx, b.file),
  },
  feijipan: {
    credKeys: ['fjToken'],
    list: (b, env) => feijipan.list(b.url, b.pwd, b.cred, b.ctx),
    download: (b, env) => feijipan.download(b.cred, env, b.ctx, b.file),
  },
  pan123: {
    credKeys: ['p123Token'],
    list: (b, env) => pan123.list(b.url, b.pwd, b.cred, env, b.ctx),
    download: (b, env) => pan123.download(b.cred, env, b.ctx, b.file),
  },
  xunlei: {
    credKeys: ['xlAuth', 'xlRefresh'],
    list: (b, env) => xunlei.list(b.url, b.pwd, b.cred, env, b.ctx),
    download: (b, env) => xunlei.download(b.cred, env, b.ctx, b.file),
  },
  guangya: {
    credKeys: ['gyToken', 'gyRefresh'],
    list: (b, env) => gy.list(b.url, b.pwd, b.cred, env, b.ctx),
    download: (b, env) => gy.download(b.cred, env, b.ctx, b.file),
  },
};

function envCreds(env) {
  return {
    bduss: env.BDUSS || '', stoken: env.BDUSS_STOKEN || '',
    aliAuth: env.ALI_AUTH || '', quarkCookie: env.QUARK_COOKIE || '', ucCookie: env.UC_COOKIE || '',
    cmccAuth: env.CMCC_AUTH || '', ctCookie: env.CT_COOKIE || '', fjToken: env.FEIJIPAN_TOKEN || '',
    p123Token: env.PAN123_TOKEN || '', xlAuth: env.XUNLEI_AUTH || '', xlRefresh: env.XUNLEI_REFRESH || '',
    gyToken: env.GY_TOKEN || '', gyRefresh: env.GY_REFRESH || '',
  };
}

async function health(env) {
  const probes = [
    ['百度网盘', 'https://pan.baidu.com/'],
    ['阿里云盘', 'https://api.aliyundrive.com/'],
    ['夸克网盘', 'https://drive-pc.quark.cn/'],
    ['UC 网盘', 'https://pc-api.uc.cn/'],
    ['蓝奏云', 'https://www.lanzoui.com/'],
    ['移动云盘', 'https://yun.139.com/'],
    ['天翼云盘', 'https://cloud.189.cn/'],
    ['小飞机', 'https://api.feijipan.com/'],
    ['123 云盘', 'https://www.123pan.com/'],
    ['迅雷云盘', 'https://api-pan.xunlei.com/'],
    ['光鸭云盘', 'https://www.guangyapan.com/'],
  ];
  const results = await Promise.all(probes.map(async ([name, u]) => {
    try {
      const r = await fetch(u, { method: 'GET', headers: { 'User-Agent': UA_PC }, redirect: 'manual' });
      return { name, reachable: r.status < 500, status: r.status };
    } catch (e) { return { name, reachable: false, status: 0 }; }
  }));
  return ok({ health: results, at: new Date().toISOString() });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'GET') {
    const u = new URL(request.url);
    if (u.searchParams.get('action') === 'health') return health(env);
    return ok({ service: 'ym-pan parse api', version: '1.0', drives: DRIVES });
  }
  if (request.method !== 'POST') return fail('只支持 POST', 405);
  let body;
  try { body = await request.json(); } catch (e) { return fail('请求体不是 JSON'); }
  const drive = body.drive;
  const adapter = ADAPTERS[drive];
  if (!adapter) return fail(`不支持的网盘：${drive || '(空)'}`);
  const reqCred = {};
  for (const [k, v] of Object.entries(body.cred || {})) {
    if (typeof v === 'string' && v.trim()) reqCred[k] = v;
  }
  body.cred = { ...envCreds(env), ...reqCred };
  // 站长保险箱兜底：请求带正确站长口令（x-owner-pass）时，用保险箱存的凭证补齐本次没带的；
  // 夸克未单独存保险箱时，再兜底用扫码绑定的巡检 Cookie。保险箱异常绝不影响正常解析。
  // 验口令与 owner.js 同口径限流（共用 rl:owner:<ip> 计数键，两条路径合计 15 分钟内
  // 失败满 10 次锁 15 分钟），比对用等时比较——此前此路径无限流、可无限在线试口令。
  try {
    const op = request.headers.get('x-owner-pass');
    const kv = env.PAN_KV;
    if (op && kv) {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const rlKey = 'rl:owner:' + ip;
      let rl = null, locked = false;
      try {
        const rawRl = await kv.get(rlKey);
        if (rawRl) { rl = JSON.parse(rawRl); if (rl && rl.lockUntil > Date.now()) locked = true; }
      } catch { rl = null; }
      const oh = locked ? null : await kv.get('owner_hash');
      if (oh) {
        // 与 owner.js timingEq 同口径：两侧先做 SHA-256 摘要（恒 32 字节），再逐字节 XOR 累加，不短路。
        const teq = async (a, b) => {
          if (typeof a !== 'string' || typeof b !== 'string') return false;
          const enc = new TextEncoder();
          const [da, db] = await Promise.all([
            crypto.subtle.digest('SHA-256', enc.encode(a)),
            crypto.subtle.digest('SHA-256', enc.encode(b)),
          ]);
          const va = new Uint8Array(da);
          const vb = new Uint8Array(db);
          let dd = 0;
          for (let i = 0; i < va.length; i++) dd |= va[i] ^ vb[i];
          return dd === 0;
        };
        const sha = async (s) => {
          const dig = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
          return [...new Uint8Array(dig)].map(x => x.toString(16).padStart(2, '0')).join('');
        };
        let passOkFlag = false;
        if (oh.startsWith('v2$')) {
          const salt = oh.slice(3, oh.indexOf('$', 3));
          passOkFlag = await teq(await sha(salt + ':' + op), oh.slice(3 + salt.length + 1));
        } else {
          passOkFlag = await teq(await sha(op), oh);
        }
        if (passOkFlag) {
          // 旧格式（无盐）哈希懒升级：与 owner.js passOkInfo/hashPassV2 完全同口径——
          // 验过即重写为 v2$<12 字节随机盐 hex>$<sha256(salt+':'+pass)>；升级失败不影响本次解析。
          if (!oh.startsWith('v2$')) {
            try {
              const salt = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
              await kv.put('owner_hash', 'v2$' + salt + '$' + (await sha(salt + ':' + op)));
            } catch { /* 懒升级失败不影响解析，下次验过再试 */ }
          }
          try { await kv.delete(rlKey); } catch { /* 清零失败不影响解析 */ }
          let vc = null;
          const raw = await kv.get('vault_' + drive);
          if (raw) { try { vc = JSON.parse(raw); } catch { vc = null; } }
          if (!vc && drive === 'quark') {
            const c = await kv.get('quark_cookie');
            if (c) vc = { quarkCookie: c };
          }
          if (vc) for (const [k, v] of Object.entries(vc)) {
            if (typeof v === 'string' && v && !body.cred[k]) body.cred[k] = v;
          }
        } else {
          try {
            const now = Date.now();
            const r = (rl && typeof rl === 'object') ? rl : { fails: 0, winStart: 0, lockUntil: 0 };
            if (!r.winStart || now - r.winStart > 15 * 60 * 1000) { r.fails = 0; r.winStart = now; r.lockUntil = 0; }
            r.fails++;
            if (r.fails >= 10) r.lockUntil = now + 15 * 60 * 1000;
            await kv.put(rlKey, JSON.stringify(r), { expirationTtl: 2 * 24 * 3600 });
          } catch { /* 计数失败不影响正常解析 */ }
        }
      }
    }
  } catch { /* 保险箱兜底失败就当没存过 */ }
  try {
    if (body.action === 'download') {
      if (!adapter.download) return fail('该盘是单文件直达，没有单独的取链步骤');
      const res = await adapter.download(body, env);
      return ok({ drive, kind: 'link', ...res });
    }
    const res = await adapter.list(body, env);
    if (res.single) return ok({ drive, kind: 'link', ...res });
    // 各家列表接口单页上限多为 100：满 100 条时提示可能未显示全（不保证恰好 100 条时没有更多，宁可多提示）
    if (res && Array.isArray(res.files) && res.files.length >= 100) res.truncated = true;
    return ok({ drive, kind: 'list', ...res });
  } catch (e) {
    return fail(e.message || String(e));
  }
}
