#!/usr/bin/env python3
"""Task 28-a (rerun): full 15-rule audit through fresh engine /api/test on :3131.
list -> book -> chapter per rule; prints per-field completeness + noise suspects."""
import json, sys, time, urllib.request

SEED = '/home/z/my-project/mini-services/backend-go/seed/seed.json'
PORT = 3131

# per-rule list page target (post-calibration)
LIST_URL = {
    10: 'https://www.aijjxs.com/',
    11: 'https://www.ddyueshu.cc/',
    12: 'https://www.23qb.net/book/lastupdate_0_0_0_0_0_0_0_1_0.html',
    13: 'https://www.huangjinwu.org/',
    14: 'https://www.ggd66.com/sort/',
    15: 'https://www.xinjianpan.com/rank/lastupdate/?page=1',
    16: 'https://101kks.com/novels/class/0_1.html',
    17: 'http://www.x2552.com/',
    18: 'http://www.trxsw.com/lastupdate/',
    19: 'https://www.pilishuwu.com/',
    20: 'http://www.77shuku.info/',
    21: 'https://5165.org/',
    22: 'http://www.23uswx.la/',
    23: 'https://38.34.172.127/',
    24: 'https://ixdzs8.com/new/?page=1',
}

def load_rules():
    return {r['id']: r for r in json.load(open(SEED))['rules']}

def engine_test(url, rule, mode, timeout=90):
    body = {'url': url}
    r = {}
    if mode == 'list':
        r['listRule'] = json.loads(rule['listRule'])
    elif mode == 'book':
        r['bookRule'] = json.loads(rule['bookRule'])
    elif mode == 'chapter':
        r['chapterRule'] = json.loads(rule['chapterRule'])
    body['rule'] = r
    if rule.get('charset'):
        body['charset'] = rule['charset']
    if rule.get('proxy'):
        body['proxy'] = rule['proxy']
    if rule.get('insecureTLS'):
        body['insecureTLS'] = True
    req = urllib.request.Request(f'http://localhost:{PORT}/api/test',
                                 data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except Exception as e:
        return {'ok': False, 'error': str(e)}

NOISE_MARKS = ('www.', 'http', '.com', '.net', '.cc', '点击', '广告', '更多', '最新章节',
               '搜索', '章节目录', '上一页', '下一页', '小说', '笔趣阁', '记住', '收藏')

def noise_suspect(lines):
    out = []
    for l in lines:
        t = l.strip()
        if not t or len(t) > 30:
            continue
        for m in NOISE_MARKS:
            if m in t:
                out.append(t[:40])
                break
    return out

def audit(rules, ids):
    for rid in ids:
        r = rules[rid]
        print(f'\n===== RULE {rid} {r["name"]} enabled={r.get("enabled")} charset={r.get("charset") or "-"} proxy={bool(r.get("proxy"))}', flush=True)
        cs = r.get('charset') or None
        d = engine_test(LIST_URL[rid], r, 'list')
        lst = (d.get('data') or {}).get('list') or {}
        items = lst.get('items') or []
        print(f'  LIST ok={d.get("ok")} strat={d.get("strategy")} status={d.get("status")} enc={d.get("encoding")} n={lst.get("count")} sel={lst.get("itemSelector")}', flush=True)
        if not d.get('ok'):
            print(f'  LIST-ERR: {str(d.get("error"))[:90]} | {str(d.get("detail"))[:160]}', flush=True)
            continue
        if d.get('warnings'):
            print('  WARN:', [w[:100] for w in d.get('warnings', [])][:4], flush=True)
        if items:
            print('  item0:', {k: str(items[0].get(k))[:55] for k in ('title', 'author', 'category', 'url')}, flush=True)
        if not items:
            continue
        burl = items[0].get('url') or ''
        time.sleep(2.2)
        d2 = engine_test(burl, r, 'book')
        b = (d2.get('data') or {}).get('book') or {}
        if not d2.get('ok'):
            print(f'  BOOK-ERR: {str(d2.get("error"))[:90]} | {str(d2.get("detail"))[:150]}', flush=True)
            continue
        complete = {k: bool(b.get(k)) for k in ('title', 'author', 'description', 'cover', 'status', 'category')}
        complete['chapters'] = (b.get('chapterCount') or 0) > 0
        print(f'  BOOK strat={d2.get("strategy")} enc={d2.get("encoding")} fields={complete}', flush=True)
        print('  meta:', {k: (str(b.get(k))[:65] if b.get(k) else b.get(k)) for k in ('title', 'author', 'status', 'category', 'cover', 'catalogUrl')}, flush=True)
        desc = b.get('description') or ''
        print(f'  desc[{len(desc)}]:', desc[:120].replace('\n', ' '), flush=True)
        if d2.get('warnings'):
            print('  WARN:', [w[:100] for w in d2.get('warnings', [])][:4], flush=True)
        chs = b.get('chapters') or []
        if chs:
            print(f'  chapters: n={len(chs)} ch0={chs[0].get("title")}', flush=True)
            idxs = [1, min(5, len(chs) - 1), len(chs) - 1]
            seen = set()
            for i in idxs:
                if i in seen:
                    continue
                seen.add(i)
                curl = chs[i].get('url') or ''
                if not curl:
                    continue
                time.sleep(2.2)
                d3 = engine_test(curl, r, 'chapter')
                if not d3.get('ok'):
                    print(f'  CH[{i}]-ERR: {str(d3.get("error"))[:80]} | {str(d3.get("detail"))[:120]}', flush=True)
                    continue
                c = (d3.get('data') or {}).get('chapter') or {}
                lines = (c.get('content') or '').split('\n')
                print(f'  CH[{i}] strat={d3.get("strategy")} wc={c.get("wordCount")} lines={len(lines)} next={"Y" if c.get("nextUrl") else "N"} title={c.get("title")}', flush=True)
                print('   first2:', [l[:42] for l in lines[:2]], flush=True)
                print('   last2:', [l[:42] for l in lines[-2:]], flush=True)
                susp = noise_suspect(lines)
                if susp:
                    print('   SUSPECT-NOISE:', susp[:6], flush=True)
        else:
            print('  chapters: NONE', flush=True)

if __name__ == '__main__':
    rules = load_rules()
    ids = [int(x) for x in sys.argv[1].split(',')]
    audit(rules, ids)
    print('\nAUDIT-DONE', flush=True)
