// ym-pan 对抗复读 C 部分定向测试（node 桩 mock KV/fetch，不连真网）：node tests/security-c.mjs
// 覆盖 C-9 SSRF / C-10 蓝奏主机 / C-15 限流不烧写 / C-16 qr 分槽 / C-36 parse 限流+分页硬顶 / C-40 参数编码 / C-41 owner status 最小化
import { onRequest as parseReq } from '../functions/api/parse.js';
import { onRequest as qrReq } from '../functions/api/qr.js';
import { onRequest as ownerReq, sha256hex } from '../functions/api/owner.js';
import { onRequest as qrloginReq } from '../functions/api/qrlogin.js';
import * as video from '../functions/api/video.js';

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, String(extra).slice(0, 220)); } };
const J = (obj, headers = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const T = (txt, headers = {}) => new Response(txt, { status: 200, headers });

class MockKV {
  constructor() { this.map = new Map(); this.puts = 0; this.deletes = 0; }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.puts++; this.map.set(k, String(v)); }
  async delete(k) { this.deletes++; this.map.delete(k); }
}
const req = (url, { method = 'GET', ip = '1.2.3.4', body, headers = {} } = {}) => new Request(url, {
  method, headers: { 'cf-connecting-ip': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

/* ---------- C-9 video generic SSRF ---------- */
{
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return T('<html><meta property="og:video" content="https://cdn.example/v.mp4"></html>'); };
  for (const bad of ['https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://[::1]/x', 'ftp://example.com/x', 'https://foo.local/x', 'https://172.16.0.9/x']) {
    calls.length = 0;
    const r = await video.handleVideo({ text: bad });
    const d = await r.json();
    chk('C9 拦截 ' + bad, !d.ok && calls.length === 0, JSON.stringify(d).slice(0, 120) + ' calls=' + calls.length);
  }
  // 重定向跳私网：只许请求第一跳
  calls.length = 0;
  globalThis.fetch = async (url) => { calls.push(String(url)); if (String(url).includes('127.0.0.1')) return T('<meta property="og:video" content="https://cdn.example/v.mp4">'); return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }); };
  let r = await video.handleVideo({ text: 'https://example.com/jump' }); let d = await r.json();
  chk('C9 重定向逐跳复检', !d.ok && calls.length === 1 && !calls[0].includes('127.0.0.1'), JSON.stringify(d).slice(0, 120) + ' calls=' + JSON.stringify(calls));
  // 大小上限 2MB
  globalThis.fetch = async () => {
    const stream = new ReadableStream({ start(c) { const chunk = new Uint8Array(1024 * 1024).fill(97); c.enqueue(chunk); c.enqueue(chunk); c.enqueue(chunk); c.close(); } });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  r = await video.handleVideo({ text: 'https://example.com/big' }); d = await r.json();
  chk('C9 超 2MB 放弃', !d.ok && /2MB|过大|too large/i.test(d.error || ''), d.error);
  // 超时机制（helper 注入短超时验 Abort 生效）
  if (typeof video.safeFetchText === 'function') {
    let aborted = false;
    globalThis.fetch = async (url, opts) => new Promise((_, rej) => { opts.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }); });
    let threw = false;
    try { await video.safeFetchText('https://example.com/slow', { timeoutMs: 120 }); } catch { threw = true; }
    chk('C9 总超时 Abort', threw && aborted);
  } else chk('C9 总超时 Abort', false, 'safeFetchText 未导出');
  // 正常公网页仍可解析
  globalThis.fetch = async () => T('<html><meta property="og:title" content="t"><meta property="og:video" content="https://cdn.example/v.mp4"></html>');
  r = await video.handleVideo({ text: 'https://example.com/watch/1' }); d = await r.json();
  chk('C9 公网 generic 正常', d.ok && d.url === 'https://cdn.example/v.mp4', JSON.stringify(d).slice(0, 160));
}

