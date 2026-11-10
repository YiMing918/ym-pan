// ym-pan 短视频去水印解析（Pages Functions）
// 形态与网盘解析一致：服务端解析分享页/接口，只回直链，绝不中转视频流量；
// 视频平台大多免登录（分享页公开），不需要用户凭证。
// 口径依据 2026-11 在维护开源项目（MediaGet / media-parser / short_videos 等），维修见 MAINTENANCE.md。
// 平台分档：主力 douyin/kuaishou/weibo/xiaohongshu/acfun；实验 bilibili/tiktok/jimeng；youtube 平台对服务器 IP
// 有机器人墙 + PO Token 要求，服务端无法取直链，只回嵌入地址并如实说明。

const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const PLATFORMS = {
douyin: { name: '抖音', tier: 1},
kuaishou: { name: '快手', tier: 1},
weibo: { name: '微博视频', tier: 1},
xiaohongshu: { name: '小红书', tier: 2},
acfun: { name: 'AcFun', tier: 1},
bilibili: { name: '哔哩哔哩', tier: 2 },
tiktok: { name: 'TikTok', tier: 2},
jimeng: { name: '即梦 / Dreamina', tier: 2},
youtube: { name: 'YouTube', tier: 0},
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'},
});
const fail = (error, extra = {}) => json({ ok: false, error,...extra});

async function fetchText(url, { ua = UA_DESKTOP, headers = {}, method = 'GET', body, redirect = 'follow', timeout = 25000} = {}) {
const ctl = new AbortController();
const t = setTimeout(() => ctl.abort(), timeout);
try {
const res = await fetch(url, { method, body, redirect, signal: ctl.signal, headers: { 'User-Agent': ua, 'Accept-Language': 'zh-CN,zh;q=0.9',...headers}});
return { res, text: await res.text(), finalUrl: res.url};
} finally { clearTimeout(t);}
}

export function extractUrl(text) {
const m = String(text || '').match(/https?:\/\/[^\s，。；！？、《》"'<>]+/);
if (!m) return '';
return m[0].replace(/[)\].,，。]+$/, '');
}

export function detectPlatform(url) {
const u = url.toLowerCase();
if (/douyin\.com|iesdouyin\.com/.test(u)) return 'douyin';
if (/kuaishou\.com|gifshow\.com/.test(u)) return 'kuaishou';
if (/weibo\.(com|cn)|video\.weibo\.com|t\.cn\//.test(u)) return 'weibo';
if (/xiaohongshu\.com|rednote\.com|xhslink\.(com|cn)/.test(u)) return 'xiaohongshu';
if (/acfun\.cn/.test(u)) return 'acfun';
if (/bilibili\.com|b23\.tv/.test(u)) return 'bilibili';
if (/tiktok\.com|tiktokv\.com/.test(u)) return 'tiktok';
if (/jimeng\.jianying\.com|dreamina\.(capcut\.com|jianying\.com)/.test(u)) return 'jimeng';
if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
return '';
}

// 从 HTML 里抠 `<marker> = {...}` 形式的内嵌 JSON（按括号配平截取；
// 抖音 _ROUTER_DATA 是转义形态（{\"..\"} + \uXXXX），直解失败时自动去转义再试一次）
export function extractJsonAfter(html, marker) {
const i = html.indexOf(marker);
if (i < 0) return null;
const start = html.indexOf('{', i + marker.length);
if (start < 0) return null;
const parseFrom = (s, from) => {
let depth = 0, inStr = false, esc = false;
for (let j = from; j < s.length; j++) {
const c = s[j];
if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
if (c === '"') inStr = true;
else if (c === '{') depth++;
else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(from, j + 1)); } catch { return null; } } }
}
return null;
};
const direct = parseFrom(html, start);
if (direct) return direct;
let seg = html.slice(start, start + 3000000);
const cut = seg.indexOf('</script>');
if (cut > 0) seg = seg.slice(0, cut);
const unescaped = seg.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\"/g, '"').replace(/\\\//g, '/');
return parseFrom(unescaped, 0);
}

const first = (arr) => (Array.isArray(arr) && arr.length? arr[0]: '');
const dewatermarkDouyin = (u) => u? u.replace('/playwm/', '/play/').replace('ratio=720p', 'ratio=1080p'): u;

