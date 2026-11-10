// 访客登录助手（v1.6）：扫码登录 + 小飞机账号密码登录。
//   扫码：百度 / 夸克 / UC / 阿里 / 移动 / 天翼 / 光鸭 —— 协议逐项对照久经验证的开源实现
//         （百度 passport 官方二维码流、夸克/UC 的 CAS、阿里 passport mini_login、
//          移动云盘 orchestration 签名流、天翼 logbox oauth2、光鸭 OAuth 设备码流，
//          口径与 JxPan / xiaoya-alist 等项目一致）。
//   密码：仅小飞机一家（其官方接口接受账密且无验证码）；密码只透传给官方接口换令牌，
//         本站不保存、不记录密码，只把换到的令牌交回浏览器。
// 全程无状态：扫码会话参数经浏览器在 start/poll 之间传递，服务器不保存任何人的凭证；
// 换到的凭证只回给正在扫码的这台浏览器，由页面存进它自己的 localStorage / 站长保险箱。

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const hexUuid = () => uuid().replace(/-/g, '');

async function fetchT(url, opts = {}, ms = 25000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}
function parseCookies(resp) {
  const out = {};
  let arr = [];
  try { arr = resp.headers.getSetCookie ? resp.headers.getSetCookie() : []; } catch { arr = []; }
  if (!arr.length) { const sc = resp.headers.get('set-cookie'); if (sc) arr = [sc]; }
  for (const line of arr) {
    const seg = String(line).split(';')[0]; const i = seg.indexOf('=');
    if (i > 0) out[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  return out;
}
const cookieStr = obj => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
function mergeCookieStr(a, b) {
  const m = new Map();
  for (const s of [a, b]) for (const part of String(s || '').split('; ')) {
    const i = part.indexOf('='); if (i > 0) m.set(part.slice(0, i), part.slice(i + 1));
  }
  return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ---------- 通用加密小工具（移动签名 / 小飞机时间戳） ---------- */
// 标准 MD5（移动云盘签名用）
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
// AES-ECB 加密（用 CBC 零 IV 逐块实现）→ 返回密文字节。
// 暗病教训一（2026-11-08）：WebCrypto 的 AES-CBC 会在输入后再追加一个 PKCS#7 填充块，
// 取密文时只取与明文等长的部分即可。
// 暗病教训二（2026-11-10 站长实测定位）：整段明文一次 CBC 加密只有第一块等于 ECB——
// CBC 会把前一块密文异或进后一块，多块报文从第二块起全错（移动登录报文 81 字节中招，
// 服务器解不开只回「参数错误」；小飞机时间戳只有 13 字节、单块，所以一直没暴露）。
// 正确做法：逐块（16 字节）分别加密，每块只取输出的首块，拼起来才是真 ECB。
async function aesEcbBytes(keyStr, plainBytes) {
  const keyBytes = typeof keyStr === 'string' ? new TextEncoder().encode(keyStr) : keyStr;
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
const b64 = bytes => btoa(String.fromCharCode(...bytes));
// RSA PKCS#1 v1.5（移动云盘加密 AES 密钥用；公钥 DER 解析与 JxPan 同法）
function parseRsaPublicKey(derBase64) {
  const der = Uint8Array.from(atob(derBase64), c => c.charCodeAt(0));
  function tlv(off) {
    const tag = der[off]; let len = der[off + 1]; let hdr = 2;
    if (len & 128) { const n = len & 127; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | der[off + 2 + i]; hdr += n; }
    return { tag, start: off + hdr, end: off + hdr + len };
  }
  const outer = tlv(0);              // SEQUENCE
  const alg = tlv(outer.start);      // SEQUENCE (algorithm)
  const bitstr = tlv(alg.end);       // BIT STRING
  const inner = tlv(bitstr.start + 1); // SEQUENCE (skip unused-bits byte)
  const nT = tlv(inner.start);       // INTEGER n
  const eT = tlv(nT.end);            // INTEGER e
  const big = t => { let hex = ''; for (let i = t.start; i < t.end; i++) hex += der[i].toString(16).padStart(2, '0'); return BigInt('0x' + (hex.replace(/^00+/, '') || '0')); };
  return { n: big(nT), e: big(eT) };
}
function rsaEncrypt(n, e, message) {
  const keySize = (n.toString(16).length + 1) >> 1;
  const msg = new TextEncoder().encode(message);
  const padLen = keySize - msg.length - 3;
  if (padLen < 8) throw new Error('RSA 消息过长');
  const padded = new Uint8Array(keySize);
  padded[1] = 2;
  const rand = new Uint8Array(padLen); crypto.getRandomValues(rand);
  for (let i = 0; i < padLen; i++) padded[2 + i] = rand[i] === 0 ? 1 : rand[i];
  padded.set(msg, 3 + padLen);
  let m = 0n; for (const b of padded) m = (m << 8n) | BigInt(b);
  let result = 1n, base = m % n, exp = e;
  while (exp > 0n) { if (exp & 1n) result = (result * base) % n; exp >>= 1n; base = (base * base) % n; }
  const hex = result.toString(16).padStart(keySize * 2, '0');
  return btoa(hex.match(/.{2}/g).map(h => String.fromCharCode(parseInt(h, 16))).join(''));
}

/* ================= 百度（passport 二维码） ================= */
const baidu = {
  async start() {
    const gid = hexUuid().toUpperCase();
    const u = `https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=${gid}&callback=tangram_guid_${now()}&apiver=v3&tt=${now()}&tpl=netdisk&_=${now()}`;
    const txt = await (await fetchT(u, { headers: { 'User-Agent': UA } })).text();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('百度二维码接口无响应');
    const j = JSON.parse(m[0]);
    if (j.errno !== 0 || !j.sign) throw new Error('百度二维码获取失败：' + JSON.stringify(j).slice(0, 120));
    // 上游 imgurl 不带协议头（passport.baidu.com/v2/api/qrcode?...），浏览器会当相对路径
    // 请求本站域名 → 404 裂图（2026-11-10 站长实测）。这里统一补全为绝对地址。
    const img = /^https?:\/\//i.test(j.imgurl || '') ? j.imgurl : 'https://' + String(j.imgurl || '').replace(/^\/\//, '');
    return { qrImg: img, params: { sign: j.sign, gid } };
  },
  async poll(p) {
    const u = `https://passport.baidu.com/channel/unicast?channel_id=${p.sign}&tpl=netdisk&gid=${p.gid}&callback=&apiver=v3&tt=${now()}&_=${now()}`;
    let txt;
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 40000);
      try { txt = await (await fetch(u, { headers: { 'User-Agent': UA }, signal: c.signal })).text(); }
      finally { clearTimeout(t); }
    } catch { return { state: 'waiting' }; }
    let v = null;
    try {
      const m = txt.match(/\{[\s\S]*\}/); const j = JSON.parse(m[0]);
      if (j.errno === 0 && j.channel_v) { const cv = JSON.parse(j.channel_v); if (cv.status === 0 && cv.v) v = cv.v; else return { state: 'scanned' }; }
    } catch { /* 继续等待 */ }
    if (!v) return { state: 'waiting' };
    const eu = `https://passport.baidu.com/v3/login/main/qrbdusslogin?v=${v}&bduss=${v}&loginVersion=v4&qrcode=1&tpl=netdisk&apiver=v3&tt=${now()}&traceid=&time=${Math.floor(now() / 1000)}&alg=v3&callback=`;
    const resp = await fetchT(eu, { headers: { 'User-Agent': UA } });
    const cookies = parseCookies(resp);
    const txt2 = await resp.text();
    const bduss = cookies.BDUSS || ((txt2.match(/"bduss"\s*:\s*"([^"]+)"/) || [])[1]) || '';
    if (!bduss) throw new Error('百度已确认但没换到 BDUSS，响应：' + txt2.slice(0, 120));
    const creds = { bduss };
    if (cookies.STOKEN) creds.stoken = cookies.STOKEN;
    return { state: 'done', creds };
  },
};

/* ================= 夸克 / UC（CAS） ================= */
function casStart(clientId, dtMs) {
  return async () => {
    const t = now();
    const qs = new URLSearchParams({ __dt: String(dtMs || 800 + Math.floor(Math.random() * 800)), __t: String(t) });
    const resp = await fetchT(`https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Referer: 'https://drive.quark.cn/' },
      body: new URLSearchParams({ client_id: String(clientId), v: '1.2', request_id: uuid() }).toString(),
    });
    const j = await resp.json().catch(() => null);
    // 上游真实形状是 data.members.token（v1.5 与巡检绑定 qr.js 均如此，2026-11-08 线上实测复核）；两种都认
    const tok = j && j.data && ((j.data.members && j.data.members.token) || j.data.token);
    if (!j || j.status !== 2000000 || !tok) throw new Error('获取二维码令牌失败：' + JSON.stringify(j).slice(0, 140));
    return { token: tok };
  };
}
async function casPoll(clientId, token) {
  const resp = await fetchT('https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA, Referer: 'https://drive.quark.cn/' },
    body: new URLSearchParams({ client_id: String(clientId), v: '1.2', token, request_id: uuid() }).toString(),
  });
  const j = await resp.json().catch(() => null);
  if (!j) return { state: 'waiting' };
  if (j.status === 2000000 && j.data && j.data.members && j.data.members.service_ticket) {
    return { state: 'ticket', ticket: j.data.members.service_ticket };
  }
  if (j.status === 50004002) return { state: 'expired' };
  if (j.status === 20000 || j.status === 50000 || j.status === 50004003) return { state: 'scanned' };
  return { state: 'waiting' };
}
const UC_APP_UA = 'Mozilla/5.0 (Linux; U; Android 13; zh-CN; M2012K11AC Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UCBrowser/17.4.2.2112 Mobile Safari/537.36';

const quark = {
  // 夸克访客扫码逐字对齐本站已实证的巡检绑定实现（functions/api/qr.js，2026-11-07 站长真扫通过）：
  // uop.quark.cn 取令牌/换票据、pan.quark.cn 换 Cookie、drive-pc config 复核，勿改走 api.open.uc.cn。
  async start() {
    const requestId = uuid();
    const resp = await fetchT(`https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=${requestId}`, {
      method: 'POST', headers: { 'User-Agent': UA, Referer: 'https://pan.quark.cn/' },
    });
    const j = await resp.json().catch(() => null);
    const token = j && j.data && ((j.data.members && j.data.members.token) || j.data.token);
    if (!token) throw new Error('获取二维码令牌失败：' + JSON.stringify(j).slice(0, 140));
    const biz = 'S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400';
    return { qr: `https://su.quark.cn/4_eMHBJ?token=<redacted>&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=${biz}`, params: { token, requestId } };
  },
  async poll(p) {
    const resp = await fetchT(`https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=<redacted>&request_id=${encodeURIComponent(p.requestId || '')}`, {
      headers: { 'User-Agent': UA, Referer: 'https://pan.quark.cn/' },
    });
    const j = await resp.json().catch(() => null);
    const text = JSON.stringify(j || {});
    const ticketM = text.match(/"service_ticket"\s*:\s*"([^"]+)"/);
    if (!ticketM) {
      // 未扫码时上游就回 50004002「Token Not Found」（2026-11-08 实测）——按等待处理，
      // 不能报过期：访客前端收到 expired 会立刻停轮询，码还没扫就废了。
      // （巡检侧 qr.js 报 expired 靠它自己的前端自动换码兜底，两边语义别混。）
      if (/"status"\s*:\s*50004002/.test(text) && !/Token Not Found/i.test(text)) return { state: 'expired' };
      const scanned = /"status"\s*:\s*(20000|50000|50004003)/.test(text) || /scan/i.test(text);
      return { state: scanned ? 'scanned' : 'waiting' };
    }
    const jar = {};
    const a = await fetchT(`https://pan.quark.cn/account/info?st=${encodeURIComponent(ticketM[1])}`, { headers: { 'User-Agent': UA } }).catch(() => null);
    if (a) { Object.assign(jar, parseCookies(a)); await a.text().catch(() => {}); }
    const b = await fetchT('https://pan.quark.cn/', { headers: { 'User-Agent': UA, Cookie: cookieStr(jar) } }).catch(() => null);
    if (b) { Object.assign(jar, parseCookies(b)); await b.text().catch(() => {}); }
    const cookie = cookieStr(jar);
    if (!/__puus=/.test(cookie) && !/__pus=/.test(cookie)) throw new Error('已扫码但没换到有效 Cookie（缺 __puus），请重试一次');
    const cfg = await fetchT('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc', { headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://pan.quark.cn/' } }).catch(() => null);
    const cfgJ = cfg ? await cfg.json().catch(() => null) : null;
    if (!cfgJ || cfgJ.status !== 200) throw new Error('Cookie 验证未通过（config 接口未返回 200），请重试一次');
    return { state: 'done', creds: { quarkCookie: cookie } };
  },
};
const uc = {
  async start() {
    const r = await casStart(381, 300)();
    return { qr: `https://su.uc.cn/1_n0ZCv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt&token=${r.token}&client_id=381&uc_biz_str=S%3Acustom%7CC%3Atitlebar_fix`, params: { token: r.token } };
  },
  async poll(p) {
    const r = await casPoll(381, p.token);
    if (r.state !== 'ticket') return { state: r.state };
    const jar = {};
    const steps = [
      `https://drive.uc.cn/account/info?st=${encodeURIComponent(r.ticket)}`,
      'https://drive.uc.cn/',
      'https://pc-api.uc.cn/1/clouddrive/file/sort?pr=UCBrowser&fr=pc&_size=50&_page=1&_fetch_total=1&_sort=file_type:asc,updated_at:desc',
    ];
    for (const u of steps) {
      const resp = await fetchT(u, { headers: { 'User-Agent': u.includes('pc-api') ? UC_APP_UA : UA, Cookie: cookieStr(jar), Referer: 'https://drive.uc.cn/' } }).catch(() => null);
      if (resp) { Object.assign(jar, parseCookies(resp)); await resp.text().catch(() => {}); }
    }
    const cookie = cookieStr(jar);
    if (!/__pus|__puus/.test(cookie)) throw new Error('UC 已确认但没换到完整 Cookie，请重试');
    return { state: 'done', creds: { ucCookie: cookie } };
  },
};

/* ================= 阿里（passport mini_login 二维码） ================= */
const ALI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const aliyun = {
  async start() {
    const umidToken = 'c' + now() + Math.floor(1000 + Math.random() * 9000);
    const initParams = new URLSearchParams({ lang: 'zh_cn', appName: 'aliyun_drive', appEntrance: 'web_default', styleType: 'auto', bizParams: '', notLoadSsoView: 'false', notKeepLogin: 'false', isMobile: 'false', rnd: String(Math.random()) });
    const html = await (await fetchT(`https://passport.alipan.com/mini_login.htm?${initParams}`, { headers: { 'User-Agent': ALI_UA, Referer: 'https://auth.alipan.com/', Accept: 'text/html,application/xhtml+xml' } })).text();
    const csrf = (html.match(/name="_csrf_token"\s+value="(.+?)"/) || html.match(/"_csrf_token":"(.+?)"/) || [])[1] || (uuid() + uuid());
    const genParams = new URLSearchParams({ appName: 'aliyun_drive', fromSite: '52', appEntrance: 'web_default', _csrf_token: csrf, umidToken, hsiz: '', bizParams: 'taobaoBizLoginFrom=web_default&renderRefer=https%3A%2F%2Fauth.alipan.com%2F', mainPage: 'false', isMobile: 'false', lang: 'zh_CN', returnUrl: '', umidTag: 'SERVER' });
    const j = await (await fetchT(`https://passport.alipan.com/newlogin/qrcode/generate.do?${genParams}`, { headers: { 'User-Agent': ALI_UA, Referer: 'https://auth.alipan.com/', Accept: 'application/json, text/plain, */*' } })).json().catch(() => null);
    const d = j && j.content && j.content.data;
    if (!d || !d.codeContent) throw new Error('阿里二维码获取失败：' + JSON.stringify(j).slice(0, 140));
    return { qr: d.codeContent, params: { t: d.t, ck: d.ck, csrf, umid: umidToken } };
  },
  async poll(p) {
    const body = new URLSearchParams({ t: p.t, ck: p.ck, appName: 'aliyun_drive', fromSite: '52', _csrf_token: p.csrf, umidToken: p.umid || '', navUserAgent: ALI_UA, deviceId: 'ympan_qr_001' });
    const j = await (await fetchT('https://passport.alipan.com/newlogin/qrcode/query.do', {
      method: 'POST', headers: { 'User-Agent': ALI_UA, Referer: 'https://auth.alipan.com/', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, text/plain, */*' }, body: body.toString(),
    })).json().catch(() => null);
    const d = j && j.content && j.content.data;
    if (!d) return { state: 'waiting' };
    const st = d.qrCodeStatus;
    if (st === 'NEW') return { state: 'waiting' };
    if (st === 'SCANED') return { state: 'scanned' };
    if (st === 'EXPIRED' || st === 'CANCEL') return { state: 'expired' };
    if (st !== 'CONFIRMED') return { state: 'waiting' };
    let rt = '', at = '';
    try {
      let b64 = String(d.bizExt || '').replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const biz = JSON.parse(atob(b64));
      const pds = biz.pds_login_result || {};
      rt = pds.refreshToken || pds.refresh_token || '';
      at = pds.accessToken || pds.access_token || '';
      if (!at || !at.startsWith('eyJ')) for (const k of Object.keys(pds)) { const v = pds[k]; if (typeof v === 'string' && v.startsWith('eyJ') && v.length > 200 && k !== 'refreshToken') { at = v; break; } }
    } catch { /* 落到刷新令牌兑换 */ }
    const creds = {};
    if (rt) {
      creds.aliRefresh = rt;
      try {
        const tj = await (await fetchT('https://open.aliyundrive.com/oauth/access_token', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ALI_UA, Origin: 'https://www.alipan.com', Referer: 'https://www.alipan.com/' },
          body: JSON.stringify({ client_id: '25dzX3vbYqktVxyX', grant_type: 'refresh_token', refresh_token: rt }),
        })).json();
        if (tj.access_token) { at = tj.access_token; if (tj.refresh_token) creds.aliRefresh = tj.refresh_token; }
      } catch { /* 用 bizExt 的 accessToken 兜底 */ }
    }
    if (at) creds.aliAuth = at;
    if (!creds.aliAuth && !creds.aliRefresh) throw new Error('阿里已确认但没换到令牌，请重试');
    return { state: 'done', creds };
  },
};

/* ================= 移动云盘（orchestration 签名流） ================= */
const MC_VER = '7.17.2', MC_CLIENT = '10701';
function mcSign(bodyObj, deviceId) {
  const d = new Date(); const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const rand = new Uint8Array(16); crypto.getRandomValues(rand);
  let nonce = ''; for (let i = 0; i < 16; i++) nonce += chars[rand[i] % chars.length];
  let s = '';
  if (bodyObj) {
    s = JSON.stringify(bodyObj);
    s = encodeURIComponent(s); // 纯 encodeURIComponent：%2F 绝不能还原成 /——2026-11-10 实测，还原后含 / 的 base64 报文签名必被上游拒（签名校验失败），官方 JS 客户端用的就是未还原口径
    s = s.split('').sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0)).join('');
  }
  const b64s = btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const sign = md5(md5(b64s) + md5(`${ts}:${nonce}`)).toUpperCase();
  return `${ts},${nonce},${sign}`;
}
function mcHeaders(deviceId, sign, extra = {}) {
  return {
    'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'CMS-DEVICE': 'default', DNT: '1', 'INNER-HCY-ROUTER-HTTPS': '1',
    Origin: 'https://yun.139.com', Referer: 'https://yun.139.com/w/', caller: 'web',
    'mcloud-client': MC_CLIENT, 'mcloud-channel': '1000101', 'mcloud-route': '001', 'mcloud-sign': sign,
    'mcloud-version': MC_VER, 'x-deviceinfo': `||9|${MC_VER}|edge||${deviceId}||windows 10||zh-CN|||`,
    'x-yun-channel-source': '10000034', 'x-yun-svc-type': '1', 'x-SvcType': '1', 'User-Agent': UA, ...extra,
  };
}
const cmcc = {
  async start() {
    const deviceId = hexUuid().slice(0, 32), sid = hexUuid().slice(0, 16), aesKey = hexUuid().slice(0, 16);
    const keyBody = { clientCode: MC_CLIENT, type: '1' };
    const kj = await (await fetchT('https://yun.139.com/orchestration/auth-rebuild/key/v1.0/getRsaPublicKey', {
      method: 'POST', headers: mcHeaders(deviceId, mcSign(keyBody, deviceId)), body: JSON.stringify(keyBody),
    })).json().catch(() => null);
    if (!kj || !kj.success || !kj.data || !kj.data.publicKey) throw new Error('移动云盘密钥协商失败：' + JSON.stringify(kj).slice(0, 140));
    const { n, e } = parseRsaPublicKey(kj.data.publicKey);
    const skey = rsaEncrypt(n, e, aesKey);
    return { qr: `https://yun.139.com/w/#/qrcLogin?sID=${sid}&dID=${deviceId}&cType=9`, params: { deviceId, sid, aesKey, skey } };
  },
  async poll(p) {
    const inner = { dycPwd: p.sid, loginStyle: 'QRCode', clientEnv: '3', setCookie: 0 };
    const encBytes = await aesEcbBytes(p.aesKey, new TextEncoder().encode(JSON.stringify(inner)));
    const body = { encryptMsg: b64(encBytes), clientId: MC_CLIENT, returnToken: true };
    const j = await (await fetchT('https://yun.139.com/orchestration/auth-rebuild/permission/v1.0/login', {
      method: 'POST', headers: mcHeaders(p.deviceId, mcSign(body, p.deviceId), { 'mcloud-skey': p.skey || '', 'x-huawei-channelSrc': '10000034', 'x-inner-ntwk': '2', 'x-m4c-caller': 'PC', 'x-m4c-src': '10002' }), body: JSON.stringify(body),
    })).json().catch(() => null);
    const data = (j && j.data) || {};
    const code = (data.result && data.result.resultCode) || '';
    if (j && j.success && code === '0') {
      const token = data.authToken || data.token;
      if (!token) throw new Error('移动已确认但没返回令牌');
      let phone = '';
      try { phone = atob(data.encryptAccount || ''); } catch { phone = data.simplifyAccount || ''; }
      if (!phone) throw new Error('移动已确认但没返回账号，请重试');
      return { state: 'done', creds: { cmccAuth: 'Basic ' + btoa(`pc:${phone}:${token}`) } };
    }
    if (code === '200059548') return { state: 'scanned' };
    if (code === '200059542' || code === '200059549') return { state: 'expired' };
    return { state: 'waiting' };
  },
};

/* ================= 天翼云盘（logbox oauth2） ================= */
const C189_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0';
const ctyun = {
  async start() {
    let cloud = '', cloudDom = '', openE = '', loginPageUrl = 'https://open.e.189.cn/api/logbox/separate/web/index.html?appId=8025431004';
    let lt = '', reqId = '', paramId = '', html = '';
    let cur = `https://cloud.189.cn/api/portal/unifyLoginForPC.action?appId=8025431004&clientType=10020&returnURL=${encodeURIComponent('https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html')}&timeStamp=${now()}`;
    for (let hop = 0; hop < 5; hop++) {
      const host = new URL(cur).hostname;
      const resp = await fetchT(cur, { headers: { 'User-Agent': C189_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9', ...(host.includes('open.e.189.cn') ? (openE ? { Cookie: openE } : {}) : (cloudDom ? { Cookie: cloudDom } : {})) }, redirect: 'manual' });
      const cs = cookieStr(parseCookies(resp));
      if (cs) {
        cloud = mergeCookieStr(cloud, cs);
        if (host.includes('open.e.189.cn')) openE = mergeCookieStr(openE, cs); else cloudDom = mergeCookieStr(cloudDom, cs);
      }
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) break;
        cur = new URL(loc, cur).href; continue;
      }
      html = await resp.text(); loginPageUrl = cur; break;
    }
    lt = (html.match(/lt\s*=\s*"([A-F0-9]{16,})"/i) || [])[1] || '';
    reqId = (html.match(/reqId\s*=\s*"([^"]{10,})"/i) || [])[1] || '';
    paramId = (html.match(/paramId\s*=\s*"([^"]*)"/i) || [])[1] || '';
    if (!lt) { // 方式2：直达 logbox 页，从跳转参数里取
      const alt = 'https://open.e.189.cn/api/logbox/separate/web/index.html?appId=8025431004';
      const r1 = await fetchT(alt, { headers: { 'User-Agent': C189_UA, Accept: 'text/html' }, redirect: 'manual' });
      const cs = cookieStr(parseCookies(r1));
      if (cs) { cloud = mergeCookieStr(cloud, cs); openE = mergeCookieStr(openE, cs); }
      const loc = r1.headers.get('location');
      if (loc) {
        const u2 = new URL(loc, alt);
        lt = u2.searchParams.get('lt') || lt; reqId = u2.searchParams.get('reqId') || reqId; loginPageUrl = u2.href;
      }
    }
    if (!reqId) reqId = hexUuid().slice(0, 32);
    const uh = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://open.e.189.cn', Referer: loginPageUrl, Accept: '*/*', 'User-Agent': C189_UA };
    if (lt) uh.lt = lt;
    if (reqId) uh.reqid = reqId;
    if (openE) uh.Cookie = openE;
    const uj = await (await fetchT('https://open.e.189.cn/api/logbox/oauth2/getUUID.do', { method: 'POST', headers: uh, body: 'appId=8025431004' })).json().catch(() => null);
    if (!uj || !uj.uuid) throw new Error('天翼二维码获取失败：' + JSON.stringify(uj).slice(0, 140));
    // 官方页的码是 image.do 出的一张图（uuid 传 encodeuuid），不是把 uuid 文本画成码（2026-11-10 对照官方页 App.js 实证）
    const qrImg = `https://open.e.189.cn/api/logbox/oauth2/image.do?uuid=${uj.encodeuuid || encodeURIComponent(uj.uuid)}&REQID=${reqId}`;
    return { qrImg, params: { uuid: uj.uuid, encryuuid: uj.encryuuid || '', lt, reqId, paramId, loginPageUrl, cloud, cloudDom, openE } };
  },
  async poll(p) {
    // 轮询口径必须与官方页 App.js 一字不差（2026-11-10 实证）：clientType=1、只带 REQID 头+会话 Cookie、
    // date 是北京时间「yyyy-MM-ddhh:mm:ss」+0~23 随机数、returnUrl 先 encodeURIComponent 再随表单二次编码。
    // 旧口径（clientType 10020 + lt/reqid 头）会被上游回 result -20099「页面已过期」——前端首轮轮询就把码撤了，表现为「不出码」。
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    const dateStr = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}` + Math.floor(24 * Math.random());
    const body = new URLSearchParams({
      appId: '8025431004', encryuuid: p.encryuuid || '', date: dateStr, uuid: p.uuid,
      returnUrl: encodeURIComponent('https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html'),
      clientType: '1', timeStamp: String(Date.now()), cb_SaveName: '1', isOauth2: '', state: '', paramId: p.paramId || '',
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://open.e.189.cn', Referer: p.loginPageUrl || 'https://open.e.189.cn/', 'User-Agent': C189_UA };
    if (p.reqId) headers.REQID = p.reqId;
    if (p.openE) headers.Cookie = p.openE;
    const resp = await fetchT('https://open.e.189.cn/api/logbox/oauth2/qrcodeLoginState.do', { method: 'POST', headers, body: body.toString() });
    const pollCookies = cookieStr(parseCookies(resp));
    const j = await resp.json().catch(() => null);
    if (!j) return { state: 'waiting' };
    if (j.result === -20099) return { state: 'expired' };
    if (!(j.status === 0 || j.redirectUrl)) {
      if (j.msg && /过期|失效/.test(j.msg)) return { state: 'expired' };
      return { state: 'waiting' };
    }
    const q = new URLSearchParams({ clientType: 'TELEPC', version: '7.1.8.0', channelId: 'web_cloud.189.cn', rand: String(now()), redirectURL: j.redirectUrl || '' });
    const sr = await fetchT(`https://api.cloud.189.cn/getSessionForPC.action?${q}`, { method: 'POST', headers: { Accept: 'application/json;charset=UTF-8', 'User-Agent': C189_UA, 'X-Request-ID': uuid() } });
    const sCookies = parseCookies(sr);
    const sj = await sr.json().catch(() => null);
    let clu = sCookies.COOKIE_LOGIN_USER || '', sson = sCookies.SSON || '';
    if (!clu && j.redirectUrl) { // 兜底：跟随 redirectUrl 收集 cookie
      let cur2 = j.redirectUrl; const jar = {};
      for (let i = 0; i < 8; i++) {
        const rr = await fetchT(cur2, { headers: { 'User-Agent': C189_UA, Accept: 'text/html', ...(cookieStr(jar) ? { Cookie: cookieStr(jar) } : {}) }, redirect: 'manual' }).catch(() => null);
        if (!rr) break;
        Object.assign(jar, parseCookies(rr));
        if (jar.COOKIE_LOGIN_USER) { clu = jar.COOKIE_LOGIN_USER; sson = jar.SSON || sson; break; }
        const loc = rr.headers.get('location');
        if (!(rr.status >= 300 && rr.status < 400) || !loc) break;
        cur2 = new URL(loc, cur2).href;
      }
    }
    if (!sj || sj.res_code !== 0) throw new Error('天翼会话换取失败：' + (sj ? (sj.res_message || JSON.stringify(sj).slice(0, 100)) : '无响应'));
    let cookie = mergeCookieStr(p.openE || '', pollCookies);
    cookie = mergeCookieStr(cookie, cookieStr(sCookies));
    if (clu && !cookie.includes('COOKIE_LOGIN_USER=')) cookie = mergeCookieStr(cookie, `COOKIE_LOGIN_USER=${clu}`);
    if (sson && !cookie.includes('SSON=')) cookie = mergeCookieStr(cookie, `SSON=${sson}`);
    if (!cookie) throw new Error('天翼已确认但没换到 Cookie，请重试');
    return { state: 'done', creds: { ctCookie: cookie } };
  },
};

/* ================= 光鸭（OAuth 设备码流） ================= */
const GY_CLIENT = 'aMe-8VSlkrbQXpUR';
const guangya = {
  async start() {
    const j = await (await fetchT('https://account.guangyapan.com/v1/auth/device/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', Origin: 'https://www.guangyapan.com', Referer: 'https://www.guangyapan.com/', 'User-Agent': UA },
      body: JSON.stringify({ client_id: GY_CLIENT, device_id: uuid(), scope: 'user profile sso offline_access' }),
    })).json().catch(() => null);
    if (!j || !j.device_code || !j.verification_uri_complete) throw new Error('光鸭设备码获取失败：' + JSON.stringify(j).slice(0, 140));
    return { qr: j.verification_uri_complete, params: { device_code: j.device_code } };
  },
  async poll(p) {
    const j = await (await fetchT('https://account.guangyapan.com/v1/auth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', Origin: 'https://www.guangyapan.com', Referer: 'https://www.guangyapan.com/', 'User-Agent': UA },
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: p.device_code, client_id: GY_CLIENT }),
    })).json().catch(() => null);
    if (j && j.access_token) return { state: 'done', creds: { gyToken: j.access_token, ...(j.refresh_token ? { gyRefresh: j.refresh_token } : {}) } };
    const err = (j && j.error) || '';
    if (err === 'expired_token') return { state: 'expired' };
    if (err === 'access_denied') throw new Error('光鸭 App 里拒绝了登录');
    return { state: 'waiting' };
  },
};


