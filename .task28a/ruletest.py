#!/usr/bin/env python3
"""Task 28-a: engine /api/test helper for rule auditing."""
import json, sys, urllib.request

SEED = '/home/z/my-project/mini-services/backend-go/seed/seed.json'

def load_rules():
    return {r["id"]: r for r in json.load(open(SEED))["rules"]}

def engine_test(url, rule, mode="book", charset=None, timeout=120):
    body = {"url": url}
    r = {}
    if mode == "list":
        r["listRule"] = json.loads(rule["listRule"])
    elif mode == "book":
        r["bookRule"] = json.loads(rule["bookRule"])
    elif mode == "chapter":
        r["chapterRule"] = json.loads(rule["chapterRule"])
    body["rule"] = r
    if charset:
        body["charset"] = charset
    if rule.get("proxy"):
        body["proxy"] = rule["proxy"]
    if rule.get("insecureTLS"):
        body["insecureTLS"] = True
    req = urllib.request.Request("http://localhost:3030/api/test",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except Exception as e:
        return {"ok": False, "error": str(e)}

if __name__ == "__main__":
    rules = load_rules()
    rid = int(sys.argv[1])
    url = sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "book"
    r = rules[rid]
    d = engine_test(url, r, mode, r.get("charset") or None)
    out = {"ok": d.get("ok"), "strategy": d.get("strategy"), "status": d.get("status"),
           "encoding": d.get("encoding"), "error": d.get("error"), "warnings": d.get("warnings")}
    data = d.get("data", {})
    if mode == "list":
        lst = data.get("list", {})
        out["count"] = lst.get("count")
        out["items"] = lst.get("items", [])[:3]
    elif mode == "book":
        b = data.get("book", {})
        out["meta"] = {k: b.get(k) for k in ("title","author","category","status","cover","description","chapterCount","catalogUrl")}
        out["firstChapters"] = [{"title": c.get("title"), "url": (c.get("url") or "")[:80]} for c in b.get("chapters", [])[:3]]
    elif mode == "chapter":
        c = data.get("chapter", {})
        lines = (c.get("content") or "").split("\n")
        out["chapter"] = {"title": c.get("title"), "wordCount": c.get("wordCount"), "nextUrl": c.get("nextUrl"),
                          "firstLines": lines[:3], "lastLines": lines[-3:]}
    print(json.dumps(out, ensure_ascii=False, indent=1)[:3000])
