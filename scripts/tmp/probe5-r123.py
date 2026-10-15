#!/usr/bin/env python3
"""R123 五站分类页结构探测（curl-imp 直连，找翻页+书链）"""
import subprocess, re, json

CURL = "/home/z/.local/bin/curl_chrome116"

SITES = [
    ("biqiuge",  ["https://www.biqiuge8.com/sort/1/1/", "https://www.biqiuge8.com/xuanhuanxiaoshuo/1/"]),
    ("kanshuzu", ["https://www.kanshuzu.com/sort/1/1/", "https://www.kanshuzu.com/xuanhuan/1/"]),
    ("shukeju",  ["https://www.shukeju.com/xuanhuanxiaoshuo/1/", "https://www.shukeju.com/sort/1/"]),
    ("booktxt",  ["https://www.booktxt.com/xuanhuanxiaoshuo/1.html", "https://www.booktxt.net/xuanhuanxiaoshuo/1.html"]),
    ("dingshu",  ["https://www.dingdianla.com/sort/1/1/", "https://www.dingdianla.com/xuanhuanxiaoshuo/1/"]),
]

for name, urls in SITES:
    hit = False
    for url in urls:
        try:
            r = subprocess.run([CURL, "-sL", "-m", "15", url], capture_output=True, timeout=20)
            html = r.stdout.decode("utf-8", errors="ignore")
        except Exception:
            continue
        if len(html) < 5000:
            print(f"[{name}] {url} -> small {len(html)}")
            continue
        pagers = set(re.findall(r'href="([^"]+)"[^>]*>[^<]*?(?:下一页|下页|next)', html, re.I))
        books = set(re.findall(r'href="(/[^"]+/\d+[_/]\d*\.html?|/book/\d+/|/\d+_\d+/)"', html))
        cat_urls = set(re.findall(r'href="((?:/[^"]*)?(?:sort|class|fenlei|category|list|xuanhuan)[^"]*)"', html, re.I))
        print(f"[{name}] {url} len={len(html)}")
        print(f"    pagers={list(pagers)[:3]}")
        print(f"    books={len(books)} sample={list(books)[:3]}")
        print(f"    cat_urls={list(cat_urls)[:6]}")
        hit = True
        break
    if not hit:
        print(f"[{name}] all urls failed")