/* 小飞机密钥派生（照 JxPan：用 'AES/ECB/PKCS5Pad' 解开官方下发的密钥块取真密钥） */
const _AES_SBOX=[99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22],_AES_INV_SBOX=[82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37,114,248,246,100,134,104,152,22,212,164,92,204,93,101,182,146,108,112,72,80,253,237,185,218,94,21,70,87,167,141,157,132,144,216,171,0,140,188,211,10,247,228,88,5,184,179,69,6,208,44,30,143,202,63,15,2,193,175,189,3,1,19,138,107,58,145,17,65,79,103,220,234,151,242,207,206,240,180,230,115,150,172,116,34,231,173,53,133,226,249,55,232,28,117,223,110,71,241,26,113,29,41,197,137,111,183,98,14,170,24,190,27,252,86,62,75,198,210,121,32,154,219,192,254,120,205,90,244,31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125],_RCON=[1,2,4,8,16,32,64,128,27,54];function _aesXtime(a){return(a<<1^(a>>7&1)*27)&255}function _aesMul(a,b){let r=0,t=a;for(let i=0;i<8;i++){if((b&1)!==0){r^=t}t=_aesXtime(t);b>>=1}return r}function _aesKeyExpansion(key){const nk=key.length/4,nr=nk===4?10:nk===6?12:14,w=Array.from(key);for(let i=nk;i<4*(nr+1);i++){let temp=w.slice((i-1)*4,i*4);if(i%nk===0){temp=[_AES_SBOX[temp[1]]^_RCON[i/nk-1],_AES_SBOX[temp[2]],_AES_SBOX[temp[3]],_AES_SBOX[temp[0]]]}else{if(nk>6&&i%nk===4){temp=temp.map(b=>{return _AES_SBOX[b]})}}for(let j=0;j<4;j++)w[i*4+j]=w[(i-nk)*4+j]^temp[j]}const roundKeys=[];for(let i=0;i<=nr;i++)roundKeys.push(w.slice(i*16,i*16+16));return roundKeys}function _aesEcbDecrypt(ciphertext,keyBytes){const roundKeys=_aesKeyExpansion(keyBytes),nr=roundKeys.length-1;function invSubBytes(state){return state.map(b=>{return _AES_INV_SBOX[b]})}function invShiftRows(state){return[state[0],state[13],state[10],state[7],state[4],state[1],state[14],state[11],state[8],state[5],state[2],state[15],state[12],state[9],state[6],state[3]]}function addRoundKey(state,rk){return state.map((b,i)=>{return b^rk[i]})}function invMixColumns(s){let r=new Array(16);for(let c=0;c<4;c++){let i=c*4,a=s.slice(i,i+4);r[i]=_aesMul(a[0],14)^_aesMul(a[1],11)^_aesMul(a[2],13)^_aesMul(a[3],9);r[i+1]=_aesMul(a[0],9)^_aesMul(a[1],14)^_aesMul(a[2],11)^_aesMul(a[3],13);r[i+2]=_aesMul(a[0],13)^_aesMul(a[1],9)^_aesMul(a[2],14)^_aesMul(a[3],11);r[i+3]=_aesMul(a[0],11)^_aesMul(a[1],13)^_aesMul(a[2],9)^_aesMul(a[3],14)}return r}function aesDecryptBlock(block){let state=block.slice(0);state=addRoundKey(state,roundKeys[nr]);for(let rnd=nr-1;rnd>0;rnd--){state=invShiftRows(state);state=invSubBytes(state);state=addRoundKey(state,roundKeys[rnd]);state=invMixColumns(state)}state=invShiftRows(state);state=invSubBytes(state);state=addRoundKey(state,roundKeys[0]);return state}let result=[];for(let i=0;i<ciphertext.length;i+=16){let block=ciphertext.slice(i,i+16),decrypted=aesDecryptBlock(block);result=result.concat(decrypted)}return new Uint8Array(result)}
function feijiFinalKey() {
  const enc = Uint8Array.from(atob('YbQHZqK/PdQql2+7ATcPQHREAxt0Hn0Ob9v317QirZM='), c => c.charCodeAt(0));
  const pw = Uint8Array.from('AES/ECB/PKCS5Pad', c => c.charCodeAt(0));
  try {
    const dec = _aesEcbDecrypt(enc, pw);
    if (dec.length >= 16) return dec.slice(0, 16);
  } catch { /* 落到已知密钥 */ }
  return Uint8Array.from('dingHao-disk-app', c => c.charCodeAt(0));
}

