#!/usr/bin/env python3
"""R123 候选站结构深挖：首页/分类页翻页锚点探测"""
import json, urllib.request, re, concurrent.futures, sys

def fetch(name, url):
    body = json.dumps({"url": url, "strategy": "fetch-curl", "timeoutMs": 12000}).encode()
    req = urllib.request.Request("http://127.0.0.1:3030/api/test", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.loads(r.read())
        att = d.get("attempts") or []
        ok = att[0].get("ok") if att else d.get("ok")
        html = d.get("html") or d.get("content") or ""
        return name, ok, html
    except Exception as e:
        return name, False, str(e)

def analyze(name, html):
    # 找翻页锚点
    pagers = re.findall(r'href="([^"]*page[^"]*|[^"]*_\d+\.html|[^"]*/\d+\.html)"[^>]*>(?:下一页|下页|next|&gt;)', html[:200000], re.I)
    # 找书链
    links = re.findall(r'href="(/[a-z]+/\d+[_\-]?\d*\.html?)"', html)
    print(f"[{name}] len={len(html)} pager_anchors={list(dict.fromkeys(pagers))[:3]} book_links~={len(links)} sample={list(dict.fromkeys(links))[:5]}")

TASKS = [
    ("81zw-cat",   "https://www.81zw.com/book/0/1/"),
    ("81zw-home",  "https://www.81zw.com/"),
    ("biqiuge-cat","https://www.biqiuge8.com/sort/1/1/"),
    ("kanshuzu-cat","https://www.kanshuzu.com/sort/1/1/"),
    ("shukeju-cat","https://www.shukeju.com/xuanhuanxiaoshuo/1/"),
    ("booktxt-cat","https://www.booktxt.com/xuanhuanxiaoshuo/1.html"),
    ("dingshu-cat","https://www.dingdianla.com/sort/1/1/"),
]
with concurrent.futures.ThreadPoolExecutor(7) as ex:
    for name, ok, html in ex.map(lambda t: fetch(*t), TASKS):
        if ok and html:
            analyze(name, html)
        else:
            print(f"[{name}] FAIL {html[:80]}")