/* ---------------- 抖音 ---------------- */
let ttwidCache = { v: '', at: 0 };
let ttwidWebCache = { v: '', at: 0 };
async function douyinTtwidWeb() {
if (ttwidWebCache.v && Date.now() - ttwidWebCache.at < 12 * 3600 * 1000) return ttwidWebCache.v;
try {
const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA_DESKTOP }, body: JSON.stringify({ region: 'cn', aid: 6383, need_t: 1, service: 'www.douyin.com', domain: '.douyin.com' }) });
const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
const t = cookies.map(c => c.split(';')[0]).find(c => /^ttwid=/.test(c));
if (t) { ttwidWebCache = { v: t, at: Date.now() }; return t; }
} catch { /* ignore */ }
return '';
}
async function douyinTtwid() {
if (ttwidCache.v && Date.now() - ttwidCache.at < 12 * 3600 * 1000) return ttwidCache.v;
try {
const res = await fetch('https://ttwid.bytedance.com/ttwid/union/register/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA_MOBILE }, body: JSON.stringify({ region: 'cn', aid: 1768, needFid: false, service: 'www.iesdouyin.com', migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true }) });
const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
const t = cookies.map(c => c.split(';')[0]).find(c => /^ttwid=/.test(c));
if (t) { ttwidCache = { v: t, at: Date.now() }; return t; }
} catch { /* ignore */ }
return '';
}
function douyinItemFromHtml(html) {
const data = extractJsonAfter(html, 'window._ROUTER_DATA');
if (data && data.loaderData) {
for (const node of Object.values(data.loaderData)) {
const res = node && node.videoInfoRes;
if (res && Array.isArray(res.item_list) && res.item_list.length) return res.item_list[0];
}
}
return null;
}
async function parseDouyin(rawUrl) {
let url = rawUrl, id = '', kind = 'video';
let m = url.match(/\/(video|note)\/(\d+)/);
if (m) { kind = m[1]; id = m[2]; }
else {
const { finalUrl } = await fetchText(url, { ua: UA_MOBILE });
url = finalUrl;
m = url.match(/\/(video|note)\/(\d+)/);
if (m) { kind = m[1]; id = m[2]; }
}
if (!id) throw new Error('没认出抖音作品（需要 v.douyin.com 短链或 douyin.com/video/ 长链）');
const pageUrl = `https://www.iesdouyin.com/share/${kind === 'note' ? 'note' : 'video'}/${id}/`;
let item = null, route = '分享页 _ROUTER_DATA';
{
const { text: html } = await fetchText(pageUrl, { ua: UA_MOBILE });
item = douyinItemFromHtml(html);
}
if (!item) { // 访客标识 ttwid 解锁路线（数据中心 IP 常先吃验证壳页，拿到 ttwid 后重取）
const tw = await douyinTtwid();
if (tw) {
const { text: html } = await fetchText(pageUrl, { ua: UA_MOBILE, headers: { Cookie: tw } });
item = douyinItemFromHtml(html);
if (item) route = '分享页（ttwid 解锁）';
}
}
if (!item) { // 兜底老接口（数据中心 IP 常返回空）
try {
const { text } = await fetchText(`https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${id}`, { ua: UA_MOBILE });
const d = JSON.parse(text);
if (d.item_list && d.item_list.length) { item = d.item_list[0]; route = '老接口 iteminfo'; }
} catch { /* ignore */ }
}
if (!item) { // 第四级：Web detail 接口 + www.douyin.com 域 ttwid（aid 6383 注册口径，2026-11-10 按现行多级链补）
try {
const tw2 = await douyinTtwidWeb();
if (tw2) {
const { text } = await fetchText(`https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}&aid=6383&device_platform=webapp&channel=channel_pc_web`, { ua: UA_DESKTOP, headers: { Cookie: tw2, Referer: 'https://www.douyin.com/' } });
const d = JSON.parse(text);
if (d.aweme_detail) { item = d.aweme_detail; route = 'Web detail 接口（ttwid）'; }
}
} catch { /* ignore */ }
}
if (!item) throw new Error('抖音没返回作品数据：它对服务器 IP 的验证拦截很强（已试分享页、ttwid 解锁、老接口、Web detail 四条路线），这条暂时解不了，换一条或稍后再试');
const base = { platform: 'douyin', title: item.desc || '', author: (item.author && item.author.nickname) || '', route };
if (kind === 'note' || (item.images && item.images.length)) {
const images = (item.images || []).map(im => first(im.download_url_list) || first(im.url_list)).filter(Boolean);
return { ...base, type: 'image', cover: images[0] || '', images, url: images[0] || '', note: `图文共 ${images.length} 张原图` };
}
const v = item.video || {};
const qualities = [];
const main = dewatermarkDouyin(first((v.play_addr || {}).url_list));
if (main) qualities.push({ label: '无水印', url: main });
for (const br of (v.bit_rate || [])) {
const u = dewatermarkDouyin(first((br.play_addr || {}).url_list));
if (u && !qualities.some(q => q.url === u)) qualities.push({ label: br.gear_name || '多码率', url: u });
}
if (!qualities.length && v.play_addr && v.play_addr.uri) {
qualities.push({ label: '无水印 1080p', url: `https://www.iesdouyin.com/aweme/v1/play/?video_id=${v.play_addr.uri}&ratio=1080p` });
}
if (!qualities.length) throw new Error('抖音作品里没找到视频地址');
return { ...base, type: 'video', cover: first((v.cover || {}).url_list) || '', url: qualities[0].url, qualities };
}

/* ---------------- 快手 ---------------- */
function jsonUnescape(s) { return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/').replace(/\\"/g, '"');}
async function parseKuaishou(rawUrl) {
let photoId = '', landedUrl = '';
let m = rawUrl.match(/short-video\/([0-9a-zA-Z_-]+)/) || rawUrl.match(/fw\/photo\/([0-9a-zA-Z_-]+)/);
if (m) photoId = m[1];
else {
const { finalUrl} = await fetchText(rawUrl, { ua: UA_MOBILE});
landedUrl = finalUrl;
m = finalUrl.match(/short-video\/([0-9a-zA-Z_-]+)/) || finalUrl.match(/fw\/photo\/([0-9a-zA-Z_-]+)/) || finalUrl.match(/[?&]photoId=([0-9a-zA-Z_-]+)/);
if (m) photoId = m[1];
}
if (!photoId) throw new Error('没认出快手作品（需要 v.kuaishou.com 短链或 short-video 长链）');
const candUrls = [];
if (landedUrl && landedUrl.includes('/fw/photo/')) candUrls.push(landedUrl);
candUrls.push(`https://www.kuaishou.com/fw/photo/${photoId}`, `https://m.gifshow.com/fw/photo/${photoId}`);
let html = '', usedHost = '';
for (const cand of candUrls) {
let r;
try { r = await fetchText(cand, { ua: UA_MOBILE}); } catch { continue; }
const h = cand;
if (r.text.includes('photoUrl') || r.text.includes('mainMvUrls')) { html = r.text; usedHost = h; break; }
if (!html) { html = r.text; usedHost = h;}
}
const U = jsonUnescape(html);
const grab = (re) => { const mm = U.match(re); return mm ? mm[1] : ''; };
const qualities = [];
const main = grab(/"photoUrl"\s*:\s*"([^"]+)"/) || grab(/"photoH265Url"\s*:\s*"([^"]+)"/);
if (main) qualities.push({ label: '无水印原画', url: main });
const h265 = grab(/"photoH265Url"\s*:\s*"([^"]+)"/);
if (h265 && h265 !== main) qualities.push({ label: 'H265', url: h265 });
if (!qualities.length) {
const idx = U.indexOf('mainMvUrls');
if (idx >= 0) {
const seg = U.slice(idx, idx + 8000);
const urls = [...seg.matchAll(/"url"\s*:\s*"(https:[^"]+?)"/g)].map(x => x[1]).filter(u => u.includes('.mp4'));
const mine = urls.filter(u => u.includes(photoId));
const picked = (mine.length ? mine : urls).filter((u, ix, a) => a.indexOf(u) === ix).slice(0, 4);
picked.forEach((u, ix) => qualities.push({ label: ix === 0 ? '无水印' : '清晰度 ' + (ix + 1), url: u }));
}
}
if (!qualities.length) throw new Error('快手没返回视频地址（可能被风控或作品已删），稍后再试');
return {
platform: 'kuaishou', type: 'video',
title: grab(/"caption"\s*:\s*"([^"]*)"/) || '',
author: grab(/"userName"\s*:\s*"([^"]*)"/) || '',
cover: grab(/"coverUrls"\s*:\s*\[\s*\{\s*"url"\s*:\s*"([^"]+)"/) || grab(/"coverUrl"\s*:\s*"([^"]+)"/) || '',
url: qualities[0].url, qualities, route: `H5 分享页（${usedHost.replace('https://', '')}）`,
};
}

/* ---------------- 微博 ---------------- */
// 2026-11-09 按 yt-dlp 现行实现逐字对照重做（旧口径下 fid 专页路线全灭）：
// ① 游客票据：genvisitor 必须带 fp 指纹载荷（cb=gen_callback，旧版无 fp 且 cb 名过时）；
//    incarnate 的 w/c 按响应里的 new_tid/confidence 拼（旧版写死 w=2&c=095）；
//    换回的 Cookie 收全套（SUB/SUBP 等），不再只取 SUB。
// ② fid 专页：tv/api/component 的 body 是单个 data 字段装 JSON（旧版拿组件名当字段名），
//    Referer 用专页地址本身；组件新口径只取 mid，再走帖子通道拿 playback_list。
// ③ ajax/组件回 HTML（被跳 passport）= 票据被拒：强制刷新票据重试一次，仍不行再降级。
let weiboCookieCache = { cookie: '', at: 0 };
function parseJsonpLoose(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch { /* 非纯 JSON 再试 JSONP 剥壳 */ }
  const i = t.indexOf('('), j = t.lastIndexOf(')');
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i + 1, j)); } catch { /* ignore */ } }
  return null;
}
async function weiboVisitorCookie(force = false) {
  if (!force && weiboCookieCache.cookie && Date.now() - weiboCookieCache.at < 20 * 60 * 1000) return weiboCookieCache.cookie;
  const chromeVer = (UA_DESKTOP.match(/Chrome\/(\d+)/) || [])[1] || '131';
  const fp = JSON.stringify({ os: '1', browser: `Chrome${chromeVer},0,0,0`, fonts: 'undefined', screenInfo: '1920*1080*24', plugins: '' });
  const gen = await fetchText('https://passport.weibo.com/visitor/genvisitor', {
    ua: UA_DESKTOP, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://weibo.com/' },
    body: new URLSearchParams({ cb: 'gen_callback', fp }).toString(),
  });
  const data = (parseJsonpLoose(gen.text) || {}).data;
  if (!data || !data.tid) throw new Error('微博游客凭证获取失败');
  const w = data.new_tid ? 3 : 2;
  const c = String(data.confidence == null ? 100 : data.confidence).padStart(3, '0');
  const inc = await fetch(`https://passport.weibo.com/visitor/visitor?a=incarnate&t=${encodeURIComponent(data.tid)}&w=${w}&c=${c}&gc=&cb=cross_domain&from=weibo&_rand=${Math.random()}`, {
    headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://weibo.com/' }, redirect: 'manual',
  });
  const cookies = typeof inc.headers.getSetCookie === 'function' ? inc.headers.getSetCookie() : [];
  const pairs = cookies.map(x => x.split(';')[0]).filter(x => /^[A-Za-z0-9_\-]+=[^;]*$/.test(x));
  if (!pairs.some(x => /^SUB=/.test(x))) throw new Error('微博游客凭证换取失败');
  const cookie = pairs.join('; ');
  weiboCookieCache = { cookie, at: Date.now() };
  return cookie;
}

