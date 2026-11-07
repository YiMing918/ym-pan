// 站长保险箱：站长口令 + 凭证保险箱（存站长自己的 Cloudflare KV: PAN_KV）
// 用途：站长把各家凭证存进保险箱一次，之后在任何设备上只输口令即可免填解析（用的仍是站长自己的账号）。
// 安全边界：
//  - 口令只存 SHA-256 哈希（owner_hash），原文不落盘。
//  - 设置/重置口令只能在「设置窗口」内：窗口由巡检口令（PATROL_KEY，仅助理侧持有）开启 30 分钟，防止陌生人抢设。
//  - 重置口令会清空保险箱内全部凭证（防旧口令泄露连带）。
//  - 保险箱读写都要验口令；解析接口（parse.js）在请求带 x-owner-pass 且验过时才用保险箱兜底。
//  - 夸克特殊：未单独存保险箱时，兜底用扫码绑定存下的巡检 Cookie（KV quark_cookie，本就是站长本人的）。

const VAULT_KEYS = {
  baidu: ['bduss', 'stoken'],
  aliyun: ['aliAuth'],
  quark: ['quarkCookie'],
  uc: ['ucCookie'],
  cmcc: ['cmccAuth'],
  ctyun: ['ctCookie'],
  feijipan: ['fjToken'],
  pan123: ['p123Token'],
  xunlei: ['xlAuth'],
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const fail = (msg, status = 200) => json({ ok: false, error: msg }, status);

export async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function setupOpen(kv) {
  const until = Number((await kv.get('owner_setup_until')) || 0);
  return until > Date.now();
}

async function passOk(kv, pass) {
  if (!pass) return false;
  const h = await kv.get('owner_hash');
  if (!h) return false;
  return (await sha256hex(pass)) === h;
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.PAN_KV;
  if (!kv) return fail('KV 未绑定（PAN_KV）', 500);
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { return fail('请求体不是 JSON'); }
  }
  const action = body.action || new URL(request.url).searchParams.get('action') || 'status';

  if (action === 'open-setup') {
    if (!env.PATROL_KEY || request.headers.get('x-patrol-key') !== env.PATROL_KEY) return fail('无权开启设置窗口', 403);
    const until = Date.now() + 30 * 60 * 1000;
    await kv.put('owner_setup_until', String(until));
    return json({ ok: true, setupUntil: new Date(until).toISOString() });
  }

  if (action === 'status') {
    const vaulted = [];
    for (const d of Object.keys(VAULT_KEYS)) {
      if (await kv.get('vault_' + d)) vaulted.push(d);
    }
    return json({
      ok: true,
      hasPass: !!(await kv.get('owner_hash')),
      setupOpen: await setupOpen(kv),
      vaulted,
      quarkBound: !!(await kv.get('quark_cookie')),
    });
  }

  if (action === 'setpass') {
    if (!(await setupOpen(kv))) return fail('设置窗口未开启。请让助理先开启 30 分钟设置窗口，再回来设置口令。');
    const p = String(body.pass || '');
    if (p.length < 6) return fail('口令至少 6 位');
    const had = !!(await kv.get('owner_hash'));
    await kv.put('owner_hash', await sha256hex(p));
    await kv.delete('owner_setup_until');
    if (had) { // 重置口令：清空保险箱凭证，防旧口令泄露连带
      for (const d of Object.keys(VAULT_KEYS)) await kv.delete('vault_' + d);
    }
    return json({ ok: true, reset: had });
  }

  // 以下动作都要验口令
  const pass = String(body.pass || request.headers.get('x-owner-pass') || '');
  if (!(await passOk(kv, pass))) return fail('口令不正确', 403);

  if (action === 'verify') return json({ ok: true });

  if (action === 'changepass') {
    const np = String(body.newPass || '');
    if (np.length < 6) return fail('新口令至少 6 位');
    await kv.put('owner_hash', await sha256hex(np));
    return json({ ok: true });
  }

  if (action === 'vault') {
    const drive = String(body.drive || '');
    const keys = VAULT_KEYS[drive];
    if (!keys) return fail('这家不支持存保险箱');
    const cred = {};
    for (const k of keys) {
      const v = body.cred && body.cred[k];
      if (typeof v === 'string' && v.trim()) cred[k] = v.trim();
    }
    if (!Object.keys(cred).length) return fail('没有可存的凭证（先填好再存）');
    await kv.put('vault_' + drive, JSON.stringify(cred));
    return json({ ok: true });
  }

  if (action === 'unvault') {
    const drive = String(body.drive || '');
    if (!VAULT_KEYS[drive]) return fail('这家不支持存保险箱');
    await kv.delete('vault_' + drive);
    return json({ ok: true });
  }

  return fail('未知动作');
}
