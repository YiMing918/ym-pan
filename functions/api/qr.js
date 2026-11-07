// 夸克扫码登录 → 巡检凭证存入 KV（绑定名 PAN_KV，键 quark_cookie）
// 供「真解析自检」使用：巡检用部署者自己的夸克账号定期真解析一个固定测试分享。
// 普通访客解析不读这个 Cookie；未绑 KV / 未配 PATROL_KEY 的部署上本接口直接报未启用。
// 安全口径：KV 里还没有凭证时允许首次扫码绑定；已绑定后必须带 x-patrol-key 才能重绑。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CLIENT_ID = '532';

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
}

async function enabled(env) {
  if (!env.PAN_KV || !env.PATROL_KEY) return null;
  return env.PAN_KV;
}

async function start(request, env) {
  const kv = await enabled(env);
  if (!kv) return json({ ok: false, error: '巡检未启用：需要先给项目绑定 KV（PAN_KV）并配置 PATROL_KEY 环境变量' });
  const existing = await kv.get('quark_cookie');
  if (existing && request.headers.get('x-patrol-key') !== env.PATROL_KEY) {
    return json({ ok: false, error: '巡检凭证已绑定。如需重绑，请管理员带巡检口令操作' });
  }
  const requestId = crypto.randomUUID();
  const r = await fetch(`https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=${CLIENT_ID}&v=1.2&request_id=${requestId}`, {
    method: 'POST', headers: { 'User-Agent': UA, Referer: 'https://pan.quark.cn/' },
  });
  const data = await r.json().catch(() => null);
  const token = data && data.data && data.data.members && data.data.members.token;
  if (!token) return json({ ok: false, error: '夸克二维码令牌获取失败，上游可能改版' });
  await kv.put('qr_pending', JSON.stringify({ token, requestId }), { expirationTtl: 300 });
  return json({
    ok: true, token,
    qr: `https://su.quark.cn/4_eMHBJ?token=${encodeURIComponent(token)}&client_id=${CLIENT_ID}&ssb=`,
  });
}

async function poll(env) {
  const kv = await enabled(env);
  if (!kv) return json({ ok: false, error: '巡检未启用' });
  const pendingRaw = await kv.get('qr_pending');
  if (!pendingRaw) return json({ ok: true, state: 'expired' });
  const { token, requestId } = JSON.parse(pendingRaw);
  const r = await fetch(`https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=${CLIENT_ID}&v=1.2&token=${encodeURIComponent(token)}&request_id=${requestId}`, {
    headers: { 'User-Agent': UA, Referer: 'https://pan.quark.cn/' },
  });
  const data = await r.json().catch(() => null);
  const text = JSON.stringify(data || {});
  const ticketM = text.match(/"service_ticket"\s*:\s*"([^"]+)"/);
  if (!ticketM) {
    const scanned = /"status"\s*:\s*(20000|50000)/.test(text) || /scan/i.test(text);
    return json({ ok: true, state: scanned ? 'scanned' : 'waiting' });
  }
  // 拿到 service ticket → 换登录 Cookie
  const jar = new Jar();
  const info = await fetch(`https://pan.quark.cn/account/info?st=${encodeURIComponent(ticketM[1])}`, {
    headers: { 'User-Agent': UA }, redirect: 'follow',
  });
  jar.absorb(info);
  // 再访问一次网盘页补齐业务 Cookie
  const home = await fetch('https://pan.quark.cn/', {
    headers: { 'User-Agent': UA, Cookie: jar.str() }, redirect: 'follow',
  });
  jar.absorb(home);
  const cookie = jar.str();
  if (!/__puus=/.test(cookie) && !/__pus=/.test(cookie)) {
    return json({ ok: false, state: 'error', error: '已扫码但没换到有效 Cookie（缺 __puus），请重试一次' });
  }
  // 验证 Cookie 能调业务接口
  const cfg = await fetch('https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc', {
    headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://pan.quark.cn/' },
  });
  const cfgData = await cfg.json().catch(() => null);
  if (!cfgData || cfgData.status !== 200) {
    return json({ ok: false, state: 'error', error: 'Cookie 验证未通过（config 接口未返回 200）' });
  }
  await kv.put('quark_cookie', cookie);
  await kv.delete('qr_pending');
  return json({ ok: true, state: 'done' });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  try {
    if (url.searchParams.get('action') === 'poll') return poll(env);
    if (url.searchParams.get('action') === 'status') {
      const kv = await enabled(env);
      if (!kv) return json({ ok: true, enabled: false });
      return json({ ok: true, enabled: true, bound: !!(await kv.get('quark_cookie')) });
    }
    return start(request, env);
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) });
  }
}