function weiboFromStatus(d, route) {
  const st = d.data || d;
  const pi = st.page_info || {};
  const mi = pi.media_info || {};
  const qualities = [];
  for (const p of (mi.playback_list || [])) {
    if (p.meta && p.meta.type === 3) continue; // 进度条预览图，不是视频
    if (p.play_info && p.play_info.url) qualities.push({ label: p.play_info.quality_label || '视频', url: p.play_info.url });
  }
  if (!qualities.length) {
    const u = mi.stream_url_hd || mi.stream_url || st.mp4_hd_url || mi.mp4_hd_url;
    if (u) qualities.push({ label: '高清 720p', url: u });
  }
  if (!qualities.length && pi.media_info === undefined && st.mix_media_info) {
    for (const it of (st.mix_media_info.items || [])) {
      const v = it.data && it.data.media_info;
      if (v && (v.stream_url_hd || v.stream_url)) qualities.push({ label: '高清 720p', url: v.stream_url_hd || v.stream_url });
    }
  }
  if (!qualities.length) throw new Error('这条微博里没找到视频（可能只是图文，或视频已删）');
  return {
    platform: 'weibo', type: 'video', route,
    title: (st.text_raw || '').slice(0, 80), author: (st.user && st.user.screen_name) || '',
    cover: pi.page_pic || '', url: qualities[0].url, qualities,
    needReferer: 'https://weibo.com/', note: '微博直链下载必须带 Referer（下方「链接+请求头」已配好），直接点开会 403',
  };
}

async function weiboStatusJson(id, cookie) {
  const call = (ck) => fetchText(`https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(id)}&locale=zh-CN&isGetLongText=true`, {
    ua: UA_DESKTOP, headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://weibo.com/', ...(ck ? { Cookie: ck } : {}) },
  });
  let d = parseJsonpLoose((await call(cookie)).text);
  if (!d) { // 回 HTML 多半是被跳 passport（票据被拒）：强制刷新票据重试一次
    const fresh = await weiboVisitorCookie(true).catch(() => '');
    if (fresh) d = parseJsonpLoose((await call(fresh)).text); // 强制刷新必是新取的票据，无条件重试（不比对新旧值）
  }
  if (!d) throw new Error('html');
  return d;
}

async function weiboComponent(oid, cookie) {
  // body 逐字照 yt-dlp 现行口径：单个 data 字段装 JSON，不做 URL 编码
  const body = `data=${JSON.stringify({ Component_Play_Playinfo: { oid } })}`;
  const call = (ck) => fetchText('https://weibo.com/tv/api/component?page=' + encodeURIComponent(`/tv/show/${oid}`), {
    ua: UA_DESKTOP, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: `https://weibo.com/tv/show/${oid}`, ...(ck ? { Cookie: ck } : {}) },
    body,
  });
  let d = parseJsonpLoose((await call(cookie)).text);
  if (!d) { // 同上：票据被拒时刷新重试一次
    const fresh = await weiboVisitorCookie(true).catch(() => '');
    if (fresh) d = parseJsonpLoose((await call(fresh)).text); // 强制刷新必是新取的票据，无条件重试（不比对新旧值）
  }
  if (!d) return null;
  return (d.data && d.data.Component_Play_Playinfo) || null;
}