/* ---------- C-10 蓝奏主机校验 + 复用 parse mock ---------- */
{
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (/lanzou\w?\.com\/iAbCdEf$/.test(u)) return T('<html><iframe src="/fn?file=FILEID9"></iframe></html>');
    if (u.includes('/fn?file=')) return T("<script>var ajax={data:{'sign':'SGN123'}};</script>");
    if (u.includes('ajaxm.php')) return J({ zt: 1, dom: 'https://dl.lanzou.example', url: 'tok999', inf: 'f.zip' });
    return new Response('{}', { status: 200 });
  };
  const callParse = async (body, env = {}) => { const resp = await parseReq({ request: req('http://local/api/parse', { method: 'POST', body }), env }); return resp.json(); };
  calls.length = 0;
  let r = await callParse({ drive: 'lanzou', action: 'list', url: 'https://evil.example.com/iAbCdEf', pwd: '', cred: {} });
  chk('C10 伪造主机不用 first', r.ok && !calls.some(u => u.includes('evil.example.com')) && calls.some(u => u.includes('lanzoui.com')), JSON.stringify(r).slice(0, 160) + ' calls=' + calls.slice(0, 3).join(','));
  calls.length = 0;
  r = await callParse({ drive: 'lanzou', action: 'list', url: 'https://www.lanzouh.com/iAbCdEf', pwd: '', cred: {} });
  chk('C10 合法蓝奏主机保留 first', r.ok && calls[0].includes('lanzouh.com'), JSON.stringify(r).slice(0, 160) + ' calls=' + calls.slice(0, 2).join(','));
}

/* ---------- C-15 qrlogin 限流被拦不烧写 ---------- */
{
  const kv = new MockKV();
  kv.map.set('rl:pwdlogin:1.2.3.4', JSON.stringify({ n: 30, winStart: Date.now() }));
  globalThis.fetch = async () => { throw new Error('should not fetch'); };
  const resp = await qrloginReq({ request: req('http://local/api/qrlogin', { method: 'POST', body: { drive: 'feijipan', action: 'login', username: 'u', password: 'p' } }), env: { PAN_KV: kv } });
  const d = await resp.json();
  chk('C15 qrlogin 超限拒且零写', !d.ok && /频繁/.test(d.error || '') && kv.puts === 0, JSON.stringify(d) + ' puts=' + kv.puts);
  // owner 已锁定：verify 直接 429 且零写（回归）
  const kv2 = new MockKV();
  kv2.map.set('owner_hash', await sha256hex('secret1'));
  kv2.map.set('rl:owner:1.2.3.4', JSON.stringify({ fails: 10, winStart: Date.now(), lockUntil: Date.now() + 900000 }));
  const resp2 = await ownerReq({ request: req('http://local/api/owner', { method: 'POST', body: { action: 'verify', pass: 'secret1' } }), env: { PAN_KV: kv2 } });
  const d2 = await resp2.json();
  chk('C15 owner 锁定零写', resp2.status === 429 && kv2.puts === 0, JSON.stringify(d2) + ' puts=' + kv2.puts);
}

/* ---------- C-16 qr.js 分槽 / 限流 / JSON 兜底 ---------- */
{
  const kv = new MockKV();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('getTokenForQrcodeLogin')) return J({ data: { members: { token: 'TOK123' } } });
    if (u.includes('getServiceTicketByQrcodeToken')) return J({ status: 50004001 });
    return J({});
  };
  const env = { PAN_KV: kv, PATROL_KEY: 'patrol-secret-123' };
  let resp = await qrReq({ request: req('http://local/api/qr'), env });
  let d = await resp.json();
  chk('C16 start 回 session id 并分槽存', d.ok && !!d.id && kv.map.has('qr_pending:' + d.id) && !kv.map.has('qr_pending'), JSON.stringify(d));
  const id1 = d.id;
  resp = await qrReq({ request: req('http://local/api/qr'), env }); d = await resp.json();
  chk('C16 两次 start 分槽互不覆盖', d.ok && d.id !== id1 && kv.map.has('qr_pending:' + id1) && kv.map.has('qr_pending:' + d.id), JSON.stringify(d));
  // poll 带 id
  resp = await qrReq({ request: req('http://local/api/qr?action=poll&id=' + encodeURIComponent(id1)), env }); d = await resp.json();
  chk('C16 poll 带 id 等待中', d.ok && d.state === 'waiting', JSON.stringify(d));
  // poll 没带 id：明确拒绝，不读全局槽
  resp = await qrReq({ request: req('http://local/api/qr?action=poll'), env }); d = await resp.json();
  chk('C16 poll 无 id 拒绝', !d.ok || d.state === 'error', JSON.stringify(d));
  // 损坏 JSON 不崩
  kv.map.set('qr_pending:bad', 'not-json{{{');
  resp = await qrReq({ request: req('http://local/api/qr?action=poll&id=bad'), env }); d = await resp.json();
  chk('C16 poll 损坏 JSON 兜底 expired', d.ok && d.state === 'expired', JSON.stringify(d));
  // start 限流：已达上限零写
  const kv3 = new MockKV();
  kv3.map.set('rl:qr:1.2.3.4', JSON.stringify({ n: 30, winStart: Date.now() }));
  resp = await qrReq({ request: req('http://local/api/qr'), env: { PAN_KV: kv3, PATROL_KEY: 'patrol-secret-123' } });
  d = await resp.json();
  chk('C16 start 超限拒且零写', !d.ok && kv3.puts === 0, JSON.stringify(d) + ' puts=' + kv3.puts);
  // 已绑定后错误巡检口令仍拒（timingEq 回归）
  const kv4 = new MockKV(); kv4.map.set('quark_cookie', 'x=1');
  resp = await qrReq({ request: req('http://local/api/qr', { headers: { 'x-patrol-key': 'wrong' } }), env: { PAN_KV: kv4, PATROL_KEY: 'patrol-secret-123' } });
  d = await resp.json();
  chk('C16 重绑口令校验', !d.ok && /已绑定/.test(d.error || ''), JSON.stringify(d));
}