/* ================= 小飞机（账号密码，仅此一家） ================= */
const feijipan = {
  async login(username, password) {
    const id = uuid();
    // 注意：密文字节转 hex 必须用 [...bytes] 展开——Uint8Array 的 .map 返回同类数组，
    // 数字再 .join('') 是十进制拼接不是 hex（2026-11-08 实测定位的暗病）。
    const mkEncTs = async () => [...(await aesEcbBytes(feijiFinalKey(), new TextEncoder().encode(String(now()))))].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    const base = `https://api.feijipan.com/ws/login?uuid=${id}&devType=6&devCode=${id}&devModel=chrome&devVersion=151&appVersion=`;
    const headers = { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json, text/plain, */*', Referer: 'https://www.feijipan.com/', Origin: 'https://www.feijipan.com', 'User-Agent': UA };
    const body = JSON.stringify({ loginName: username, loginPwd: password });
    // 小飞机上游偶尔慢/丢响应（实测 10~60 秒级抖动）：45 秒超时，无响应时换新时间戳整单重试一次
    const attempt = async () => { try { return await (await fetchT(`${base}&timestamp=${await mkEncTs()}&appToken=&extra=2`, { method: 'POST', headers, body }, 45000)).json(); } catch { return null; } };
    let j = await attempt();
    if (!j) j = await attempt();
    if (j && j.code !== 200 && /时间/.test(j.msg || '')) {
      // 时间戳只认加密形式（明文必被拒）：用全新加密时间戳重试一次
      j = await attempt();
    }
    if (j && j.code === 200 && j.data && j.data.appToken) return { state: 'done', creds: { fjToken: j.data.appToken } };
    throw new Error('小飞机登录失败：' + (j ? (j.msg || JSON.stringify(j).slice(0, 120)) : '上游无响应（它家接口偶尔很慢），请稍后重试'));
  },
};

/* ================= 123（账号密码，官方 sign_in 接口；口径对照 OpenList 123 驱动与 bao-qing/123pan） =================
   passport 是注册手机号；密码明文只透传给官方接口换 token，本站不保存、不记录。 */
const pan123 = {
  async login(username, password) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', platform: 'web', Referer: 'https://www.123pan.com/', Origin: 'https://www.123pan.com', 'User-Agent': UA };
    const bases = ['https://api.123278.com/api', 'https://login.123pan.com/api', 'https://www.123pan.cn/b/api'];
    let j = null, lastErr = '';
    for (const b of bases) {
      try {
        j = await (await fetchT(`${b}/user/sign_in`, { method: 'POST', headers, body: JSON.stringify({ type: 1, passport: username, password }) }, 30000)).json();
        if (j) break;
      } catch (e) { lastErr = String((e && e.message) || e); }
    }
    if (j && j.code === 0 && j.data && j.data.token) return { state: 'done', creds: { p123Token: j.data.token } };
    const upstreamMsg = j ? (j.message || JSON.stringify(j).slice(0, 120)) : '';
    // 123 官方按登录来源 IP 做风控：本站请求从 Cloudflare 境外节点发出，会被判「境外登录风险」
    // 并要求短信/微信验证，账密通道在本站出口下走不通（2026-11-10 站长真账号实测）。
    // 命中时把话说清并指路手填，别只甩上游原文让用户干瞪眼。
    if (/境外|风险|短信验证码|微信/.test(upstreamMsg)) {
      throw new Error('123 官方风控拦截：它按登录 IP 判断风险，本站请求从境外服务器发出会被拦（不是你账号密码的问题）。请改用手填：在你自己的手机/电脑浏览器里登录 123 网盘官网，从请求头里复制 Authorization 填到上方凭证表，效果一样。');
    }
    throw new Error('123 登录失败：' + (j ? upstreamMsg : ('上游无响应' + (lastErr ? `（${lastErr.slice(0, 60)}）` : '') + '，请稍后重试')));
  },
};

/* ================= 123 扫码登录（官网 Web 登录页同款通道；口径照公开实现 OlyMarco/123pan-uploader-cli 的 qr_login.py 逐行对照，2026-11-10 服务端全链实测） =================
   同一张码支持微信扫与 123 App 扫（result 的 scanPlatform 区分扫码端；微信扫需账号绑过微信，App 扫不需要）。
   start：先 GET user.123pan.cn/centerlogin 建会话（Cookie 随 params 在访客浏览器与本站间带回，本站无状态）→
     GET /api/user/qr-code/generate?uniID=<自造 uuid> → 服务端 uniID + 落地页 url；
     二维码内容 = url?uniID=<uniID>&env=production&source=123pan&type=login（env=production 必带，否则扫码页注册不了扫码）。
   poll：GET /api/user/qr-code/result?uniID&remember=true&gray=true → loginStatus 0 未扫 / 1 已扫 / 2 已确认 / 3 过期 / 4 无会话；
     result 本身不带令牌：状态 ≥1 起试换令牌 —— POST /api/user/qr-code/wx_code {uniID} → data.wxCode →
     POST /api/user/sign_in {from:'web', wechat_code, type:4, remember:true, gray:true} → data.token（或 sso-token Cookie）。
     另留 result code=200 直带 token 的兜底分支（官网前端代码里有此分支）。码约 60 秒过期。 */
const P123_HOST = 'https://user.123pan.cn';
const P123_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0';
const p123Headers = (p) => ({
  'User-Agent': P123_UA, Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json',
  Origin: P123_HOST, Referer: P123_HOST + '/centerlogin?redirect_url=https%3A%2F%2Fyun.123pan.cn&source_page=website',
  platform: 'web', 'app-version': '132', loginuuid: (p && p.loginuuid) || '', ...((p && p.ck) ? { Cookie: p.ck } : {}),
});
const p123RandHex64 = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');

pan123.start = async function () {
  const p = { loginuuid: p123RandHex64(), ck: '' };
  try {
    const r0 = await fetchT(P123_HOST + '/centerlogin', { headers: { 'User-Agent': P123_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } }, 20000);
    p.ck = cookieStr(parseCookies(r0));
  } catch { /* 建会话失败不硬停，下一步会直接暴露问题 */ }
  const j = await (await fetchT(`${P123_HOST}/api/user/qr-code/generate?uniID=${uuid()}`, { headers: p123Headers(p) }, 20000)).json().catch(() => null);
  if (!j || j.code !== 0 || !j.data || !j.data.uniID) throw new Error('123 扫码二维码生成失败：' + (j ? (j.message || 'code ' + j.code) : '上游无响应，请稍后重试'));
  const page = j.data.url || 'https://yun.123pan.cn/wx-app-login.html';
  return { qr: `${page}?uniID=${j.data.uniID}&env=production&source=123pan&type=login`, params: { uniID: j.data.uniID, loginuuid: p.loginuuid, ck: p.ck } };
};

async function p123Exchange(p) {
  // wx_code → sign_in type=4 换令牌；wxCode 还没就绪返回 null，sign_in 明确失败则把上游话抛出去
  const wj = await (await fetchT(`${P123_HOST}/api/user/qr-code/wx_code`, { method: 'POST', headers: p123Headers(p), body: JSON.stringify({ uniID: p.uniID }) }, 20000)).json().catch(() => null);
  const wxCode = wj && wj.code === 0 && wj.data ? (wj.data.wxCode || wj.data.wechat_code || '') : '';
  if (!wxCode) return null;
  const resp = await fetchT(`${P123_HOST}/api/user/sign_in`, { method: 'POST', headers: p123Headers(p), body: JSON.stringify({ from: 'web', wechat_code: wxCode, type: 4, remember: true, gray: true }) }, 30000);
  const sj = await resp.json().catch(() => null);
  if (!sj || (sj.code !== 0 && sj.code !== 200)) throw new Error('123 扫码换令牌失败：' + (sj ? (sj.message || 'code ' + sj.code) : '上游无响应'));
  let token = (sj.data && sj.data.token) || '';
  if (!token) token = parseCookies(resp)['sso-token'] || '';
  if (!token) throw new Error('123 扫码已确认，但换令牌的返回里没有 token（字段：' + Object.keys(sj.data || {}).join('/') + '），请把这句截图发站长');
  return String(token).replace(/^Bearer /, '');
}

pan123.poll = async function (p) {
  const q = `uniID=${encodeURIComponent((p && p.uniID) || '')}&remember=true&gray=true`;
  const j = await (await fetchT(`${P123_HOST}/api/user/qr-code/result?${q}`, { headers: p123Headers(p || {}) }, 20000)).json().catch(() => null);
  if (!j) return { state: 'waiting' };
  if (j.code === 200) {
    const d = j.data || {};
    const token = d.token || d.authorToken || d.access_token || '';
    if (token) return { state: 'done', creds: { p123Token: String(token).replace(/^Bearer /, '') } };
    const t = await p123Exchange(p);
    if (t) return { state: 'done', creds: { p123Token: t } };
    return { state: 'scanned' };
  }
  if (j.code !== 0) return { state: 'waiting' };
  const st = j.data && j.data.loginStatus;
  if (st === 0 || st == null) return { state: 'waiting' };
  if (st === 1) {
    const t = await p123Exchange(p).catch(() => null);
    if (t) return { state: 'done', creds: { p123Token: t } };
    return { state: 'scanned' };
  }
  if (st === 2) {
    const t = await p123Exchange(p);
    if (t) return { state: 'done', creds: { p123Token: t } };
    return { state: 'scanned' };
  }
  if (st === 3) {
    const t = await p123Exchange(p).catch(() => null);
    if (t) return { state: 'done', creds: { p123Token: t } };
    return { state: 'expired' };
  }
  return { state: 'expired' };
};

const DRIVES = { baidu, quark, uc, aliyun, cmcc, ctyun, guangya, pan123 };

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let drive = url.searchParams.get('drive') || '';
  let action = url.searchParams.get('action') || '';
  let body = {};
  if (request.method === 'POST') {
    body = await request.json().catch(() => ({}));
    drive = body.drive || drive; action = body.action || action;
  }
  try {
    if ((drive === 'feijipan' || drive === 'pan123') && action === 'login') {
      const NAME = drive === 'feijipan' ? '小飞机' : '123';
      const username = String(body.username || '').trim(), password = String(body.password || '');
      if (!username || !password) throw new Error(`请填${NAME}的账号和密码`);
      // 账密登录会透传官方接口换令牌：按来源 IP 限流防匿名撞库（15 分钟最多 30 次尝试）
      if (env && env.PAN_KV) {
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const key = 'rl:pwdlogin:' + ip;
        let r = { n: 0, winStart: 0 };
        try { r = JSON.parse((await env.PAN_KV.get(key)) || '') || r; } catch {}
        const now = Date.now();
        if (!r.winStart || now - r.winStart > 15 * 60 * 1000) { r.n = 0; r.winStart = now; }
        r.n++;
        try { await env.PAN_KV.put(key, JSON.stringify(r), { expirationTtl: 2 * 24 * 3600 }); } catch {}
        if (r.n > 30) throw new Error('登录尝试太频繁，请 15 分钟后再试');
      }
      const r = await (drive === 'feijipan' ? feijipan.login(username, password) : pan123.login(username, password));
      return json({ ok: true, drive, ...r });
    }
    const d = DRIVES[drive];
    if (!d) throw new Error('这家暂不支持扫码登录');
    if (action === 'start') {
      const r = await d.start();
      return json({ ok: true, drive, ...r });
    }
    if (action === 'poll') {
      const params = body.params || Object.fromEntries(url.searchParams.entries());
      const r = await d.poll(params);
      return json({ ok: true, drive, ...r });
    }
    throw new Error('未知操作');
  } catch (e) {
    return json({ ok: false, drive, error: String((e && e.message) || e) }, 200);
  }
}
