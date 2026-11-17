// ym-pan 解析层冒烟测试（打桩 fetch，不连真网盘）：node tests/smoke.mjs
// 验：百度全流程、阿里、夸克（含 __puus 回写）、123 双路线回退、蓝奏、光鸭分享全流程、缺凭证报错。
import { onRequest } from '../functions/api/parse.js';

const J = (obj, headers = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const T = (txt, headers = {}) => new Response(txt, { status: 200, headers });

globalThis.fetch = async (url, opts = {}) => {
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
  // 123 现行口径（v1.9.2 对齐）：主路线 yun.123pan.cn/b/api/share/get 故意失败，
  // 验代码回退备域名 www.123865.com 同路径；取链走 www.123865.com/b/api/share/download/info。
  // （旧打桩拦的 www.123pan.com/api/share/list 等端点已被现行代码弃用，注在 P-03/S3。）
  if (u.includes('yun.123pan.cn/b/api/share/get')) return J({ code: 5112, message: 'need login' });
  if (u.includes('www.123865.com/b/api/share/get')) return J({ code: 0, data: { InfoList: [{ FileId: 42, FileName: 'd.iso', Size: 1024, Type: 0, Etag: 'e1', S3KeyFlag: 's1' }], Next: '-1' } });
  // 123 跟跳签名场景（2026-11-17）：777001 跳转保留签名、节点要 Range 才给 206；777002 跳转丢签名
  if (u.includes('b/api/share/download/info') && String(opts.body || '').includes('777001')) return J({ code: 0, data: { DownloadURL: 'https://web123.example/download-v2/?params=' + Buffer.from('https://cdn123.example/inner?v=5&t=111&s=abc').toString('base64url') } });
  if (u.includes('b/api/share/download/info') && String(opts.body || '').includes('777002')) return J({ code: 0, data: { DownloadURL: 'https://web123.example/download-v2/?params=' + Buffer.from('https://cdn123.example/inner2?v=5&t=222&s=def').toString('base64url') } });
  if (u.includes('cdn123.example/inner2')) return new Response(null, { status: 302, headers: { location: 'https://node123.example/g.zip?xmfcid=z' } });
  if (u.includes('cdn123.example/inner')) return new Response(null, { status: 302, headers: { location: 'https://node123.example/f.zip?v=5&t=111&s=abc&xmfcid=y' } });
  if (u.includes('node123.example/')) return (opts.headers && opts.headers.Range) ? new Response('x', { status: 206, headers: { 'content-type': 'application/octet-stream' } }) : J({ code: 1010, message: 'not found t or s or v' });
  if (u.includes('www.123865.com/b/api/share/download/info')) return J({ code: 0, data: { DownloadURL: 'https://dl.123.example/d.iso' } });
  // 蓝奏 2026 新模板：主页无 iframe，sign 是 JS 变量（先赋空再赋真值），fid 写在 ajaxfile.php?file= 里
  if (u.includes('lanzoux.com/iNewTp9')) return T(`<html><script>var isngis = '';var isngis = 'NEWSIGN123';$.ajax({url:'https://apifile.woozooo.com/ajaxfile.php?file=999001',data:{'action':'downprocess','sign':isngis,'kd':1,'p':'8888'}});</script></html>`);
  if (u.includes('apifile.woozooo.com/ajaxfile.php?file=999001')) return J({ zt: 1, dom: 'https://dl.lanzou.example', url: 'tok888', inf: 'g.zip' });
  if (u.includes('get_share_access_token')) return J({ data: { accessToken: 'GYTOK1' } });
  if (u.includes('get_share_page_files_list')) return J({ data: { list: [{ fileId: 'g1', fileName: 'e.mkv', fileSize: 2048, resType: 1 }] } });
  if (u.includes('get_share_download_url')) return J({ data: { signedURL: 'https://dl.guangya.example/e.mkv' } });
  if (u.includes('getFileDownloadUrl')) return J({ fileDownloadUrl: 'https://dl.189.example/f.zip' });
  return new Response('{}', { status: 200 });
};

async function call(body, method = 'POST', env = {}) {
  const request = method === 'POST'
    ? new Request('http://local/api/parse', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    : new Request('http://local/api/parse');
  const resp = await onRequest({ request, env });
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
// 断言取值全部加空守卫：单条用例失败只记 FAIL，不再抛 TypeError 崩掉整个套件（S3 的另一半）
chk('123 回退备用路线', r.ok && /备域名/.test((r.ctx || {}).route || '') && ((r.files || [])[0] || {}).name === 'd.iso', JSON.stringify(r).slice(0, 200));
d = await call({ drive: 'pan123', action: 'download', cred: {}, ctx: r.ctx, file: (r.files || [])[0] || {} });
chk('123 link', d.ok && d.url.includes('dl.123.example'));

r = await call({ drive: 'guangya', action: 'list', url: 'https://www.guangyapan.com/s/abc_def', cred: {} });
chk('guangya list', r.ok && ((r.files || [])[0] || {}).name === 'e.mkv', JSON.stringify(r).slice(0, 200));
d = await call({ drive: 'guangya', action: 'download', cred: {}, ctx: r.ctx, file: (r.files || [])[0] || {} });
chk('guangya link', d.ok && d.url.includes('dl.guangya.example'));

// S3 统一出口清洗：env 凭证（站长配的、访客共用）原文不得出现在任何响应里
const QENV = { QUARK_COOKIE: '__puus=ENVPUUS; sess=ENVSECRET99' };
r = await call({ drive: 'quark', action: 'list', url: 'https://pan.quark.cn/s/abc123def', pwd: '', cred: {} }, 'POST', QENV);
chk('env 夸克 list 仍可用', r.ok && r.files[0].name === 'c.rar', JSON.stringify(r).slice(0, 200));
chk('env 夸克 ctx.cookie 置空', r.ok && r.ctx.cookie === '', JSON.stringify(r.ctx || {}));
chk('env 夸克 credUpdate 扣下', r.ok && !('credUpdate' in r));
chk('env 夸克响应无凭证原文', !JSON.stringify(r).includes('ENVPUUS') && !JSON.stringify(r).includes('ENVSECRET99') && !JSON.stringify(r).includes('NEWPUUS'), JSON.stringify(r).slice(0, 300));
d = await call({ drive: 'quark', action: 'download', cred: {}, ctx: r.ctx, file: r.files[0] }, 'POST', QENV);
chk('env 夸克 download 仍可用且无凭证', d.ok && d.url.includes('dl.quark.example') && !JSON.stringify(d).includes('ENVSECRET99') && !JSON.stringify(d).includes('NEWPUUS'), JSON.stringify(d).slice(0, 300));

const CENV = { CT_COOKIE: 'ctoken=CTSECRET123456; other=CTVAL999' };
d = await call({ drive: 'ctyun', action: 'download', cred: {}, ctx: {}, file: { id: '1', name: 'f.zip' } }, 'POST', CENV);
chk('env 天翼 download 无 Cookie 头', d.ok && d.url.includes('dl.189.example') && !(d.headers && 'Cookie' in d.headers), JSON.stringify(d).slice(0, 300));
chk('env 天翼响应无凭证原文', !JSON.stringify(d).includes('CTSECRET123456') && !JSON.stringify(d).includes('CTVAL999'), JSON.stringify(d).slice(0, 300));

r = await call({ drive: 'lanzou', action: 'list', url: 'https://www.lanzoux.com/iNewTp9', pwd: '8888', cred: {} });
chk('lanzou 新模板变量 sign 取链', r.ok && r.url === 'https://dl.lanzou.example/file/tok888', JSON.stringify(r).slice(0, 200));

d = await call({ drive: 'pan123', action: 'download', cred: {}, ctx: { key: 'testkey' }, file: { id: '777001', name: 'f.zip', size: 10, etag: 'e', s3: 's' } });
chk('123 跟跳保留签名到节点链', d.ok && d.url === 'https://node123.example/f.zip?v=5&t=111&s=abc&xmfcid=y', JSON.stringify(d).slice(0, 200));
d = await call({ drive: 'pan123', action: 'download', cred: {}, ctx: { key: 'testkey' }, file: { id: '777002', name: 'g.zip', size: 10, etag: 'e', s3: 's' } });
chk('123 跳转丢签名时停在带签名链', d.ok && d.url === 'https://cdn123.example/inner2?v=5&t=222&s=def', JSON.stringify(d).slice(0, 200));

// detectPlatform 主机名锚定：仿冒域名/参数里带域名不再误判
const { detectPlatform } = await import('../functions/api/video.js');
chk('detect 仿冒域名不误判', detectPlatform('https://notdouyin.com/x') === '' && detectPlatform('https://example.com/?u=douyin.com') === '');
chk('detect 子域名正常识别', detectPlatform('https://v.douyin.com/abc/') === 'douyin' && detectPlatform('https://www.bilibili.com/video/BV1') === 'bilibili' && detectPlatform('https://youtu.be/abc') === 'youtube' && detectPlatform('https://t.cn/AbCd') === 'weibo');

console.log(`\nTOTAL pass=${pass} fail=${failN}`);
process.exit(failN ? 1 : 0);