async function parseWeibo(rawUrl) {
  let url = rawUrl;
  if (/t\.cn\//.test(url)) { const r = await fetchText(url, { ua: UA_MOBILE }); url = r.finalUrl; }
  const fidM = url.match(/fid=([0-9a-zA-Z:]+)/) || url.match(/tv\/show\/([0-9a-zA-Z:]+)/) || url.match(/video\.weibo\.com\/show\?fid=([0-9a-zA-Z:]+)/);
  const postM = url.match(/weibo\.(?:com|cn)\/(\d+)\/([0-9a-zA-Z]+)/);
  const cookie = await weiboVisitorCookie().catch(() => '');
  if (fidM) { // 视频专页：组件接口换 mid（现行口径），再走帖子通道取多档直链
    const oid = decodeURIComponent(fidM[1]);
    const comp = await weiboComponent(oid, cookie).catch(() => null);
    if (comp) {
      const qualities = [];
      const urls = comp.urls || {};
      for (const [label, u] of Object.entries(urls)) if (u) qualities.push({ label, url: String(u).replace(/^\/\//, 'https://') });
      if (!qualities.length && comp.stream_url) qualities.push({ label: '高清', url: comp.stream_url });
      if (qualities.length) return { platform: 'weibo', type: 'video', route: 'tv 组件接口', title: comp.title || '', author: '', cover: comp.cover_image || '', url: qualities[0].url, qualities, needReferer: 'https://weibo.com/', note: '微博直链下载必须带 Referer（下方「链接+请求头」已配好），直接点开会 403' };
      if (comp.mid) {
        try { return weiboFromStatus(await weiboStatusJson(comp.mid, cookie), 'tv 组件→帖子接口'); }
        catch (e) { if (/没找到视频/.test(e.message)) throw e; }
      }
    }
    throw new Error('微博视频专页解析失败（接口可能改版），稍后再试');
  }
  if (postM) {
    const bid = postM[2];
    try {
      return weiboFromStatus(await weiboStatusJson(bid, cookie), '帖子接口');
    } catch (e) {
      if (/没找到视频/.test(e.message)) throw e;
      const r2 = await fetchText(`https://m.weibo.cn/statuses/show?id=${bid}`, { ua: UA_MOBILE, headers: { Referer: 'https://m.weibo.cn/', ...(cookie ? { Cookie: cookie } : {}) } });
      return weiboFromStatus(JSON.parse(r2.text), '手机端帖子接口（封顶 720p）');
    }
  }
  throw new Error('没认出微博链接（需要 video.weibo.com 专页链或 weibo.com 帖子链）');
}

/* ---------------- 小红书 ---------------- */
async function parseXiaohongshu(rawUrl) {
  let url = rawUrl;
  const NOTE_RE = /\/(?:explore|discovery\/item)\/[0-9a-f]+/;
  if (/xhslink\.(com|cn)/.test(url)) {
    // 短链按出口 IP/UA 路由：国内落 xiaohongshu.com、海外落 rednote.com（同一篇笔记、页面结构一致，两边都认）。
    // 机房出口常被短链服务给中转页/不跳转，多策略兜底：移动 UA 跟随 → 正文扫笔记链 → 桌面 UA 再跟 → 手动读第一跳 Location。
    const shortUrl = url;
    const scanText = t => {
      const m = String(t || '').match(/https?:\/\/(?:www\.)?(?:xiaohongshu|rednote)\.com\/(?:explore|discovery\/item)\/[0-9a-f]+[^"'<>\s\\]*/);
      return m ? m[0].replace(/&amp;/g, '&') : '';
    };
    const r = await fetchText(shortUrl, { ua: UA_MOBILE });
    url = r.finalUrl;
    if (!NOTE_RE.test(url)) url = scanText(r.text) || url;
    if (!NOTE_RE.test(url)) {
      const r2 = await fetchText(shortUrl, { ua: UA_DESKTOP });
      if (NOTE_RE.test(r2.finalUrl)) url = r2.finalUrl; else url = scanText(r2.text) || url;
    }
    if (!NOTE_RE.test(url)) {
      try {
        const ctl = new AbortController(); const tt = setTimeout(() => ctl.abort(), 15000);
        const rr = await fetch(shortUrl, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA_MOBILE, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
        clearTimeout(tt);
        const loc = rr.headers.get('location');
        if (loc && NOTE_RE.test(loc)) url = loc;
      } catch { /* ignore */ }
    }
    if (/xhslink/.test(url)) { const m = (r.text || '').match(/<a[^>]+href="([^"]+)"/); if (m) url = m[1].replace(/&amp;/g, '&'); }
    const om = url.match(/[?&]originalUrl=([^&]+)/);
    if (om) { try { url = decodeURIComponent(om[1]); } catch { /* ignore */ } }
  }
  const idM = url.match(/\/(?:explore|discovery\/item)\/([0-9a-f]+)/);
  if (!idM) throw new Error('没认出小红书笔记（需要 xhslink 短链或 xiaohongshu.com 笔记链）');
  const noteId = idM[1];
  // 笔记页抓取多策略：机房出口常被风控页拦——同 id+token 在双域名（xiaohongshu.com/rednote.com）互备、
  // 先访问域名根拿一遍 Cookie 再带上、移动 UA 失败换桌面 UA，全灭才报风控。
  const parseState = html => {
    const i = html.indexOf('window.__INITIAL_STATE__');
    if (i < 0) return null;
    const start = html.indexOf('{', i);
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = start; j < html.length; j++) { const c = html[j]; if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; } if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) { end = j; break; } } }
    if (end > start) { try { return JSON.parse(html.slice(start, end + 1).replace(/undefined/g, 'null')); } catch { return null; } }
    return null;
  };
  const noteFromState = st => {
    let n = null;
    try { n = st.noteData && st.noteData.data && st.noteData.data.noteData; } catch { /* ignore */ }
    if (!n) { try { n = st.note && st.note.noteDetailMap && st.note.noteDetailMap[noteId] && st.note.noteDetailMap[noteId].note; } catch { /* ignore */ } }
    return n;
  };
  const altDomain = u => u.includes('rednote.com') ? u.replace('www.rednote.com', 'www.xiaohongshu.com') : u.replace('www.xiaohongshu.com', 'www.rednote.com');
  const candidates = [url];
  const alt = altDomain(url);
  if (alt !== url) candidates.push(alt);
  let note = null, html = '', usedUrl = url, lastStatus = 0;
  outer:
  for (const cand of candidates) {
    const host = new URL(cand).host;
    for (const ua of [UA_MOBILE, UA_DESKTOP]) {
      try {
        let cookie = '';
        try {
          const warm = await fetchText(`https://${host}/`, { ua });
          const sc = warm.res.headers.getSetCookie ? warm.res.headers.getSetCookie() : [];
          cookie = sc.map(s => s.split(';')[0]).filter(Boolean).join('; ');
        } catch { /* 预热失败不挡正事 */ }
        const r = await fetchText(cand, { ua, headers: { Referer: `https://${host}/`, ...(cookie ? { Cookie: cookie } : {}) } });
        html = r.text; lastStatus = r.res.status; usedUrl = cand;
        const st = parseState(html);
        if (st) { const n = noteFromState(st); if (n) { note = n; break outer; } }
      } catch { /* 换下一策略 */ }
    }
  }
  if (!note) {
    if (/sec_server/.test(html) || /\/404\//.test(usedUrl)) throw new Error('这条小红书链接的分享凭证（xsec_token）已失效或被拦：请在小红书 App 里打开这篇笔记，重新点分享→复制链接，再粘最新链接来解析');
    throw new Error(`小红书页面没返回数据（双域名+双 UA 都被风控页拦，HTTP ${lastStatus}），稍后再试；若一直这样，是小红书对服务器出口的风控，不是你的链接有问题`);
  }
  const base = { platform: 'xiaohongshu', title: note.title || note.desc || '', author: (note.user && note.user.nickname) || '', route: `笔记页 __INITIAL_STATE__（${new URL(usedUrl).host}）` };
  const imageList = note.imageList || [];
  if (note.type === 'video' && note.video) {
    const v = note.video;
    const qualities = [];
    if (v.consumer && v.consumer.originVideoKey) qualities.push({ label: '原画（作者原文件）', url: `https://sns-video-bd.xhscdn.com/${v.consumer.originVideoKey}` });
    const streams = (v.media && v.media.stream) || {};
    const all = [...(streams.h264 || []), ...(streams.h265 || []), ...(streams.av1 || [])]
      .filter(s => s.masterUrl && ![259, 309].includes(s.streamType))
      .sort((a, b) => ([258, 301].includes(b.streamType) ? 1 : 0) - ([258, 301].includes(a.streamType) ? 1 : 0));
    for (const s of all) if (!qualities.some(q => q.url === s.masterUrl)) qualities.push({ label: s.streamDesc || `流 ${s.streamType}`, url: s.masterUrl });
    if (!qualities.length) throw new Error('小红书视频流没找到（笔记可能已删或结构改版）');
    return { ...base, type: 'video', cover: (imageList[0] && imageList[0].urlDefault) || '', url: qualities[0].url, qualities };
  }
  const images = imageList.map(im => im.urlDefault).filter(Boolean);
  const lives = imageList.filter(im => im.livePhoto && im.stream && im.stream.h264 && im.stream.h264[0]).map(im => im.stream.h264[0].masterUrl);
  if (!images.length) throw new Error('小红书笔记里没找到图片');
  return { ...base, type: 'image', cover: images[0], images, url: images[0], note: `图文共 ${images.length} 张原图${lives.length ? `，其中 ${lives.length} 张实况照片的视频流在 qualities 里` : ''}`, qualities: lives.map((u, ix) => ({ label: `实况 ${ix + 1}`, url: u })) };
}

/* ---------------- AcFun ---------------- */
async function parseAcfun(rawUrl) {
  const m = rawUrl.match(/ac(\d+)/i);
  if (!m) throw new Error('没认出 AcFun 链接（需要 acfun.cn/v/ac… 稿件链）');
  const { text: html } = await fetchText(`https://www.acfun.cn/v/ac${m[1]}`, { ua: UA_DESKTOP });
  const info = extractJsonAfter(html, 'window.pageInfo');
  if (!info || !info.currentVideoInfo || !info.currentVideoInfo.ksPlayJson) {
    throw new Error('AcFun 稿件数据没找到（可能已下线或为限定稿件）');
  }
  let play;
  try { play = JSON.parse(info.currentVideoInfo.ksPlayJson); } catch { throw new Error('AcFun 播放数据损坏'); }
  const reps = ((play.adaptationSet || [])[0] || {}).representation || [];
  const qualities = reps.filter(r => r.url).map(r => ({ label: r.qualityLabel || r.qualityType || 'm3u8', url: r.url }));
  if (!qualities.length) throw new Error('AcFun 没找到播放流');
  return {
    platform: 'acfun', type: 'hls', route: '稿件页 pageInfo',
    title: info.title || (info.currentVideoInfo && info.currentVideoInfo.title) || '',
    author: (info.userData && info.userData.name) || '', cover: info.coverUrl || '',
    url: qualities[0].url, qualities,
    note: 'AcFun 给的是 m3u8 流（分段视频），不是单个 mp4：把直链粘到你的下载器里保存，或用播放器打开。',
  };
}

/* ---------------- 哔哩哔哩 ---------------- */
let buvidCache = { v: '', at: 0 };
async function bilibiliBuvid() {
  if (buvidCache.v && Date.now() - buvidCache.at < 12 * 3600 * 1000) return buvidCache.v;
  try {
    const { text } = await fetchText('https://api.bilibili.com/x/frontend/finger/spi', { ua: UA_DESKTOP });
    const d = JSON.parse(text);
    if (d.data && d.data.b_3) { buvidCache = { v: 'buvid3=' + d.data.b_3, at: Date.now() }; return buvidCache.v; }
  } catch { /* ignore */ }
  return '';
}
/* B 站现行口径 2026-11-10 补强（WBI 签名 + bili_ticket，smoothbili/yt-dlp 同路线）：
   老实现只带 buvid 裸打非 wbi 接口，view/playurl 常吃 -352/412。
   WBI：nav 取 wbi_img 两文件名拼 64 字符 → mixinKeyEncTab 重排取前 32 为 mixin_key → 参数排序 + wts + w_rid=md5(query+mixin)。
   bili_ticket：HMAC-SHA256(key=XgwSnGZ1p, "ts"+ts) 调 GenWebTicket，票 3 天有效、缓存 24h，显著降 412 概率（机房 IP 仍不保证）。 */
function md5hex(input) {
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const bytes = [...new TextEncoder().encode(input)];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) & 0xff);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rot = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) M[i] = (bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24)) >>> 0;
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D; D = C; C = B;
      B = (B + rot((A + F + K[i] + M[g]) >>> 0, S[i])) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const le = n => [0, 8, 16, 24].map(s => ((n >>> s) & 0xff).toString(16).padStart(2, '0')).join('');
  return le(a0) + le(b0) + le(c0) + le(d0);
}
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
let wbiCache = { key: '', at: 0 };
async function biliWbiKey(cookie) {
  if (wbiCache.key && Date.now() - wbiCache.at < 30 * 60 * 1000) return wbiCache.key;
  try {
    const { text } = await fetchText('https://api.bilibili.com/x/web-interface/nav', { ua: UA_DESKTOP, headers: { Referer: 'https://www.bilibili.com/', ...(cookie ? { Cookie: cookie } : {}) } });
    const d = JSON.parse(text);
    const img = d.data && d.data.wbi_img;
    if (!img || !img.img_url || !img.sub_url) return '';
    const raw = img.img_url.split('/').pop().split('.')[0] + img.sub_url.split('/').pop().split('.')[0];
    const key = MIXIN_TAB.map(i => raw[i]).join('').slice(0, 32);
    if (key.length === 32) { wbiCache = { key, at: Date.now() }; return key; }
  } catch { /* ignore */ }
  return '';
}
function wbiQuery(params, mixinKey) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(p).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${query}&w_rid=${md5hex(query + mixinKey)}`;
}
let ticketCache = { v: '', at: 0 };
async function biliTicket() {
  if (ticketCache.v && Date.now() - ticketCache.at < 24 * 3600 * 1000) return ticketCache.v;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('XgwSnGZ1p'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`ts${ts}`));
    const hexsign = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
    const r = await fetch(`https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket?key_id=ec02&hexsign=${hexsign}&context%5Bts%5D=${ts}&csrf=`, { method: 'POST', headers: { 'User-Agent': UA_DESKTOP, Referer: 'https://www.bilibili.com/' } });
    const d = await r.json().catch(() => null);
    const ticket = d && d.data && d.data.ticket;
    if (ticket) { ticketCache = { v: ticket, at: Date.now() }; return ticket; }
  } catch { /* ignore */ }
  return '';
}
async function parseBilibili(rawUrl) {
  let url = rawUrl, bv = '';
  let m = url.match(/(BV[0-9a-zA-Z]{10})/);
  if (m) bv = m[1];
  else {
    const r = await fetchText(url, { ua: UA_MOBILE, headers: { Referer: 'https://www.bilibili.com/' } });
    url = r.finalUrl;
    m = url.match(/(BV[0-9a-zA-Z]{10})/);
    if (m) bv = m[1];
  }
  if (!bv) throw new Error('没认出 B 站视频（需要 b23.tv 短链或 bilibili.com/video/BV… 长链）');
  const ref = { Referer: 'https://www.bilibili.com/' };
  const buvid = await bilibiliBuvid();
  const ticket = await biliTicket();
  const cookieStr = [buvid, ticket ? `bili_ticket=${ticket}` : ''].filter(Boolean).join('; ');
  const auth = cookieStr ? { ...ref, Cookie: cookieStr } : ref;
  const mixinKey = await biliWbiKey(cookieStr);
  let view = null;
  if (mixinKey) {
    try {
      const r = await fetchText(`https://api.bilibili.com/x/web-interface/wbi/view?${wbiQuery({ bvid: bv }, mixinKey)}`, { ua: UA_DESKTOP, headers: auth });
      const d = JSON.parse(r.text);
      if (d && d.data) view = d;
    } catch { /* 落普通 view */ }
  }
  if (!view) {
    const viewR = await fetchText(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`, { ua: UA_DESKTOP, headers: auth });
    try { view = JSON.parse(viewR.text); } catch { view = null; }
  }
  if (view && view.code === -404) throw new Error('这个 B 站视频不存在或已删除');
  if (!view || !view.data) {
    // 接口被拦时走视频页 __playinfo__ 兜底（页面常比 API 宽容）
    const page = await fetchText(`https://www.bilibili.com/video/${bv}`, { ua: UA_DESKTOP, headers: auth });
    const pi = extractJsonAfter(page.text, 'window.__playinfo__=');
    const pd = pi && pi.data;
    if (!pd || (!pd.durl && !pd.dash)) throw new Error('B 站接口被拦截（返回了网页而不是数据，多半是风控），稍后再试');
    const qs = [];
    if (pd.durl && pd.durl.length) qs.push({ label: '单文件 MP4（可直接下载）', url: pd.durl[0].url });
    if (pd.dash) {
      const vs = [...(pd.dash.video || [])].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      if (vs.length) qs.push({ label: `视频轨 ${vs[0].id}（无声，需与音频轨一起下后合并）`, url: vs[0].baseUrl || vs[0].base_url });
      const as = [...(pd.dash.audio || [])].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      if (as.length) qs.push({ label: '音频轨（与视频轨一起下载）', url: as[0].baseUrl || as[0].base_url });
    }
    const tm = page.text.match(/<meta property="og:title" content="([^"]+)"/) || page.text.match(/<title>([^<]+?) - 哔哩哔哩/);
    const im = page.text.match(/<meta property="og:image" content="([^"]+)"/);
    return { platform: 'bilibili', type: 'video', title: tm ? tm[1] : '', author: '', cover: im ? im[1] : '', url: qs[0].url, qualities: qs, needReferer: 'https://www.bilibili.com/', route: '视频页 __playinfo__（接口被拦兜底）', note: 'B 站直链下载时必须带 Referer（已在下方「链接+请求头」里配好）；未登录最高约 480p/720p 双流，1080p 需要登录，本站不收你的 B 站账号。' };
  }
  const cid = view.data.cid;
  const base = { platform: 'bilibili', title: view.data.title || '', author: (view.data.owner && view.data.owner.name) || '', cover: view.data.pic || '', needReferer: 'https://www.bilibili.com/' };
  const qualities = [];
  let note = 'B 站直链下载时必须带 Referer（已在下方「链接+请求头」里配好）；未登录最高：单文件 480p / 双流 720p，1080p 需要登录，本站不收你的 B 站账号，如实到此为止。';
  const playBase = mixinKey ? 'https://api.bilibili.com/x/player/wbi/playurl' : 'https://api.bilibili.com/x/player/playurl';
  const playQs = params => mixinKey ? wbiQuery(params, mixinKey) : new URLSearchParams(params).toString();
  try { // 单文件 mp4（fnval=0）
    const r = await fetchText(`${playBase}?${playQs({ bvid: bv, cid, qn: 64, fnval: 0 })}`, { ua: UA_DESKTOP, headers: auth });
    const d = JSON.parse(r.text);
    const durl = d.data && d.data.durl && d.data.durl[0];
    if (durl && durl.url) qualities.push({ label: `单文件 MP4（${(d.data.quality === 32 ? '480p' : '标清')}，可直接下载）`, url: durl.url });
  } catch { /* ignore */ }
  try { // DASH 双流（fnval=4048）
    const r = await fetchText(`${playBase}?${playQs({ bvid: bv, cid, qn: 80, fnval: 4048, fourk: 1 })}`, { ua: UA_DESKTOP, headers: auth });
    const d = JSON.parse(r.text);
    const dash = d.data && d.data.dash;
    if (dash && dash.video && dash.video.length) {
      const best = dash.video.slice().sort((a, b) => (b.id - a.id) || ((b.bandwidth || 0) - (a.bandwidth || 0)))[0];
      qualities.push({ label: `视频轨 ${best.id >= 64 ? '720p' : best.id}（无声，需与音频轨一起下后合并）`, url: best.baseUrl || best.base_url });
      if (dash.audio && dash.audio.length) qualities.push({ label: '音频轨（与视频轨一起下载）', url: dash.audio[0].baseUrl || dash.audio[0].base_url });
    }
  } catch { /* ignore */ }
  if (!qualities.length) { // 页面 __playinfo__ 兜底
    const page = await fetchText(`https://www.bilibili.com/video/${bv}`, { ua: UA_DESKTOP, headers: auth });
    const pi = extractJsonAfter(page.text, 'window.__playinfo__');
    const durl = pi && pi.data && pi.data.durl && pi.data.durl[0];
    if (durl && durl.url) qualities.push({ label: '单文件 MP4（页面路线）', url: durl.url });
  }
  if (!qualities.length) throw new Error('B 站取流失败（可能被风控 412），稍后再试');
  return { ...base, type: 'video', route: 'view + playurl 接口', url: qualities[0].url, qualities, note };
}

