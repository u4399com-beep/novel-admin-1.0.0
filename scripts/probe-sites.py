#!/usr/bin/env python3
"""R26 恢复轮：全站连通性快探（引擎 fetch-curl 单策略，短超时并行）"""
import json, urllib.request, concurrent.futures

SITES = [
    ("aijjxs",     "https://www.aijjxs.com/"),
    ("ddyueshu",   "https://www.ddyueshu.cc/"),
    ("23qb",       "https://www.23qb.net/book/lastupdate_0_0_0_0_0_0_0_1_0.html"),
    ("huangjinwu", "https://www.huangjinwu.org/"),
    ("ggd66",      "https://www.ggd66.com/sort/1/"),
    ("xinjianpan", "https://www.xinjianpan.com/rank/lastupdate/?page=1"),
    ("101kks",     "https://101kks.com/novels/class/0_1.html"),
    ("x2552",      "http://www.x2552.com/"),
    ("trxsw",      "http://www.trxsw.com/lastupdate/"),
    ("77shuku",    "http://www.77shuku.info/"),
    ("5165",       "https://5165.org/"),
    ("23uswx",     "http://www.23uswx.la/"),
    ("yebanshu",   "https://38.34.172.127/index.html"),
    ("ixdzs8",     "https://ixdzs8.com/new/"),
]

def probe(item):
    name, url = item
    body = json.dumps({"url": url, "strategy": "fetch-curl", "timeoutMs": 15000}).encode()
    req = urllib.request.Request("http://127.0.0.1:3030/api/test", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.loads(r.read())
        att = d.get("attempts") or []
        ok = att[0].get("ok") if att else d.get("ok")
        note = att[0].get("note","") if att else ""
        status = att[0].get("status") if att else ""
        title = (d.get("title") or "")[:30]
        return name, ok, status, note, title
    except Exception as e:
        return name, "ERR", "", str(e)[:60], ""

with concurrent.futures.ThreadPoolExecutor(8) as ex:
    for name, ok, status, note, title in ex.map(probe, SITES):
        print(f"{name:12s} ok={ok} status={status} {note[:40]} {title}")
