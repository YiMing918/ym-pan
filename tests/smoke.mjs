// ym-pan 解析层冒烟测试（打桩 fetch，不连真网盘）：node tests/smoke.mjs
// 验：百度全流程、阿里、夸克（含 __puus 回写）、123 双路线回退、蓝奏、光鸭筹备中、缺凭证报错。
import { onRequest } from '../functions/api/parse.js';

const J = (obj, headers = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const T = (txt, headers = {}) => new Response(txt, { status: 200, headers });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (/pan\.baidu\.com\/s\/1/.test(u)) return T('<html>{"share_uk":12345,"shareid":6789,"sign":"SGN","timestamp":1700000000}</html>', { 'set-cookie': 'PANPSC=xyz; path=/' });
  if (u.includes('share/verify')) return J({ errno: 0 }, { 'set-cookie': 'BDCLND=abc%3D; path=/' });
  if (u.includes('pan.baidu.com/share/list')) return J({ errno: 0, list: [
    { fs_id: 111, server_filename: 'a.zip', size: 2048, isdir: 0, path: '/a.zip' },
    { fs_id: 112, server_filename: 'dir1', size: 0, isdir: 1, path: '/dir1' },
  ] });
  if (u.includes('api/sharedownload')) return J({ errno: 0, list: [{ dlink: 'https://d.pcs.example/a.zip?x=1' }] });
  if (u.includes('get_share_token')) return J({ share_token: 'tok123' });
  if (u.includes('list_by_share')) return J({ items: [{ file_id: 'f1', name: 'b.mp4', size: 4096, type: 'file' }] });
  if (u.includes('get_share_link_download_url')) return J({ download_url: 'https://dl.aliyun.example/b.mp4' });
  if (u.includes('sharepage/token')) return J({ status: 200, data: { stoken: 'stk1' } }, { 'set-cookie': '__puus=NEWPUUS; path=/' });
  if (u.includes('sharepage/detail')) return J({ status: 200, data: { list: [{ fid: 'q1', file_name: 'c.rar', size: 8192, dir: false, share_fid_token: 'tk1' }] } });
  if (u.includes('clouddrive/file/download')) return J({ status: 200, data: [{ download_url: 'https://dl.quark.example/c.rar' }] });
  if (/lanzou\w?\.com\/iAbCdEf$/.test(u)) return T('<html><iframe src="/fn?file=FILEID9" frameborder="0"></iframe></html>');
  if (u.includes('/fn?file=')) return T("<script>var ajax={data:{'sign':'SGN123'}};</script>");
  if (u.includes('ajaxm.php')) return J({ zt: 1, dom: 'https://dl.lanzou.example', url: 'tok999', inf: 'f.zip' });
  if (u.includes('www.123pan.com/api/share/list')) return J({ code: 5112, message: 'need login' });
  if (u.includes('www.123pan.cn/b/api/share/list')) return J({ code: 0, data: { InfoList: [{ FileId: 42, FileName: 'd.iso', Size: 1024, Type: 0, Etag: 'e1', S3KeyFlag: 's1' }] } });
  if (u.includes('/api/file/download_info')) return J({ code: 0, data: { DownloadURL: 'https://dl.123.example/d.iso' } });
  return new Response('{}', { status: 200 });
};

async function call(body, method = 'POST') {
  const request = method === 'POST'
    ? new Request('http://local/api/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    : new Request('http://local/api/parse');
  const resp = await onRequest({ request, env: {} });
  return resp.json();
}

let pass = 0, failN = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log('PASS', name); } else { failN++; console.log('FAIL', name, extra); } };

const info = await call(null, 'GET');
chk('GET drives=11', info.ok && Object.keys(info.drives).length === 11);

let r = await call({ drive: 'baidu', action: 'list', url: 'https://pan.baidu.com/s/1AbCdEfGh', pwd: '1234', cred: {} });
chk('baidu 缺 BDUSS 报错', !r.ok && /BDUSS/.test(r.error), r.error);
r = await call({ drive: 'baidu', action: 'list', url: 'https://pan.baidu.com/s/1AbCdEfGh', pwd: '1234', cred: { bduss: 'TESTBDUSS' } });
chk('baidu list 2 项', r.ok && r.files.length === 2 && r.files[1].dir === true);
chk('baidu randsk 解码', r.ok && r.ctx.randsk === 'abc=');
let d = await call({ drive: 'baidu', action: 'download', cred: { bduss: 'TESTBDUSS' }, ctx: r.ctx, file: r.files[0] });
chk('baidu dlink', d.ok && d.url.includes('d.pcs.example') && /BDUSS=TESTBDUSS/.test(d.headers.Cookie));

r = await call({ drive: 'aliyun', action: 'list', url: 'https://www.aliyundrive.com/s/AbCd123', pwd: '', cred: {} });
chk('aliyun list', r.ok && r.files[0].name === 'b.mp4');
d = await call({ drive: 'aliyun', action: 'download', cred: {}, ctx: r.ctx, file: r.files[0] });
chk('aliyun link', d.ok && d.url.includes('dl.aliyun.example'));

r = await call({ drive: 'quark', action: 'list', url: 'https://pan.quark.cn/s/abc123def', pwd: '', cred: { quarkCookie: '__puus=OLD; k1=v1' } });
chk('quark list', r.ok && r.files[0].name === 'c.rar');
chk('quark credUpdate 带新 __puus', r.ok && /__puus=NEWPUUS/.test((r.credUpdate || {}).cookie || ''));
d = await call({ drive: 'quark', action: 'download', cred: { quarkCookie: '__puus=OLD' }, ctx: r.ctx, file: r.files[0] });
chk('quark link', d.ok && d.url.includes('dl.quark.example'));

r = await call({ drive: 'uc', action: 'list', url: 'https://drive.uc.cn/s/abc123', pwd: '', cred: {} });
chk('uc 缺 Cookie 报错', !r.ok && /Cookie/.test(r.error));

r = await call({ drive: 'lanzou', action: 'list', url: 'https://www.lanzoui.com/iAbCdEf', pwd: '', cred: {} });
chk('lanzou 直链', r.ok && r.kind === 'link' && r.url === 'https://dl.lanzou.example/file/tok999');

r = await call({ drive: 'pan123', action: 'list', url: 'https://www.123pan.com/s/AbC-123', pwd: '', cred: {} });
chk('123 回退备用路线', r.ok && r.route.startsWith('备用接口') && r.files[0].name === 'd.iso', JSON.stringify(r).slice(0, 200));
d = await call({ drive: 'pan123', action: 'download', cred: {}, ctx: r.ctx, file: r.files[0] });
chk('123 link', d.ok && d.url.includes('dl.123.example'));

r = await call({ drive: 'guangya', action: 'list', url: 'https://www.guangyapan.com/s/abc_def', cred: {} });
chk('guangya 筹备中', !r.ok && /筹备中/.test(r.error));

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