/* ---------------- TikTok（实验） ---------------- */
async function parseTiktok(rawUrl) {
  let url = rawUrl, id = '';
  let m = url.match(/\/video\/(\d+)/);
  if (m) id = m[1];
  else {
    const r = await fetchText(url, { ua: UA_DESKTOP });
    url = r.finalUrl;
    m = url.match(/\/video\/(\d+)/);
    if (m) id = m[1];
  }
  if (!id) throw new Error('没认出 TikTok 视频（需要 vm/vt.tiktok.com 短链或 tiktok.com/@…/video/ 长链）');
  // 路线 A：网页 SSR
  try {
    const { text: html } = await fetchText(url.includes('/video/') ? url : `https://www.tiktok.com/@i/video/${id}`, { ua: UA_DESKTOP });
    const mm = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/);
    if (mm) {
      const data = JSON.parse(mm[1]);
      const scope = data.__DEFAULT_SCOPE__ || {};
      const detail = scope['webapp.video-detail'] || {};
      const item = detail.itemInfo && detail.itemInfo.itemStruct;
      if (item && item.video) {
        const qualities = [];
        if (item.video.playAddr) qualities.push({ label: '无水印', url: item.video.playAddr });
        for (const b of (item.video.bitrateInfo || [])) {
          const u = b.PlayAddr && b.PlayAddr.UrlList && b.PlayAddr.UrlList[0];
          if (u && !qualities.some(q => q.url === u)) qualities.push({ label: b.GearName || '多码率', url: u });
        }
        if (qualities.length) return { platform: 'tiktok', type: 'video', route: '网页 SSR（实验）', title: item.desc || '', author: (item.author && (item.author.nickname || item.author.uniqueId)) || '', cover: item.video.cover || '', url: qualities[0].url, qualities, note: 'TikTok 直链时效很短，解析后请尽快下载。' };
      }
    }
  } catch { /* 落路线 B */ }
  // 路线 B：App feed 接口
  try {
    const { text } = await fetchText(`https://api16-normal-c-useast1a.tiktokv.com/aweme/v1/feed/?aweme_id=${id}`, { ua: UA_MOBILE });
    const d = JSON.parse(text);
    const aw = d.aweme_list && d.aweme_list[0];
    const u = aw && aw.video && aw.video.play_addr && first(aw.video.play_addr.url_list);
    if (u) return { platform: 'tiktok', type: 'video', route: 'App 接口（实验）', title: aw.desc || '', author: (aw.author && aw.author.nickname) || '', cover: first(((aw.video.cover || {}).url_list)) || '', url: u, qualities: [{ label: '无水印', url: u }], note: 'TikTok 直链时效很短，解析后请尽快下载。' };
  } catch { /* ignore */ }
  // 路线 C：第三方公开接口 tikwm 兜底（2026-11-10 补；本站直连被拦时用，稳定性不受本站控制，结果如实标注来源）
  try {
    const { text } = await fetchText(`https://tikwm.com/api/?url=${encodeURIComponent(rawUrl)}&hd=1`, { ua: UA_DESKTOP });
    const d = JSON.parse(text);
    const v = d && d.data;
    if (v && v.id) {
      const author = (v.author && (v.author.nickname || v.author.unique_id)) || '';
      if (Array.isArray(v.images) && v.images.length) {
        return { platform: 'tiktok', type: 'image', route: '第三方通道 tikwm（兜底）', title: v.title || '', author, cover: v.cover || v.images[0], images: v.images, url: v.images[0], note: `图文共 ${v.images.length} 张（第三方通道兜底）` };
      }
      const qualities = [];
      if (v.hdplay) qualities.push({ label: '高清无水印（第三方通道）', url: v.hdplay });
      if (v.play && v.play !== v.hdplay) qualities.push({ label: '无水印（第三方通道）', url: v.play });
      if (v.wmplay && !qualities.length) qualities.push({ label: '带水印（第三方通道）', url: v.wmplay });
      if (qualities.length) return { platform: 'tiktok', type: 'video', route: '第三方通道 tikwm（兜底）', title: v.title || '', author, cover: v.cover || '', url: qualities[0].url, qualities, note: '本站直连 TikTok 被拦，这条走第三方公开接口兜底，稳定性不受本站控制；直链时效很短，请尽快下载。' };
    }
  } catch { /* ignore */ }
  throw new Error('TikTok 这次没解析出来：它对服务器 IP 拦截很严（已试网页、App 接口、第三方通道三条路线），过会儿再试或换一条链接');
}

