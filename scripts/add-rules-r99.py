#!/usr/bin/env python3
"""R99：新增两站采集规则（biqutu 爱笔楼 / minyuan 小原文学网）——用户存量库幂等补种。

背景：seed/seed.json 已固化规则 id=27/28（随二进制分发，重建库自动播种）；
但 seed 仅在 ScrapeRule 空表时导入，用户已运行的存量库拿不到 → 本脚本经
backend admin API 幂等补种（按 name 判重：存在→带 id 更新，不存在→新建）。

用法（服务器上 backend 已运行时执行）：
    python3 scripts/add-rules-r99.py [backend_url]
    # backend_url 默认 http://127.0.0.1:3000

幂等性：重复执行安全（第二次为更新路径，规则内容以本脚本内置为准）。
"""
import json
import sys
import urllib.request

STD_TOC_PAG = (
    "a.morechapter,.pagelink a,.pageLink a,.pagination a,.pagination-list a,"
    ".pagelist a,#pages a,#pagelist a,#page_bar a,#pagebar a,"
    ".pageNav a,.page-nav a,.pagebar a,.page_bar a,"
    "a:contains(下一页),a:contains(下一頁)"
)

RULES = [
    {
        "id": 27,
        "name": "biqutu",
        "siteUrl": "http://www.biqutu.info/",
        "enabled": True,
        "charset": "utf-8",
        "proxy": "",
        "insecureTLS": False,
        "listRule": {"itemSelector": "#newscontent .l ul li", "titleSelector": "span.s2 a",
                      "linkSelector": "span.s2 a", "authorSelector": "span.s4"},
        "bookRule": {
            "titleSelector": "#info h1, meta[property=\"og:novel:book_name\"]@content",
            "authorSelector": "#info p:first-of-type, meta[property=\"og:novel:author\"]@content",
            "descriptionSelector": "#intro, meta[property=\"og:description\"]@content",
            "coverSelector": "#fmimg img@src, meta[property=\"og:image\"]@content",
            "categorySelector": "meta[property=\"og:novel:category\"]@content",
            "chapterLinkSelector": "#list dl dd a",
            "chapterListPaginationSelector": STD_TOC_PAG,
        },
        "chapterRule": {"titleSelector": ".bookname h1, h1", "contentSelector": "#content",
                         "nextSelector": "a:contains(下一章)", "excludeSelector": "div[align=center]"},
        "notes": "2026-10 实测（爱笔楼，杰奇 CMS）：首页 #newscontent .l=「最近更新」30 条；书页 #info/#intro/#fmimg，"
                 "og:novel:* meta 齐全；#list dl dd=全目录单页无分页（212 章 1→212 连续实测）；章节 .bookname h1 + #content，"
                 "章尾报错提示 div[align=center] 已 excludeSelector 剔除。沙箱直连黑洞（实测经共享代理通过），"
                 "国内服务器预计直连可达；若不通在 admin 全局代理池填出口。",
    },
    {
        "id": 28,
        "name": "minyuan",
        "siteUrl": "https://www.min-yuan.com/",
        "enabled": True,
        "charset": "utf-8",
        "proxy": "",
        "insecureTLS": False,
        "listRule": {"itemSelector": "#newscontent .l ul li", "titleSelector": "span.s2 a",
                      "linkSelector": "span.s2 a", "authorSelector": "span.s4"},
        "bookRule": {
            "titleSelector": "#info h1, meta[property=\"og:novel:book_name\"]@content",
            "authorSelector": "#info p:first-of-type, meta[property=\"og:novel:author\"]@content",
            "descriptionSelector": "#intro, meta[property=\"og:description\"]@content",
            "coverSelector": "#fmimg img@data-original, #fmimg img@src, meta[property=\"og:image\"]@content",
            "statusSelector": "#info p:contains(状态), meta[property=\"og:novel:status\"]@content",
            "categorySelector": "meta[property=\"og:novel:category\"]@content, p.sort",
            "chapterLinkSelector": "#newlist dd a, #list dl dd a",
            "chapterListPaginationSelector": STD_TOC_PAG,
        },
        "chapterRule": {"titleSelector": "h1", "contentSelector": "#booktxt, #chaptercontent",
                         "nextSelector": "a:contains(下一章), a[rel=next]"},
        "notes": "2026-10 实测（小原文学网，杰奇变体+混淆 class，稳定 id 骨架）：首页「最近更新小说列表」30 条；"
                 "#newlist dd=完整目录单页无分页（1853 章零缺失实测）；lazy 封面 @data-original 优先（@src 是 nocover 占位）；"
                 "章节内分页 1.html→1_2.html 引擎自动拼接（isSameChapterPagination _ 形态）。沙箱直连 403（实测经共享代理通过），"
                 "国内服务器若 403 在 admin 全局代理池填出口。",
    },
]


def api(base, method, path, payload=None):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None,
        headers={"Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3000").rstrip("/")
    try:
        existing = api(base, "GET", "/api/scrape-rules")
    except Exception as e:
        print(f"读取规则清单失败（backend {base} 未运行?）: {e}")
        sys.exit(1)
    rules = existing if isinstance(existing, list) else existing.get("rules") or existing.get("data") or []
    by_name = {r.get("name"): r.get("id") for r in rules}

    for rule in RULES:
        rid = by_name.get(rule["name"])
        payload = dict(rule)
        if rid:
            payload["id"] = rid  # 更新路径（API 语义：带 id=覆盖三规则组）
            out = api(base, "POST", "/api/scrape-rules", payload)
            print(f"更新 规则#{out.get('id', rid)} {rule['name']}（已有同名规则）")
        else:
            out = api(base, "POST", "/api/scrape-rules", payload)
            print(f"新建 规则#{out.get('id')} {rule['name']}")
    print("完成。FleetKeeper 将在 ≤5min 内为启用规则自动创建 list 任务。")


if __name__ == "__main__":
    main()