/* ---------- C-40 qrlogin 编码 + 天翼 Referer ---------- */
{
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); seen.push({ u, headers: opts.headers || {} });
    if (u.includes('passport.baidu.com/channel/unicast')) return T(JSON.stringify({ errno: 0, channel_v: JSON.stringify({ status: 0, v: 'V&1' }) }));
    if (u.includes('qrbdusslogin')) return T('{"bduss":"B1"}', { 'set-cookie': 'BDUSS=B1; path=/' });
    if (u.includes('api.open.uc.cn/cas/ajax/getTokenForQrcodeLogin')) return J({ status: 2000000, data: { members: { token: 't&k=1' } } });
    if (u.includes('qrcodeLoginState.do')) return J({ status: 0, redirectUrl: 'https://cloud.189.cn/cb' });
    if (u.includes('getSessionForPC')) return J({ res_code: 0 });
    return J({});
  };
  // 百度 poll sign/gid 编码
  seen.length = 0;
  let resp = await qrloginReq({ request: req('http://local/api/qrlogin', { method: 'POST', body: { drive: 'baidu', action: 'poll', params: { sign: 'a&b=c', gid: 'g&x' } } }), env: {} });
  let d = await resp.json();
  const unicast = seen.find(s => s.u.includes('unicast')) || { u: '' };
  chk('C40 百度 sign/gid 编码', d.ok && unicast.u.includes('channel_id=a%26b%3Dc') && unicast.u.includes('gid=g%26x'), unicast.u + ' ' + JSON.stringify(d).slice(0, 120));
  const eu = seen.find(s => s.u.includes('qrbdusslogin')) || { u: '' };
  chk('C40 百度 v/bduss 编码', eu.u.includes('v=V%261') && eu.u.includes('bduss=V%261'), eu.u);
  // UC start token 编码进二维码 URL
  resp = await qrloginReq({ request: req('http://local/api/qrlogin?drive=uc&action=start'), env: {} });
  d = await resp.json();
  chk('C40 UC token 编码', d.ok && (d.qr || '').includes('token=t%26k%3D1'), d.qr);
  // 天翼 poll Referer 不用客户端传的邪恶 URL
  seen.length = 0;
  resp = await qrloginReq({ request: req('http://local/api/qrlogin', { method: 'POST', body: { drive: 'ctyun', action: 'poll', params: { uuid: 'u1', encryuuid: 'e1', reqId: 'r1', paramId: '', loginPageUrl: 'https://evil.example.com/phish', openE: 'a=b' } } }), env: {} });
  d = await resp.json();
  const pollCall = seen.find(s => s.u.includes('qrcodeLoginState')) || { headers: {} };
  chk('C40 天翼 Referer 服务端常量', d.ok && pollCall.headers.Referer === 'https://open.e.189.cn/api/logbox/separate/web/index.html?appId=8025431004', JSON.stringify(pollCall.headers) + ' ' + JSON.stringify(d).slice(0, 120));
}

/* ---------- C-41 owner status 最小化 / verify 后回清单 ---------- */
{
  const kv = new MockKV();
  kv.map.set('owner_hash', await sha256hex('secret1'));
  kv.map.set('owner_recovery_hash', 'x');
  kv.map.set('vault_quark', JSON.stringify({ quarkCookie: 'c' }));
  kv.map.set('quark_cookie', 'qc=1');
  let resp = await ownerReq({ request: req('http://local/api/owner?action=status'), env: { PAN_KV: kv } });
  let d = await resp.json();
  chk('C41 status 只回最小集', d.ok && d.hasPass === true && typeof d.setupOpen === 'boolean' && !('vaulted' in d) && !('quarkBound' in d) && !('hasRecovery' in d), JSON.stringify(d));
  resp = await ownerReq({ request: req('http://local/api/owner', { method: 'POST', body: { action: 'verify', pass: 'secret1' } }), env: { PAN_KV: kv } });
  d = await resp.json();
  chk('C41 verify 后回清单', d.ok && Array.isArray(d.vaulted) && d.vaulted.includes('quark') && d.quarkBound === true, JSON.stringify(d));
}

