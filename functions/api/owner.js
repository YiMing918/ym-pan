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
  aliyun: ['aliAuth', 'aliRefresh'],
  quark: ['quarkCookie'],
  uc: ['ucCookie'],
  cmcc: ['cmccAuth'],
  ctyun: ['ctCookie'],
  feijipan: ['fjToken'],
  pan123: ['p123Token'],
  xunlei: ['xlAuth', 'xlRefresh'],
  guangya: ['gyToken', 'gyRefresh'],
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

// 常量时间比对：先对两侧各做 SHA-256 摘要（摘要恒为 32 字节，消除长度差与
// 逐字符短路带来的时序侧信道），再逐字节 XOR 累加比较，全程不提前退出。
// 仅用 Web Crypto（crypto.subtle），兼容 Cloudflare Workers，无 Node 专有 API。
async function timingEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let d = 0;
  for (let i = 0; i < va.length; i++) d |= va[i] ^ vb[i];
  return d === 0;
}

// 口令哈希：新格式 v2$<salt>$<sha256(salt+':'+pass)>（加盐）；旧格式为纯 SHA-256（64 位十六进制）。
// passOkMasked 返回命中后是否需要把存储升级到新格式（调用方负责在成功路径落盘，避免改口令流程被干扰）。
async function passOkInfo(kv, pass) {
  if (!pass) return { ok: false, upgrade: null };
  const h = await kv.get('owner_hash');
  if (!h) return { ok: false, upgrade: null };
  if (h.startsWith('v2$')) {
    const salt = h.slice(3, h.indexOf('$', 3));
    const ok = await timingEq(await sha256hex(salt + ':' + pass), h.slice(3 + salt.length + 1));
    return { ok, upgrade: null };
  }
  const ok = await timingEq(await sha256hex(pass), h);
  return { ok, upgrade: ok ? await hashPassV2(pass) : null };
}
async function passOk(kv, pass) { return (await passOkInfo(kv, pass)).ok; }
async function hashPassV2(pass) {
  const salt = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
  return 'v2$' + salt + '$' + (await sha256hex(salt + ':' + pass));
}
// 验口令失败限流：同来源 IP 在 KV 里计数，15 分钟内失败 >=10 次锁定 15 分钟（成功一次清零）
async function rlCheck(kv, request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const raw = await kv.get('rl:owner:' + ip);
  if (!raw) return { locked: false, ip };
  try { const r = JSON.parse(raw); if (r.lockUntil && r.lockUntil > Date.now()) return { locked: true, ip }; } catch {}
  return { locked: false, ip };
}
async function rlFail(kv, request, ip) {
  const key = 'rl:owner:' + ip;
  let r = { fails: 0, winStart: 0, lockUntil: 0 };
  try { r = JSON.parse((await kv.get(key)) || '') || r; } catch {}
  const now = Date.now();
  if (!r.winStart || now - r.winStart > 15 * 60 * 1000) { r.fails = 0; r.winStart = now; r.lockUntil = 0; }
  r.fails++;
  if (r.fails >= 10) r.lockUntil = now + 15 * 60 * 1000;
  await kv.put(key, JSON.stringify(r), { expirationTtl: 2 * 24 * 3600 });
}
async function rlClear(kv, ip) { await kv.delete('rl:owner:' + ip); }

function genRecovery() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const chars = [...buf].map(b => abc[b % abc.length]).join('');
  return chars.replace(/(.{4})(?=.)/g, '$1-');
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
    if (!env.PATROL_KEY || !(await timingEq(request.headers.get('x-patrol-key') || '', env.PATROL_KEY))) return fail('无权开启设置窗口', 403);
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
      hasRecovery: !!(await kv.get('owner_recovery_hash')),
      setupOpen: await setupOpen(kv),
      vaulted,
      quarkBound: !!(await kv.get('quark_cookie')),
    });
  }

  if (action === 'setpass') {
    // 三条授权路径，互为兜底、都不依赖任何人常驻：① 30 分钟设置窗口（巡检口令开启）
    // ② 从未设过口令（首次认领，含在 Cloudflare 后台删键后的终极重置）③ 有效的恢复码
    const had = !!(await kv.get('owner_hash'));
    const recHash = await kv.get('owner_recovery_hash');
    const recOk = !!(body.recovery && recHash && (await timingEq(await sha256hex(String(body.recovery).replace(/[\s-]/g, '').toUpperCase()), recHash)));
    if (!(await setupOpen(kv)) && had && !recOk) {
      return fail('设置窗口未开启，且恢复码不正确。可用恢复码重置，或让助理开启 30 分钟设置窗口。');
    }
    const p = String(body.pass || '');
    if (p.length < 6) return fail('口令至少 6 位');
    await kv.put('owner_hash', await hashPassV2(p));
    await kv.delete('owner_setup_until');
    if (had) { // 重置口令：清空保险箱凭证，防旧口令泄露连带
      for (const d of Object.keys(VAULT_KEYS)) await kv.delete('vault_' + d);
    }
    // 每次设/重置口令都签发一串新恢复码，只在本次响应里明文出现一次
    const recovery = genRecovery();
    await kv.put('owner_recovery_hash', await sha256hex(recovery.replace(/-/g, '')));
    return json({ ok: true, reset: had, recovery });
  }

  // 以下动作都要验口令（带失败限流；验过后把旧哈希无感升级为加盐格式）
  const pass = String(body.pass || request.headers.get('x-owner-pass') || '');
  const rl = await rlCheck(kv, request);
  if (rl.locked) return fail('口令尝试过于频繁，请 15 分钟后再试', 429);
  const chk = await passOkInfo(kv, pass);
  if (!chk.ok) { await rlFail(kv, request, rl.ip); return fail('口令不正确', 403); }
  await rlClear(kv, rl.ip);
  if (chk.upgrade) await kv.put('owner_hash', chk.upgrade);

  if (action === 'verify') return json({ ok: true });

  if (action === 'regen-recovery') {
    const recovery = genRecovery();
    await kv.put('owner_recovery_hash', await sha256hex(recovery.replace(/-/g, '')));
    return json({ ok: true, recovery });
  }

  if (action === 'changepass') {
    const np = String(body.newPass || '');
    if (np.length < 6) return fail('新口令至少 6 位');
    await kv.put('owner_hash', await hashPassV2(np));
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
