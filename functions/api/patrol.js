// 巡检专用接口（真解析自检）：只有带正确 x-patrol-key 的请求能调用。
// 用 KV 里部署者自己的夸克 Cookie，对固定测试分享做一次真解析（列目录 + 对第一个文件取直链），
// 并把轮换后的新 Cookie 写回 KV。普通访客解析永远不会用到这个 Cookie。
// POST /api/patrol  header: x-patrol-key: <PATROL_KEY>  body: { drive:'quark', url, pwd }
//
// 2026-11-10 与 parse.js 夸克适配器口径对齐（此前巡检是独立老实现，测的根本不是正式解析路径）：
// ① __dt/__t 每次请求新鲜生成；② 取链顺序 = 游客免转存 → 登录直取 → 转存；
// ③ 转存必须轮询任务到 status==2 才取新 fid；④ 转存件取链 body 只有 {fids}。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

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
  str() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function quarkPatrol(kv, url, pwd) {
  const cookie0 = await kv.get('quark_cookie');
  if (!cookie0) return { ok: false, stage: 'cred', error: 'KV 里还没有巡检 Cookie，请先在页面扫码绑定' };
  const m = String(url).match(/\/s\/([A-Za-z0-9]+)/);
  if (!m) return { ok: false, stage: 'input', error: '测试分享链接格式不对' };
  const pwdId = m[1];
  const base = 'https://drive-pc.quark.cn/1/clouddrive';
  const qNow = () => `pr=ucpro&fr=pc&uc_param_str=&__dt=${600 + Math.floor(Math.random() * 9000)}&__t=${Date.now()}`;
  const jar = new Jar(cookie0);
  const H = { 'Content-Type': 'application/json', Referer: 'https://pan.quark.cn/' };
  let stage = 'token';
  try {
    const t = await fetch(`${base}/share/sharepage/token?${qNow()}`, {
      method: 'POST', headers: { ...H, Cookie: jar.str() }, body: JSON.stringify({ pwd_id: pwdId, passcode: pwd || '' }),
    });
    jar.absorb(t);
    const td = await t.json().catch(() => null);
    if (!td || td.status !== 200 || !td.data || !td.data.stoken) {
      return { ok: false, stage, error: `拿不到 stoken（status=${td && td.status} code=${td && td.code}）：Cookie 可能已失效或口径变了` };
    }
    const stoken = td.data.stoken;
    stage = 'list';
    const d = await fetch(`${base}/share/sharepage/detail?${qNow()}&pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=0&force=0&_page=1&_size=100&_sort=file_type:asc,file_name:asc`, {
      headers: { Referer: 'https://pan.quark.cn/', Cookie: jar.str() },
    });
    jar.absorb(d);
    const dd = await d.json().catch(() => null);
    if (!dd || dd.status !== 200 || !dd.data || !Array.isArray(dd.data.list)) {
      return { ok: false, stage, error: `列目录失败（status=${dd && dd.status} code=${dd && dd.code}）` };
    }
    const files = dd.data.list.filter(f => !f.dir);
    if (!files.length) return { ok: false, stage, error: '测试分享里没有文件（只有文件夹或为空），请换一个含小文件的测试分享' };
    stage = 'download';
    const f0 = files[0];
    const dlDiag = [];
    // file/download 必须带官方 PC 客户端 UA（LinkSwift/kownload 同口径）：网页 UA 会被当游客档限大文件（23018）
    const DL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch';
    const dlCall = async (withCookie, body, tag) => {
      const r = await fetch(`${base}/file/download?${qNow()}`, {
        method: 'POST', headers: { ...(withCookie ? { ...H, Cookie: jar.str() } : { ...H }), 'User-Agent': DL_UA },
        body: JSON.stringify(body),
      });
      if (withCookie) jar.absorb(r);
      const d = await r.json().catch(() => null);
      const u = d && d.data && d.data[0] && d.data[0].download_url;
      if (!u) dlDiag.push(`${tag}: status=${d && d.status} code=${d && d.code} msg=${(d && (d.message || d.msg) || '').slice(0, 60)}`);
      return u || null;
    };
    let link = null;
    let route = '';
    // 路线 A：游客免转存（不带 Cookie，body 带 pwd_id/stoken）
    link = await dlCall(false, { fids: [f0.fid], fids_token: f0.share_fid_token ? [f0.share_fid_token] : [], pwd_id: pwdId, stoken }, 'guest');
    if (link) route = 'guest';
    // 路线 B：登录直取
    if (!link) {
      link = await dlCall(true, { fids: [f0.fid], fids_token: f0.share_fid_token ? [f0.share_fid_token] : [], pwd_id: pwdId, stoken }, 'direct');
      if (link) route = 'direct';
    }
    if (!link) {
      // 路线 C：转存到自己盘根目录 → 轮询任务到 status==2 → 用新 fid 取链（body 只有 fids）
      stage = 'save';
      const sv = await fetch(`${base}/share/sharepage/save?${qNow()}`, {
        method: 'POST', headers: { ...H, Cookie: jar.str() },
        body: JSON.stringify({ fid_list: [f0.fid], fid_token_list: f0.share_fid_token ? [f0.share_fid_token] : [], to_pdir_fid: '0', pwd_id: pwdId, stoken, pdir_fid: '0', scene: 'link' }),
      });
      jar.absorb(sv);
      const svd = await sv.json().catch(() => null);
      const taskId = svd && svd.data && svd.data.task_id;
      if (!taskId) return { ok: false, stage, error: `直取被拒且转存也失败（status=${svd && svd.status} code=${svd && svd.code}）` };
      let savedFid = '';
      for (let i = 0; i < 15 && !savedFid; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const t = await fetch(`${base}/task?${qNow()}&task_id=${taskId}&retry_index=${i}`, { headers: { Referer: 'https://pan.quark.cn/', Cookie: jar.str() } });
        jar.absorb(t);
        const td2 = await t.json().catch(() => null);
        const data = td2 && td2.data;
        if (!data) continue;
        if (data.status === 3) return { ok: false, stage, error: '转存任务失败（status=3，多为空间不足或文件违规）' };
        if (data.status === 2 && data.save_as && data.save_as.save_as_top_fids && data.save_as.save_as_top_fids[0]) {
          savedFid = data.save_as.save_as_top_fids[0];
        }
      }
      if (!savedFid) return { ok: false, stage, error: '转存超时（15 次轮询没等到任务完成）' };
      stage = 'download';
      link = await dlCall(true, { fids: [savedFid] }, 'saved');
      if (!link) return { ok: false, stage, error: `转存成功但取直链仍失败（文件 ${f0.file_name}，${f0.size || 0} 字节；诊断 ${dlDiag.join(' | ')}）` };
      route = 'save';
      // 尽力清理转存件（失败不算巡检失败，正式解析的转存件本来也会留在用户根目录）
      try {
        await fetch(`${base}/file/delete?${qNow()}`, {
          method: 'POST', headers: { ...H, Cookie: jar.str() },
          body: JSON.stringify({ action_type: 1, filelist: [savedFid], exclude_fids: [] }),
        });
      } catch { /* ignore */ }
    }
    // 拿到直链后再验一步：带会话 Cookie 真拉一小段字节，确认链能下而不只是被签发
    // 探针请求头须与正式取链/给下载器的请求头一致：夸克按 UA 档位限流，通用浏览器 UA 会被
    // 下载域名 412（2026-11-11 巡检：取链正常、route=guest，但探针连得 522/412）。
    let linkProbe = 'error';
    try {
      const pr = await fetch(link, { headers: { Range: 'bytes=0-1023', Cookie: jar.str(), 'User-Agent': DL_UA, Referer: 'https://pan.quark.cn/' } });
      linkProbe = String(pr.status);
      if ([403, 404, 410].includes(pr.status)) {
        return { ok: false, stage: 'linkprobe', error: `直链已签发但拉字节被拒（HTTP ${pr.status}），链不可用` };
      }
    } catch { /* 网络层异常无法区分，不判死 */ }
    // 回写轮换后的 Cookie
    const fresh = jar.str();
    if (fresh && fresh !== cookie0) await kv.put('quark_cookie', fresh);
    return { ok: true, stage: 'done', route, linkProbe, files: dd.data.list.length, firstFile: f0.file_name, linkHost: new URL(link).host };
  } catch (e) {
    return { ok: false, stage, error: `请求异常：${e.message}` };
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ ok: false, error: '只支持 POST' }, 405);
  if (!env.PAN_KV || !env.PATROL_KEY) return json({ ok: false, error: '巡检未启用（缺 KV 绑定或 PATROL_KEY）' });
  if (request.headers.get('x-patrol-key') !== env.PATROL_KEY) return json({ ok: false, error: '巡检口令不对' }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: '请求体不是 JSON' }); }
  if (body.drive !== 'quark') return json({ ok: false, error: '巡检目前只支持 quark（真解析自检）' });
  const res = await quarkPatrol(env.PAN_KV, body.url || '', body.pwd || '');
  return json({ service: 'ym-pan patrol', at: new Date().toISOString(), ...res });
}
