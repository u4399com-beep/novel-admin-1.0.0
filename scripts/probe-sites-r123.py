#!/usr/bin/env python3
"""R123 候选站普查（扩容路线：新增站点=快车道天花板下唯一正道）
含 R121 排除站复探（环境重置后状态可能变化）+ 全新候选"""
import json, urllib.request, concurrent.futures

SITES = [
    # R121 排除站复探
    ("biquwo",    "https://www.biquwo.co/"),
    ("81zw",      "https://www.81zw.com/"),
    ("mbtxt",     "https://www.mbtxt.cn/"),
    ("quanben",   "https://www.quanben.io/"),
    ("biqiuge",   "https://www.biqiuge8.com/"),
    ("kanshuzu",  "https://www.kanshuzu.com/"),
    ("shukeju",   "https://www.shukeju.com/"),
    # 全新候选
    ("69shu",     "https://www.69shu.com/"),
    ("69yuedu",   "https://www.69yuedu.net/"),
    ("uukanshu",  "https://www.uukanshu.com/"),
    ("xbiquge",   "https://www.xbiquge.la/"),
    ("booktxt",   "https://www.booktxt.net/"),
    ("bequge",    "https://www.bequge.cc/"),
    ("838xs",     "https://www.838xs.com/"),
    ("kxshuo",    "https://www.kuxiaoshuo.com/"),
    ("dashenxs",  "https://www.dashenxiaoshuo.com/"),
    ("tsyige",    "https://www.tsyige.com/"),
    ("dingshu",   "https://www.dingdianla.com/"),
    ("cepulou",   "https://www.cepulou.com/"),
    ("wuregu",    "https://www.wuregu.com/"),
]

def probe(item):
    name, url = item
    body = json.dumps({"url": url, "strategy": "fetch-curl", "timeoutMs": 12000}).encode()
    req = urllib.request.Request("http://127.0.0.1:3030/api/test", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=22) as r:
            d = json.loads(r.read())
        att = d.get("attempts") or []
        ok = att[0].get("ok") if att else d.get("ok")
        note = (att[0].get("note","") if att else "")[:36]
        status = att[0].get("status") if att else ""
        size = att[0].get("bytes") or att[0].get("size") or (len(d.get("html") or ""))
        title = (d.get("title") or "")[:26]
        return name, ok, status, size, note, title
    except Exception as e:
        return name, "ERR", "", 0, str(e)[:40], ""

with concurrent.futures.ThreadPoolExecutor(10) as ex:
    for name, ok, status, size, note, title in ex.map(probe, SITES):
        print(f"{name:10s} ok={ok} status={status} size={size} {note} {title}")
