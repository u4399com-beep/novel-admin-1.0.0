#!/usr/bin/env python3
"""R26 恢复轮：重建采集舰队（13 list 任务，覆盖 13 个可用规则）"""
import json, urllib.request, urllib.error

FLEET = [
    # (ruleId, name, targetUrl, pages)
    (10, "aijjxs",     "https://www.aijjxs.com/", 2),
    (11, "ddyueshu",   "https://www.ddyueshu.cc/", 2),
    (12, "23qb",       "https://www.23qb.net/book/lastupdate_0_0_0_0_0_0_0_1_0.html", 5),
    (13, "huangjinwu", "https://www.huangjinwu.org/", 2),
    (14, "ggd66",      "https://www.ggd66.com/sort/1/", 40),
    (15, "xinjianpan", "https://www.xinjianpan.com/rank/lastupdate/?page=1", 30),
    (16, "101kks",     "https://101kks.com/novels/class/0_1.html", 40),
    (17, "x2552",      "http://www.x2552.com/", 2),
    (18, "trxsw",      "http://www.trxsw.com/lastupdate/", 10),
    (20, "77shuku",    "http://www.77shuku.info/", 10),
    (21, "5165",       "https://5165.org/", 2),
    (22, "23uswx",     "http://www.23uswx.la/", 2),
    (24, "ixdzs8",     "https://ixdzs8.com/new/", 40),
]

for rid, name, url, pages in FLEET:
    body = json.dumps({"mode": "list", "targetUrl": url, "ruleId": rid,
                       "pages": pages, "storageMode": "db"}).encode()
    req = urllib.request.Request("http://127.0.0.1:3000/api/scrape-tasks", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read())
        tid = (d.get('task') or {}).get('id')
        print(f"{name:12s} -> task #{tid} created (pages={pages})")
    except urllib.error.HTTPError as e:
        print(f"{name:12s} -> HTTP {e.code}: {e.read().decode()[:100]}")
