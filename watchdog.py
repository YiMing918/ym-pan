#!/usr/bin/env python3
"""ym-pan 看门狗（跑在 GitHub Actions 里，不依赖任何外部服务/账号）：
每天巡检线上站点与各家接口；能机械修的自己修（只改 parse.js 里 CONFIG 区的
蓝奏镜像域名顺序/存废、123 路线顺序），改完触发部署工作流上线；
其余异常在仓库开/更新一个 watchdog 标签的 Issue 留痕。全好则关掉旧 Issue。
站点地址：优先读 Secrets 里的 SITE_URL，没配就用 https://<仓库名>.pages.dev。
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error

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
    st, txt = http(BASE + '/api/parse?action=health')
    try:
        health = json.loads(txt).get('health', [])
        down = [h['name'] for h in health if not h.get('reachable')]
        if down:
            problems.append('接口不通：' + '、'.join(down))
    except Exception:
        problems.append(f'健康检查接口异常：HTTP {st}')


def probe_structure():
    cases = [
        ('baidu', {'drive': 'baidu', 'action': 'list', 'url': 'https://pan.baidu.com/s/1AbCdEf', 'cred': {}}, 'BDUSS'),
        ('quark', {'drive': 'quark', 'action': 'list', 'url': 'https://pan.quark.cn/s/abc123', 'cred': {}}, 'Cookie'),
        ('guangya', {'drive': 'guangya', 'action': 'list', 'url': 'https://www.guangyapan.com/s/abc_def', 'cred': {}}, '筹备中'),
        ('pan123', {'drive': 'pan123', 'action': 'list', 'url': 'https://www.123pan.com/s/AbC-123', 'cred': {}}, None),
        ('lanzou', {'drive': 'lanzou', 'action': 'list', 'url': 'https://www.lanzoui.com/iAbCdEf', 'cred': {}}, None),
    ]
    for name, payload, expect in cases:
        st, txt = http(BASE + '/api/parse', method='POST', data=payload)
        try:
            d = json.loads(txt)
            err = d.get('error', '')
            if st != 200 or d.get('ok') is not False:
                problems.append(f'结构探针 {name} 异常：HTTP {st}，返回 {txt[:120]}')
            elif expect and expect not in err:
                problems.append(f'结构探针 {name} 报错形状变了：{err[:120]}')
        except Exception:
            problems.append(f'结构探针 {name} 返回非 JSON：HTTP {st} {txt[:80]}')


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


def main():
    probe_site()
    probe_structure()
    mechanical_fixes()
    if fixes:
        commit_and_deploy()
    report_issue()
    print(json.dumps({'problems': problems, 'fixes': fixes, 'notes': notes}, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
