// 访客扫码登录（百度 / 夸克 / UC）：用各家 App 扫码代替手工挖 Cookie。
// 凭证只回给扫码者自己的浏览器（存其 localStorage），服务器不落盘、不经 KV。
// 协议均照久经验证的开源实现逐字对照（原创协议格式必须对照成熟实现——2026-11-07 夸克巡检踩坑教训）：
// - 百度：passport getqrcode → channel/unicast 长轮询 → v3/login/main/qrbdusslogin 换 BDUSS/STOKEN
//         （BaiduPCS-Go 等多家实现一致；2026-11-08 起始/等待两步实测通过）
// - 夸克：uop.quark.cn CAS（xiaoya-alist 格式：ssb=weblogin + uc_biz_str；与巡检 qr.js 同源，已生产验证）
// - UC：api.open.uc.cn CAS（xiaoya-alist uc_cookie.py：client_id=381、su.uc.cn/1_n0ZCv、
//       drive.uc.cn/account/info 换 Cookie 后再调 pc-api 补 __puus；2026-11-08 起始/等待两步实测通过）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const QUARK_CLIENT_ID = '532';
const UC_CLIENT_ID = '381';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

class Jar {
  constructor() { this.map = new Map(); }
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
  str() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(k) { return this.map.get(k); }
}

/* ---------------- 百度 ---------------- */

function baiduGid() {
  const hex = '0123456789ABCDEF';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

async function baiduStart() {
  const gid = baiduGid();
  const now = Date.now();
  const cb = 'bd__cbs__ympan';
  const u = `https://passport.baidu.com/v2/api/getqrcode?lp=pc&qrloginfrom=pc&gid=${gid}&callback=${cb}&apiver=v3&tt=${now}&tpl=netdisk&_=${now}`;
  const t = await (await fetch(u, { headers: { 'User-Agent': UA } })).text();
  const m = t.match(/\{.*\}/s);
  if (!m) return json({ ok: false, error: '百度二维码获取失败（上游无响应）' });
  const d = JSON.parse(m[0]);
  if (!d.sign) return json({ ok: false, error: '百度二维码获取失败，上游可能改版' });
  return json({ ok: true, drive: 'baidu', sign: d.sign, gid, qrImg: 'https://' + d.imgurl });
}

async function baiduPoll(sign, gid) {
  const cb = 'bd__cbs__ympan';
  const now = Date.now();
  const u = `https://passport.baidu.com/channel/unicast?channel_id=${encodeURIComponent(sign)}&tpl=netdisk&gid=${gid}&callback=${cb}&apiver=v3&tt=${now}&_=${now}`;
  let t;
  try {
    t = await (await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(40000) })).text();
  } catch (e) {
    return json({ ok: true, state: 'waiting' }); // 长轮询超时按等待处理，前端会继续轮
  }
  const m = t.match(/\{.*\}/s);
  if (!m) return json({ ok: true, state: 'waiting' });
  let d;
  try { d = JSON.parse(m[0]); } catch (e) { return json({ ok: true, state: 'waiting' }); }
  if (!d.channel_v) return json({ ok: true, state: 'waiting' });
  let cv = d.channel_v;
  if (typeof cv === 'string') { try { cv = JSON.parse(cv); } catch (e) { return json({ ok: true, state: 'waiting' }); } }
  if (cv.status === 1) return json({ ok: true, state: 'scanned' });
  if (cv.status !== 0 || !cv.v) return json({ ok: true, state: 'waiting' });
  // 已确认：用临时 bduss 换正式登录 Cookie
  const jar = new Jar();
  const t2 = Date.now();
  const lu = `https://passport.baidu.com/v3/login/main/qrbdusslogin?v=${t2}&bduss=${encodeURIComponent(cv.v)}&loginVersion=v4&qrcode=1&tpl=netdisk&apiver=v3&tt=${t2}&traceid=&time=${t2}&alg=v3&callback=${cb}`;
  const lr = await fetch(lu, { headers: { 'User-Agent': UA } });
  jar.absorb(lr);
  const bduss = jar.get('BDUSS');
  if (!bduss) return json({ ok: false, state: 'error', error: '已确认但没换到 BDUSS，请重新扫码试一次' });
  const cred = { bduss };
  if (jar.get('STOKEN')) cred.stoken = jar.get('STOKEN');
  return json({ ok: true, state: 'done', cred });
}

/* ---------------- 夸克（与巡检 qr.js 同协议，区别：凭证回浏览器不进 KV） ---------------- */

async function quarkStart() {
  const requestId = crypto.randomUUID();
  const r = await fetch(`https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=${QUARK_CLIENT_ID}&v=1.2&request_id=${requestId}`, {
    method: 'POST', headers: { 'User-Agent': UA, Referer: 'https://pan.quark.cn/' },
  });
  const data = await r.json().catch(() => null);
  const token = data && data.data && data.data.members && data.data.members.token;
  if (!token) return json({ ok: false, error: '夸克二维码令牌获取失败，上游可能改版' });
  return json({
    ok: true, drive: 'quark', token, requestId,
    qr: `https://su.quark.cn/4_eMHBJ?token=${encodeURIComponent(token)}&client_id=${QUARK_CLIENT_ID}&ssb=weblogin&uc_param_str=&uc_biz_str=S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400`,
  });
}