/* ---------------- 即梦 / Dreamina ---------------- */
// 2026-11-10 按 zhulin025/video-parser 实测口径重写：主通道 get_item_info（免登录免签名，
// 须带 appid/sign-ver 头 + pack_item_opt 体 + PC UA），候选按 origin→1080→720→480→360→origin_video；
// 兜底 landing_page 改 POST + query_params 全量回传，按 video_id 匹配 cd=0|0|0|3 干净候选。
async function parseJimeng(rawUrl) {
  let url = rawUrl;
  if (!/[?&]id=/.test(url)) { const r = await fetchText(url, { ua: UA_MOBILE }); url = r.finalUrl; }
  const q = new URL(url).searchParams;
  const itemId = q.get('id') || q.get('item_id') || '';
  if (!itemId) throw new Error('没认出即梦分享（落地链接里没有作品 id）');
  const qs = 'uid=0&aid=581595&app_name=dreamina&duanwai_huiliu_page=1';
  const jmH = { 'Content-Type': 'application/json', appid: '581595', 'sign-ver': '1', Referer: 'https://jimeng.jianying.com/' };
  let infoErr = '';
  try {
    const { text } = await fetchText(`https://jimeng.jianying.com/mweb/v1/get_item_info?${qs}`, {
      ua: UA_DESKTOP, method: 'POST', headers: jmH,
      body: JSON.stringify({ published_item_id: itemId, pack_item_opt: { need_follow_info: true } }),
    });
    const d = JSON.parse(text);
    const v = d && d.data && d.data.video;
    const tc = (v && v.transcoded_video) || {};
    const cands = [tc.origin, tc['1080p'], tc['720p'], tc['480p'], tc['360p']].filter(Boolean);
    if (v && v.origin_video && v.origin_video.video_url) cands.push({ video_url: v.origin_video.video_url });
    const hit = cands.find(c => c && c.video_url && !/lr=display_watermark/.test(c.video_url));
    if (hit) {
      const dd = d.data || {};
      return { platform: 'jimeng', type: 'video', route: '作品信息接口', title: dd.title || '', author: '', cover: dd.cover_url || '', url: hit.video_url, qualities: [{ label: '无水印原画', url: hit.video_url }] };
    }
    infoErr = d && (d.ret !== undefined || d.errmsg || d.message) ? String(d.ret !== undefined ? `ret=${d.ret}` : (d.errmsg || d.message)) : '接口没回视频字段';
  } catch { infoErr = '主接口请求失败'; }
  // 兜底：landing_page（POST）
  try {
    const qp = {}; for (const [k, val] of q) qp[k] = val;
    const { text } = await fetchText(`https://jimeng.jianying.com/luckycat/cn/jianying/campaign/v1/dreamina/share/landing_page?${qs}`, {
      ua: UA_DESKTOP, method: 'POST', headers: { ...jmH, Referer: url },
      body: JSON.stringify({ query_params: qp, item_id: itemId }),
    });
    const d = JSON.parse(text);
    const pi = d && d.data && d.data.page_info;
    const metas = [];
    const ci = pi && pi.collection_info;
    if (ci && Array.isArray(ci.collection_list)) for (const c of ci.collection_list) {
      const md = c && c.creation_info && c.creation_info.metadata;
      if (md && md.video_url && (!md.video_id || String(md.video_id) === String(itemId))) metas.push(md);
    }
    if (pi && Array.isArray(pi.creation_list)) for (const c of pi.creation_list) {
      const md = c && c.metadata;
      if (md && md.video_url && (!md.video_id || String(md.video_id) === String(itemId))) metas.push(md);
    }
    const clean = metas.find(m => /cd=0(?:%7C|\|)0(?:%7C|\|)0(?:%7C|\|)3/.test(m.video_url) && !/lr=display_watermark/.test(m.video_url));
    if (clean) return { platform: 'jimeng', type: 'video', route: '落地页接口', title: clean.title || '', author: '', cover: clean.cover_url || '', url: clean.video_url, qualities: [{ label: '无水印', url: clean.video_url }] };
    const oldMeta = pi && pi.creation && pi.creation.metadata;
    const wm = (oldMeta && oldMeta.download_info && oldMeta.download_info.url) || (metas[0] && metas[0].video_url) || '';
    if (wm) return { platform: 'jimeng', type: 'video', route: '落地页接口', title: (oldMeta && oldMeta.title) || '', author: '', cover: (oldMeta && oldMeta.cover_url) || '', url: wm, qualities: [{ label: '带 Logo 水印版（无水印路线这次没取到）', url: wm }], note: '无水印原画这次没取到，先给带水印版兜底；过会儿再试可能恢复。' };
  } catch { /* ignore */ }
  throw new Error(`即梦这次没解析出来（主接口：${infoErr}）。作品须已公开发布；若确认已发布还失败，多半是接口又改版`);
}

