#!/usr/bin/env python3
"""ym-pan 看门狗（跑在 GitHub Actions 里，不依赖任何外部服务/账号）：
每天巡检线上站点与各家接口；能机械修的自己修（只改 parse.js 里 CONFIG 区的
蓝奏镜像域名顺序/存废、123 路线顺序），改完触发部署工作流上线；
其余异常在仓库开/更新一个 watchdog 标签的 Issue 留痕。全好则关掉旧 Issue。
站点地址：优先读 Secrets 里的 SITE_URL，没配就用 https://<仓库名>.pages.dev。
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
import urllib.parse

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'}
PARSE_JS = 'functions/api/parse.js'

repo_full = os.environ.get('GITHUB_REPOSITORY', '')  # owner/repo
repo_name = repo_full.split('/')[-1] if '/' in repo_full else 'ym-pan'
BASE = (os.environ.get('SITE_URL') or f'https://{repo_name}.pages.dev').rstrip('/')

problems = []   # 需要留痕的异常
fixes = []      # 已自动修复的项
notes = []      # 一般信息


def http(url, method='GET', data=None, timeout=20):
    body = None
    headers = dict(UA)
    if data is not None:
        body = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')
    except Exception as e:
        return 0, f'ERR:{type(e).__name__}:{e}'


def strict_dead(url):
    """连接级失败（DNS/拒连/超时/5xx）才算死；拿到任何正常 HTTP 响应算活。"""
    st, txt = http(url, timeout=12)
    if st == 0 or st >= 500:
        return True, f'status={st} {txt[:80]}'
    return False, f'status={st}'


def probe_site():
    st, html = http(BASE + '/')
    if st != 200 or 'YM 网盘解析' not in html:
        problems.append(f'站点首页异常：HTTP {st}')
    st, txt = http(BASE + '/api/parse?action=health', timeout=60)
    try:
        health = json.loads(txt).get('health', [])
        down = [h['name'] for h in health if not h.get('reachable')]
        if down:
            problems.append('接口不通：' + '、'.join(down))
    except Exception:
        problems.append(f'健康检查接口异常：HTTP {st}')


def probe_structure():
    # expect 为「可接受报错子串」列表，任一命中即视为口径正常（假分享会穿过识别层直达上游，
    # 上游的结构化报错同样是健康形状；2026-11-07 首跑实测后按线上真实报错校准）。
    cases = [
        ('baidu', {'drive': 'baidu', 'action': 'list', 'url': 'https://pan.baidu.com/s/1AbCdEf', 'cred': {}}, ['BDUSS']),
        ('quark', {'drive': 'quark', 'action': 'list', 'url': 'https://pan.quark.cn/s/abc123', 'cred': {}}, ['Cookie']),
        ('guangya', {'drive': 'guangya', 'action': 'list', 'url': 'https://www.guangyapan.com/s/abc_def', 'cred': {}}, ['筹备中']),
        ('pan123', {'drive': 'pan123', 'action': 'list', 'url': 'https://www.123pan.com/s/AbC-123', 'cred': {}}, ['列目录失败', '没认出']),
        ('lanzou', {'drive': 'lanzou', 'action': 'list', 'url': 'https://www.lanzoui.com/iAbCdEf', 'cred': {}}, None),
        ('aliyun', {'drive': 'aliyun', 'action': 'list', 'url': 'https://www.alipan.com/s/abcdef', 'cred': {}}, ['获取分享令牌失败', '没认出阿里云盘分享链接']),
        ('uc', {'drive': 'uc', 'action': 'list', 'url': 'https://drive.uc.cn/s/abcdef', 'cred': {}}, ['Cookie']),
        ('cmcc', {'drive': 'cmcc', 'action': 'list', 'url': 'https://yun.139.com/shareweb/#/w/i/abcdef', 'cred': {}}, ['列目录失败', '没认出移动云盘分享']),
        ('ctyun', {'drive': 'ctyun', 'action': 'list', 'url': 'https://cloud.189.cn/t/abcdef', 'cred': {}}, ['列目录失败', '没认出天翼分享链接']),
        ('feijipan', {'drive': 'feijipan', 'action': 'list', 'url': 'https://share.feijipan.com/s/abcdef', 'cred': {}}, ['列目录失败', '没认出小飞机']),
        ('xunlei', {'drive': 'xunlei', 'action': 'list', 'url': 'https://pan.xunlei.com/s/abcdef', 'cred': {}}, ['验证码令牌', '没认出迅雷分享链接']),
    ]
    for name, payload, expects in cases:
        st, txt = http(BASE + '/api/parse', method='POST', data=payload, timeout=60)
        try:
            d = json.loads(txt)
            err = d.get('error', '')
            if st != 200 or d.get('ok') is not False:
                problems.append(f'结构探针 {name} 异常：HTTP {st}，返回 {txt[:120]}')
            elif expects and not any(x in err for x in expects):
                problems.append(f'结构探针 {name} 报错形状变了：{err[:120]}')
        except Exception:
            problems.append(f'结构探针 {name} 返回非 JSON：HTTP {st} {txt[:80]}')


def probe_video():
    cases = [
        ('douyin', 'https://www.douyin.com/video/1000000000000000000', ['抖音']),
        ('kuaishou', 'https://www.kuaishou.com/short-video/watchdogprobe', ['快手']),
        ('weibo', 'https://weibo.com/1234567890/AbCdEfGh', ['微博', '视频']),
        ('xiaohongshu', 'https://www.xiaohongshu.com/explore/000000000000000000000000', ['小红书']),
        ('acfun', 'https://www.acfun.cn/v/ac999999999', ['AcFun']),
        ('bilibili', 'https://b23.tv/watchdogprobe', ['B 站']),
        ('youtube', 'https://youtu.be/dQw4w9WgXcQ', ['YouTube']),
        ('tiktok', 'https://www.tiktok.com/@x/video/1000000000000000000', None),
        ('jimeng', 'https://jimeng.jianying.com/s/watchdogprobe', None),
    ]
    for name, link, expects in cases:
        st, txt = http(BASE + '/api/video', method='POST', data={'text': link}, timeout=90)
        try:
            d = json.loads(txt)
            err = d.get('error', '')
            if st != 200 or d.get('ok') is not False:
                problems.append(f'视频探针 {name} 异常：HTTP {st}，返回 {txt[:120]}')
            elif expects and not any(x in err for x in expects):
                problems.append(f'视频探针 {name} 报错形状变了：{err[:120]}')
        except Exception:
            problems.append(f'视频探针 {name} 返回非 JSON：HTTP {st} {txt[:80]}')


# ============ 直链可用性探针（站长要求：链签发出来 ≠ 能下载，必须真拉字节） ============
UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'

def fetch_status(url, headers=None, want_text=False):
    """拉一小段字节，返回 (status, content_type, body_bytes_or_text)。"""
    import urllib.error
    h = {'User-Agent': UA_M, 'Range': 'bytes=0-1023'}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            body = r.read(4096)
            return r.status, (r.headers.get('Content-Type') or ''), (body.decode('utf-8', 'ignore') if want_text else body)
    except urllib.error.HTTPError as e:
        return e.code, ((e.headers.get('Content-Type') if e.headers else '') or ''), ('' if want_text else b'')
    except Exception:
        return 0, '', ('' if want_text else b'')


def probe_usability():
    # 无凭证可完整验的链路：视频 4 家（解析→拉字节）+ 阿里列目录链（取链需凭证，验到列表层）
    video_samples = [
        ('抖音', 'https://v.douyin.com/N02ol18iCT0/'),
        ('快手', 'https://v.kuaishou.com/5fkjkb'),
        ('微博', 'https://weibo.com/1642591402/J19gv3CXz'),
        ('AcFun', 'https://www.acfun.cn/v/ac48954407'),
    ]
    for name, link in video_samples:
        st, txt = http(BASE + '/api/video', method='POST', data={'text': link}, timeout=90)
        try:
            d = json.loads(txt)
        except Exception:
            problems.append(f'直链可用性 {name}：解析接口返回非 JSON HTTP {st}')
            continue
        if not d.get('ok'):
            problems.append(f'直链可用性 {name}：样本解析失败（样本可能已失效或口径变了）：{str(d.get("error"))[:100]}')
            continue
        headers = {'Referer': d['needReferer']} if d.get('needReferer') else None
        u = d.get('url') or ''
        if d.get('type') == 'hls' or '.m3u8' in u:
            s2, _ct, manifest = fetch_status(u, headers, want_text=True)
            segs = [ln.strip() for ln in str(manifest).splitlines() if ln.strip() and not ln.startswith('#')]
            if s2 != 200 or '#EXTM3U' not in str(manifest) or not segs:
                problems.append(f'直链可用性 {name}：m3u8 清单拉不到或无分片 HTTP {s2}')
                continue
            seg = segs[0] if segs[0].startswith('http') else urllib.parse.urljoin(u, segs[0])
            s3, ct3, _b = fetch_status(seg, headers)
            if s3 not in (200, 206):
                problems.append(f'直链可用性 {name}：清单可达但分片拉不动 HTTP {s3}（链不可用）')
        else:
            s2, ct2, _b = fetch_status(u, headers)
            if s2 not in (200, 206) or 'text/html' in ct2:
                problems.append(f'直链可用性 {name}：链已签发但拉字节失败 HTTP {s2} {ct2}（链不可用，检查是否缺 Referer 等请求头标注）')
    # 阿里：匿名 token→列目录链（取直链需访客自己的 Authorization，自动监测到列表层为止）
    st, txt = http(BASE + '/api/parse', method='POST',
                   data={'drive': 'aliyun', 'action': 'list', 'url': 'https://www.alipan.com/s/KsbSSdhkSvN', 'cred': {}}, timeout=60)
    try:
        d = json.loads(txt)
        if not d.get('ok') or not d.get('files'):
            problems.append(f'直链可用性 阿里：样本分享列目录失败（样本可能被取消或口径变了）：{str(d.get("error"))[:100]}')
    except Exception:
        problems.append(f'直链可用性 阿里：列目录返回非 JSON HTTP {st}')


def read_config(src):
    m = re.search(r'CONFIG:BEGIN.*?CONFIG:END', src, re.S)
    if not m:
        return None, None, None
    block = m.group(0)
    def lst(key):
        mm = re.search(key + r':\s*\[([^\]]*)\]', block)
        return re.findall(r"'([^']+)'", mm.group(1)) if mm else []
    return lst('lanzouMirrors'), lst('pan123Bases'), m


def write_config(src, span, mirrors, bases):
    block = span.group(0)
    block = re.sub(r"lanzouMirrors:\s*\[[^\]]*\]",
                   'lanzouMirrors: [' + ', '.join(f"'{x}'" for x in mirrors) + ']', block)
    block = re.sub(r"pan123Bases:\s*\[[^\]]*\]",
                   'pan123Bases: [' + ', '.join(f"'{x}'" for x in bases) + ']', block)
    return src[:span.start()] + block + src[span.end():]


def mechanical_fixes():
    try:
        with open(PARSE_JS, encoding='utf-8') as f:
            src = f.read()
    except Exception as e:
        problems.append(f'看门狗读不到 {PARSE_JS}：{e}')
        return
    mirrors, bases, span = read_config(src)
    if span is None:
        problems.append('parse.js 里找不到 CONFIG 区，看门狗无法自动维护')
        return
    new_mirrors, new_bases = list(mirrors), list(bases)
    # 蓝奏镜像：活的排前，连接级死的摘掉（至少保留 2 个）
    alive, dead = [], []
    for d in mirrors:
        is_dead, why = strict_dead(f'https://www.{d}/')
        (dead if is_dead else alive).append(d)
        if is_dead:
            notes.append(f'蓝奏镜像 {d} 疑似失效（{why}）')
    if alive and (alive != mirrors or dead):
        kept = alive + [d for d in dead if len(alive) + dead.index(d) < 2] if len(alive) < 2 else alive
        new_mirrors = kept
        if new_mirrors != mirrors:
            fixes.append(f'蓝奏镜像重排：活 {alive}' + (f'，摘掉 {dead}' if len(alive) >= 2 else ''))
    # 123 路线：第一条连接级死、第二条活 → 交换
    if len(bases) >= 2:
        d0, _ = strict_dead(bases[0] + '/share/list?limit=1&shareKey=x&ParentFileId=0')
        d1, _ = strict_dead(bases[1] + '/share/list?limit=1&shareKey=x&ParentFileId=0')
        if d0 and not d1:
            new_bases = [bases[1], bases[0]] + bases[2:]
            fixes.append('123 路线交换：主接口连接级失败，已把备用接口提为主')
        elif d0 and d1:
            problems.append('123 两条接口路线都连接级失败')
    if new_mirrors != mirrors or new_bases != bases:
        with open(PARSE_JS, 'w', encoding='utf-8') as f:
            f.write(write_config(src, span, new_mirrors, new_bases))


def sh(*args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)


def commit_and_deploy():
    if sh('git', 'diff', '--quiet').returncode == 0:
        return
    sh('git', 'config', 'user.name', 'ym-pan-watchdog')
    sh('git', 'config', 'user.email', 'watchdog@localhost')
    sh('git', 'add', PARSE_JS)
    msg = 'watchdog: ' + '；'.join(fixes) if fixes else 'watchdog: CONFIG 自动维护'
    r = sh('git', 'commit', '-m', msg)
    if r.returncode != 0:
        problems.append('看门狗提交失败：' + r.stderr[:200])
        return
    r = sh('git', 'push')
    if r.returncode != 0:
        problems.append('看门狗推送失败：' + r.stderr[:200])
        return
    # GITHUB_TOKEN 的 push 不会触发其他工作流，用 workflow_dispatch 显式触发部署（该事件不受此限制）
    r = sh('gh', 'workflow', 'run', 'deploy.yml', '--ref', 'main')
    notes.append('已触发部署工作流' if r.returncode == 0 else '触发部署失败：' + r.stderr[:150])


def report_issue():
    body_lines = []
    if fixes:
        body_lines.append('**已自动修复并上线：**')
        body_lines += [f'- {x}' for x in fixes]
    if problems:
        body_lines.append('**待处理异常：**')
        body_lines += [f'- {x}' for x in problems]
    if notes:
        body_lines.append('**备注：**')
        body_lines += [f'- {x}' for x in notes]
    body = '\n'.join(body_lines) or '无异常'
    sh('gh', 'label', 'create', 'watchdog', '--force')
    r = sh('gh', 'issue', 'list', '--label', 'watchdog', '--state', 'open', '--json', 'number', '--jq', '.[0].number')
    open_no = r.stdout.strip()
    abnormal = bool(problems)
    if abnormal or fixes:
        if open_no and open_no != 'null':
            sh('gh', 'issue', 'comment', open_no, '--body', body)
        else:
            sh('gh', 'issue', 'create', '--title', '看门狗巡检报告', '--label', 'watchdog', '--body', body)
    elif open_no and open_no != 'null':
        sh('gh', 'issue', 'comment', open_no, '--body', '本轮巡检全部正常，自动关闭。')
        sh('gh', 'issue', 'close', open_no)


def heartbeat():
    """心跳保活：GitHub 会停掉 60 天无活动的公开仓库的定时任务。若距上次提交超过 25 天且本轮没有修复提交，留一个时间戳提交保持活跃（不触发部署，代码没变）。"""
    try:
        ts = int(sh('git', 'log', '-1', '--format=%ct', capture_output=True, text=True).stdout.strip() or 0)
    except Exception:
        ts = 0
    import time
    if ts and time.time() - ts > 25 * 86400:
        os.makedirs('.watchdog', exist_ok=True)
        with open('.watchdog/last-run.txt', 'w') as f:
            f.write(datetime.date.today().isoformat() + '\n')
        sh('git', 'add', '.watchdog/last-run.txt')
        sh('git', 'commit', '-m', 'watchdog: 心跳保活')
        sh('git', 'push')
        notes.append('已留心跳保活提交')


def main():
    probe_site()
    probe_structure()
    probe_video()
    probe_usability()
    mechanical_fixes()
    if fixes:
        commit_and_deploy()
    else:
        heartbeat()
    report_issue()
    print(json.dumps({'problems': problems, 'fixes': fixes, 'notes': notes}, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
