// 巡检专用接口（真解析自检）：只有带正确 x-patrol-key 的请求能调用。
// 用 KV 里部署者自己的夸克 Cookie，对固定测试分享做一次真解析（列目录 + 对第一个文件取直链），
// 并把轮换后的新 Cookie 写回 KV。普通访客解析永远不会用到这个 Cookie。
// POST /api/patrol  header: x-patrol-key: <PATROL_KEY>  body: { drive:'quark', url, pwd }

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
  const q = `pr=ucpro&fr=pc&uc_param_str=&__dt=0&__t=${Date.now()}`;
  const jar = new Jar(cookie0);
  const H = { 'Content-Type': 'application/json', Referer: 'https://pan.quark.cn/' };
  let stage = 'token';
  try {
    const t = await fetch(`${base}/share/sharepage/token?${q}`, {
      method: 'POST', headers: { ...H, Cookie: jar.str() }, body: JSON.stringify({ pwd_id: pwdId, passcode: pwd || '' }),
    });
    jar.absorb(t);
    const td = await t.json().catch(() => null);
    if (!td || td.status !== 200 || !td.data || !td.data.stoken) {
      return { ok: false, stage, error: `拿不到 stoken（status=${td && td.status} code=${td && td.code}）：Cookie 可能已失效或口径变了` };
    }
    const stoken = td.data.stoken;
    stage = 'list';
    const d = await fetch(`${base}/share/sharepage/detail?${q}&pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=0&force=0&_page=1&_size=100&_sort=file_type:asc,file_name:asc`, {
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
    const dlOnce = async (fid, fidToken) => {
      const r = await fetch(`${base}/file/download?${q}`, {
        method: 'POST', headers: { ...H, Cookie: jar.str() },
        body: JSON.stringify({ fids: [fid], fids_token: fidToken ? [fidToken] : [] }),
      });
      jar.absorb(r);
      const d = await r.json().catch(() => null);
      return d && d.data && d.data[0] && d.data[0].download_url ? d.data[0].download_url : null;
    };
    let link = await dlOnce(f0.fid, f0.share_fid_token);
    let route = 'direct';
    if (!link) {
      // 直取被拒 → 与正式解析同一条转存路线（存到自己盘根目录 → 取链 → 尝试删掉转存件）
      stage = 'save';
      const sv = await fetch(`${base}/share/sharepage/save?${q}`, {
        method: 'POST', headers: { ...H, Cookie: jar.str() },
        body: JSON.stringify({ fid_list: [f0.fid], fid_token_list: f0.share_fid_token ? [f0.share_fid_token] : [], to_pdir_fid: '0', pwd_id: pwdId, stoken, pdir_fid: '0', scene: 'link' }),
      });
      jar.absorb(sv);
      const svd = await sv.json().catch(() => null);
      const taskId = svd && svd.data && svd.data.task_id;
      if (!taskId) return { ok: false, stage, error: `直取被拒且转存也失败（status=${svd && svd.status} code=${svd && svd.code}）` };
      let savedFid = '';
      for (let i = 0; i < 10 && !savedFid; i++) {
        await new Promise(r => setTimeout(r, 900));
        const t = await fetch(`${base}/task?${q}&task_id=${taskId}&retry_index=${i}`, { headers: { Referer: 'https://pan.quark.cn/', Cookie: jar.str() } });
        jar.absorb(t);
        const td2 = await t.json().catch(() => null);
        const top = td2 && td2.data && td2.data.save_as && td2.data.save_as.save_as_top_fids;
        if (top && top[0]) savedFid = top[0];
      }
      if (!savedFid) return { ok: false, stage, error: '转存超时（10 次轮询没拿到落盘文件）' };
      stage = 'download';
      link = await dlOnce(savedFid, '');
      if (!link) return { ok: false, stage, error: '转存成功但取直链仍失败' };
      route = 'save';
      // 尽力清理转存件（失败不算巡检失败，正式解析的转存件本来也会留在用户根目录）
      try {
        await fetch(`${base}/file/delete?${q}`, {
          method: 'POST', headers: { ...H, Cookie: jar.str() },
          body: JSON.stringify({ action_type: 1, filelist: [savedFid], exclude_fids: [] }),
        });
      } catch { /* ignore */ }
    }
    // 拿到直链后再验一步：带会话 Cookie 真拉一小段字节，确认链能下而不只是被签发
    let linkProbe = 'error';
    try {
      const pr = await fetch(link, { headers: { Range: 'bytes=0-1023', Cookie: jar.str(), 'User-Agent': UA } });
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