/* ---------------- YouTube ---------------- */
function parseYoutube(rawUrl) {
  const m = rawUrl.match(/(?:v=|youtu\.be\/|\/shorts\/|\/live\/)([0-9a-zA-Z_-]{11})/);
  const id = m ? m[1] : '';
  return fail('YouTube 暂不支持直链解析：它对服务器 IP 有机器人墙，还要求浏览器现场生成的令牌，服务器端拿不到直链（手机 App 里的「本机直连解析」是另一回事）。下面给你官方嵌入播放地址，可在线看。', {
    platform: 'youtube', embed: id ? `https://www.youtube.com/embed/${id}` : '', watch: id ? `https://www.youtube.com/watch?v=${id}` : rawUrl,
  });
}

/* ---------------- 通用兜底：OpenGraph ---------------- */
async function parseGeneric(rawUrl) {
  const { text: html, finalUrl } = await fetchText(rawUrl, { ua: UA_DESKTOP });
  const og = (prop) => { const mm = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i')); return mm ? mm[1] : ''; };
  const v = og('video:secure_url') || og('video') || og('video:url');
  if (!v) throw new Error('这个平台还没接入，且页面里也没找到公开视频地址');
  return { platform: 'generic', platformName: '通用提取', type: 'video', route: 'OpenGraph', title: og('title') || '', author: '', cover: og('image') || '', url: v.replace(/&amp;/g, '&'), qualities: [{ label: '页面公开地址', url: v.replace(/&amp;/g, '&') }], from: finalUrl };
}

/* ---------------- 入口 ---------------- */
const ADAPTERS = { douyin: parseDouyin, kuaishou: parseKuaishou, weibo: parseWeibo, xiaohongshu: parseXiaohongshu, acfun: parseAcfun, bilibili: parseBilibili, tiktok: parseTiktok, jimeng: parseJimeng };

export async function handleVideo(body) {
  const url = extractUrl(body.text || body.url || '');
  if (!url) return fail('没找到链接：把整段分享文案粘进来即可，会自动认链接');
  const platform = detectPlatform(url);
  if (platform === 'youtube') return parseYoutube(url);
  try {
    if (platform && ADAPTERS[platform]) {
      const r = await ADAPTERS[platform](url);
      return json({ ok: true, ...r, platformName: (PLATFORMS[platform] || {}).name || platform, tier: (PLATFORMS[platform] || {}).tier });
    }
    const r = await parseGeneric(url);
    return json({ ok: true, ...r });
  } catch (e) {
    return fail(String((e && e.message) || e), platform ? { platform, platformName: (PLATFORMS[platform] || {}).name } : {});
  }
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'GET') {
    return json({ ok: true, service: 'ym-pan video api', platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, { name: v.name, tier: v.tier }])) });
  }
  if (request.method !== 'POST') return fail('只支持 POST', {});
  let body = {};
  try { body = await request.json(); } catch { return fail('请求体不是 JSON'); }
  return handleVideo(body);
}