/* ---------- C-36 parse 限流 + 分页硬顶 ---------- */
{
  // 限流：已达上限直接 429、零写、不打上游
  const kv = new MockKV();
  kv.map.set('rl:parse:1.2.3.4', JSON.stringify({ n: 30, winStart: Date.now() }));
  let fetchN = 0;
  globalThis.fetch = async () => { fetchN++; return J({}); };
  let resp = await parseReq({ request: req('http://local/api/parse', { method: 'POST', body: { drive: 'baidu', action: 'list', url: 'https://pan.baidu.com/s/1AbCdEfGh', cred: {} } }), env: { PAN_KV: kv } });
  let d = await resp.json();
  chk('C36 parse 超限 429 零写不上游', resp.status === 429 && kv.puts === 0 && fetchN === 0, 'status=' + resp.status + ' ' + JSON.stringify(d) + ' puts=' + kv.puts + ' fetch=' + fetchN);

  // 123 分页硬顶 20
  let pages123 = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/b/api/share/get')) { pages123++; const pg = new URL(u).searchParams.get('Page'); return J({ code: 0, data: { InfoList: [{ FileId: pg, FileName: 'f' + pg, Size: 1, Type: 0, Etag: 'e', S3KeyFlag: 's' }], Next: '0' } }); }
    return J({});
  };
  resp = await parseReq({ request: req('http://local/api/parse', { method: 'POST', body: { drive: 'pan123', action: 'list', url: 'https://www.123pan.com/s/AbC-123', cred: {} } }), env: {} });
  d = await resp.json();
  chk('C36 123 分页硬顶 20 + truncated', d.ok && pages123 === 20 && d.files.length === 20 && d.truncated === true, 'pages=' + pages123 + ' ' + JSON.stringify(d).slice(0, 160));

  // 天翼分页硬顶 20
  let pagesCt = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('getShareInfoByCodeV2')) return J({ res_code: 0, shareId: '11', shareMode: '0', fileId: '22', fileName: 'root', isFolder: true });
    if (u.includes('listShareDir')) { pagesCt++; const fl = Array.from({ length: 100 }, (_, i) => ({ id: String(pagesCt * 1000 + i), name: 'f' + i, size: 1 })); return J({ res_code: 0, fileListAO: { fileList: fl, folderList: [] } }); }
    return J({});
  };
  resp = await parseReq({ request: req('http://local/api/parse', { method: 'POST', body: { drive: 'ctyun', action: 'list', url: 'https://cloud.189.cn/t/abcdef', cred: {} } }), env: {} });
  d = await resp.json();
  chk('C36 天翼分页硬顶 20 + truncated', d.ok && pagesCt === 20 && d.files.length === 2000 && d.truncated === true, 'pages=' + pagesCt + ' files=' + (d.files || []).length + ' trunc=' + d.truncated + ' ' + (d.error || ''));

  // 移动分页硬顶 20（每页步长 200）
  let pagesCm = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('getOutLinkGeneral')) return T(JSON.stringify({ resultCode: 0, data: { getOutLinkGeneralResp: { outLinkGeneral: [{ lkName: 't', passwd: 'pw' }] } } }));
    if (u.includes('getOutLinkInfoV6')) { pagesCm++; const co = Array.from({ length: 200 }, (_, i) => ({ coID: String(pagesCm * 1000 + i), coName: 'f' + i, coSize: 1, isdir: false })); return T(JSON.stringify({ resultCode: 0, data: { caLst: [], coLst: co } })); }
    return T('{}');
  };
  resp = await parseReq({ request: req('http://local/api/parse', { method: 'POST', body: { drive: 'cmcc', action: 'list', url: 'https://yun.139.com/shareweb/#/w/i/abcdef', cred: {} } }), env: {} });
  d = await resp.json();
  chk('C36 移动分页硬顶 20 + truncated', d.ok && pagesCm === 20 && d.files.length === 4000 && d.truncated === true, 'pages=' + pagesCm + ' files=' + (d.files || []).length + ' trunc=' + d.truncated + ' ' + (d.error || ''));
}

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
