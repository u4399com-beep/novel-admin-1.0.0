#!/usr/bin/env python3
"""R101：新增采集规则 dwxwc（大文学无错小说网）——用户存量库幂等补种。

背景：由 legado 书源 yckceo#7928（🌞大文学无错，2026-10-07 更新）直译为系统规则
id=29，已固化 seed/seed.json（重建库自动播种）；但 seed 仅在 ScrapeRule 空表时导入，
用户已运行的存量库拿不到 → 本脚本经 backend admin API 幂等补种（按 name 判重：
存在→带 id 更新，不存在→新建）。

⚠️ 该规则为「未实测草稿」（enabled=false）：沙箱全出口被站点 GoEdge WAF 图片验证码
挑战，合规不破解。用户服务器启用前先在 admin 跑规则健康巡检，通过后启用；
若服务器 IP 也被挑战，人工过一次验证码后把 GOEDGE 会话 cookie 填入规则 cookies。

用法（服务器上 backend 已运行时执行）：
    python3 scripts/add-rules-r101.py [backend_url]
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
        "id": 29,
        "name": "dwxwc",
        "siteUrl": "https://www.dwxwc.com/",
        "enabled": False,
        "charset": "utf-8",
        "proxy": "",
        "insecureTLS": False,
        "listRule": {"itemSelector": ".bookbox", "titleSelector": ".bookname a",
                      "linkSelector": ".bookname a", "authorSelector": ".author"},
        "bookRule": {
            "titleSelector": ".booktitle, meta[property=\"og:novel:book_name\"]@content",
            "authorSelector": ".booktag a, meta[property=\"og:novel:author\"]@content",
            "descriptionSelector": ".bookintro, meta[property=\"og:description\"]@content",
            "coverSelector": ".bookcover img@src, .bookcover img@data-original, meta[property=\"og:image\"]@content",
            "categorySelector": ".booktag span, meta[property=\"og:novel:category\"]@content",
            "chapterLinkSelector": "#list-chapterAll dd a, #list dl dd a",
            "chapterListPaginationSelector": STD_TOC_PAG,
        },
        "chapterRule": {"titleSelector": ".bookname h1, h1", "contentSelector": "#content",
                         "nextSelector": "a:contains(下一章)"},
        "notes": "2026-10 由 legado 书源 yckceo#7928 直译（纯CSS无内嵌JS，U+2011 连字符已归一为 "
                 "#list-chapterAll）。⚠️未实测：沙箱全出口被 GoEdge WAF 图片验证码挑战（合规不破解），"
                 "enabled=false 草稿先例；用户服务器先跑健康巡检，通过后启用；若同被挑战需人工过一次"
                 "验证码把 GOEDGE cookie 填入规则 cookies 字段，或依赖 fetch-cloak 策略（R101 侧车）。"
                 "封面 src/data-original 双候选 + og:image 兜底；作者前缀由引擎 stripAuthorLabel 归一。",
    },
]


def api(base, method, path, payload=None):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        base + path,
        data=data,
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
    print("完成。启用 dwxwc 前建议先跑规则健康巡检（admin → 规则健康）。")


if __name__ == "__main__":
    main()
