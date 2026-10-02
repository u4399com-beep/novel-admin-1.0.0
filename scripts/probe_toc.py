#!/usr/bin/env python3
"""目录分页探针：走引擎 /api/test 抓取规则站点，检查书页/目录页是否分页。
用法: python3 probe_toc.py <ruleId> <url> <list|book> [outPrefix]
"""
import json, sys, urllib.request

ENGINE = "http://127.0.0.1:3030/api/test"
BACKEND = "http://localhost:3000/api/scrape-rules"

def get_rules():
    with urllib.request.urlopen(BACKEND, timeout=30) as r:
        return json.load(r)

def engine_test(url, rule_key, rule_cfg, proxy, charset, insecure, cookies, include_html=True, referer=""):
    body = {"url": url, "rule": {rule_key: rule_cfg}, "includeHtml": include_html}
    if proxy: body["proxy"] = proxy
    if charset: body["charset"] = charset
    if insecure: body["insecureTLS"] = True
    if cookies: body["cookies"] = cookies
    if referer: body["referer"] = referer
    req = urllib.request.Request(ENGINE, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)

def main():
    rule_id = int(sys.argv[1])
    url = sys.argv[2]
    seg = sys.argv[3] if len(sys.argv) > 3 else "list"
    prefix = sys.argv[4] if len(sys.argv) > 4 else "probe"
    rules = get_rules()
    rule = next((r for r in rules if r.get("id") == rule_id), None)
    if not rule:
        print("rule not found", rule_id); sys.exit(1)
    key = {"list": "listRule", "book": "bookRule"}[seg]
    cfg = rule.get(key) or {}
    res = engine_test(url, key, cfg, rule.get("proxy"), rule.get("charset"), rule.get("insecureTLS"), rule.get("cookies"))
    ok = res.get("ok")
    print(f"== {rule['name']} {seg} {url} -> ok={ok}")
    if not ok:
        print("error:", res.get("error"), "| detail:", str(res.get("detail"))[:200])
        return
    data = (res.get("data") or {}).get(seg) or {}
    if seg == "list":
        items = (data.get("items") or [])[:8]
        for it in items:
            print("ITEM:", it.get("title", "")[:30], "|", it.get("url", ""))
        with open(f"/tmp/{prefix}_list.json", "w") as f:
            json.dump(res, f, ensure_ascii=False)
    else:
        chapters = data.get("chapters") or []
        print("chapters:", len(chapters), "| catalogUrl:", data.get("catalogUrl"))
        print("title:", (data.get("title") or "")[:40])
        for c in chapters[:3] + (chapters[-2:] if len(chapters) > 5 else []):
            print("  CH:", c.get("title", "")[:30], "|", c.get("url", "")[:80])
        html = res.get("htmlDebug") or ""
        with open(f"/tmp/{prefix}_{seg}.html", "w") as f:
            f.write(html)
        print("htmlDebug saved:", len(html), "chars -> /tmp/{}_{}.html".format(prefix, seg))

if __name__ == "__main__":
    main()