async function quarkPoll(token, requestId) {
  const r = await fetch(`https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=${QUARK_CLIENT_ID}&v=1.2&token=${encodeURIComponent(token)}&request_id=${requestId}`, {
    headers: { 'User-Agent': UA, Referer: 'https://pan.quark.cn/' },
  });
  const data = await r.json().catch(() => null);
  const text = JSON.stringify(data || {});
  const ticketM = text.match(/"service_ticket"\s*:\s*"([^"]+)"/);
  if (!ticketM) {
    if (/"status"\s*:\s*50004002/.test(text)) return json({ ok: true, state: 'expired' });
    const scanned = /"status"\s*:\s*(20000|50000|50004003)/.test(text) || /scan/i.test(text);
    return json({ ok: true, state: scanned ? 'scanned' : 'waiting' });
  }
  const jar = new Jar();
  const info = await fetch(`https://pan.quark.cn/account/info?st=${encodeURIComponent(ticketM[1])}`, {
    headers: { 'User-Agent': UA }, redirect: 'follow',
  });
  jar.absorb(info);
  const home = await fetch('https://pan.quark.cn/', {
    headers: { 'User-Agent': UA, Cookie: jar.str() }, redirect: 'follow',
  });
  jar.absorb(home);
  const cookie = jar.str();
  if (!/__puus=/.test(cookie) && !/__pus=/.test(cookie)) {
    return json({ ok: false, state: 'error', error: '已扫码但没换到有效 Cookie（缺 __puus），请重试一次' });
  }
  const cfg = await fetch('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc', {
    headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://pan.quark.cn/' },
  });
  const cfgData = await cfg.json().catch(() => null);
  if (!cfgData || cfgData.status !== 200) {
    return json({ ok: false, state: 'error', error: 'Cookie 验证未通过（config 接口未返回 200）' });
  }
  return json({ ok: true, state: 'done', cred: { quarkCookie: cookie } });
}

/* ---------------- UC（照 xiaoya-alist uc_cookie.py） ---------------- */

function ucDt() { return String(800 + Math.floor(Math.random() * 2500)); }

async function ucStart() {
  const t = Date.now();
  const body = new URLSearchParams({ client_id: UC_CLIENT_ID, v: '1.2', request_id: String(t) });
  const r = await fetch(`https://api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin?__dt=${ucDt()}&__t=${t}`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await r.json().catch(() => null);
  const token = data && data.data && data.data.members && data.data.members.token;
  if (!token) return json({ ok: false, error: 'UC 二维码令牌获取失败，上游可能改版' });
  return json({
    ok: true, drive: 'uc', token,
    qr: `https://su.uc.cn/1_n0ZCv?uc_param_str=dsdnfrpfbivesscpgimibtbmnijblauputogpintnwktprchmt&token=${encodeURIComponent(token)}&client_id=${UC_CLIENT_ID}&uc_biz_str=S%3Acustom%7CC%3Atitlebar_fix`,
  });
}

async function ucPoll(token) {
  const t = Date.now();
  const body = new URLSearchParams({ client_id: UC_CLIENT_ID, v: '1.2', request_id: String(t), token });
  const r = await fetch(`https://api.open.uc.cn/cas/ajax/getServiceTicketByQrcodeToken?__dt=${ucDt()}&__t=${t}`, {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const data = await r.json().catch(() => null);
  if (!data) return json({ ok: true, state: 'waiting' });
  if (data.status === 50004002) return json({ ok: true, state: 'expired' });
  if (data.status !== 2000000) return json({ ok: true, state: 'waiting' });
  const ticket = data.data && data.data.members && data.data.members.service_ticket;
  if (!ticket) return json({ ok: true, state: 'waiting' });
  const jar = new Jar();
  const info = await fetch(`https://drive.uc.cn/account/info?st=${encodeURIComponent(ticket)}`, {
    headers: { 'User-Agent': UA }, redirect: 'follow',
  });
  jar.absorb(info);
  // 再调一次业务接口补 __puus（xiaoya 实现口径，须带 UC 客户端 UA）
  const sort = await fetch('https://pc-api.uc.cn/1/clouddrive/file/sort?pr=UCBrowser&fr=pc&pdir_fid=0&_page=1&_size=50&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,updated_at:desc', {
    headers: { 'User-Agent': UC_UA, Referer: 'https://drive.uc.cn', Cookie: jar.str() },
  });
  jar.absorb(sort);
  const cookie = jar.str();
  if (!/__puus=/.test(cookie)) {
    return json({ ok: false, state: 'error', error: '已扫码但没拿到 __puus，请重试一次' });
  }
  return json({ ok: true, state: 'done', cred: { ucCookie: cookie } });
}

/* ---------------- 入口 ---------------- */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const drive = url.searchParams.get('drive') || '';
  const action = url.searchParams.get('action') || 'start';
  try {
    if (action === 'start') {
      if (drive === 'baidu') return baiduStart();
      if (drive === 'quark') return quarkStart();
      if (drive === 'uc') return ucStart();
      return json({ ok: false, error: '该网盘暂不支持扫码登录' }, 400);
    }
    if (action === 'poll') {
      if (drive === 'baidu') return baiduPoll(url.searchParams.get('sign') || '', url.searchParams.get('gid') || '');
      if (drive === 'quark') return quarkPoll(url.searchParams.get('token') || '', url.searchParams.get('requestId') || '');
      if (drive === 'uc') return ucPoll(url.searchParams.get('token') || '');
      return json({ ok: false, error: '该网盘暂不支持扫码登录' }, 400);
    }
    return json({ ok: false, error: '未知 action' }, 400);
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) });
  }
}
