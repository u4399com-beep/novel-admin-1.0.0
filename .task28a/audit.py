#!/usr/bin/env python3
"""Task 28-a: batch audit all 15 rules via engine /api/test (list -> book -> chapter)."""
import json, sys, time
sys.path.insert(0, '/home/z/my-project/.task28a')
from ruletest import load_rules, engine_test

rules = load_rules()
order = [int(x) for x in sys.argv[1].split(',')] if len(sys.argv) > 1 else list(range(10, 25))

for rid in order:
    r = rules[rid]
    print(f"\n===== RULE {rid} {r['name']} enabled={r['enabled']} proxy={'Y' if r.get('proxy') else 'N'} charset={r.get('charset')}")
    cs = r.get("charset") or None
    # 1) list page
    d = engine_test(r["siteUrl"], r, "list", cs)
    lst = (d.get("data") or {}).get("list") or {}
    items = lst.get("items") or []
    print(f"  LIST ok={d.get('ok')} strat={d.get('strategy')} status={d.get('status')} count={lst.get('count')} err={d.get('error')}")
    if d.get("warnings"): print("  WARN:", [w[:110] for w in d.get("warnings", [])][:4])
    if items:
        print("  item0:", {k: (str(items[0].get(k))[:60]) for k in ("title","author","category","url")})
    if not items:
        continue
    # 2) book page = first item url
    burl = items[0].get("url") or ""
    if burl:
        time.sleep(2.2)
        d2 = engine_test(burl, r, "book", cs)
        b = (d2.get("data") or {}).get("book") or {}
        meta = {k: (str(b.get(k))[:70] if b.get(k) else b.get(k)) for k in ("title","author","category","status","cover","chapterCount","catalogUrl")}
        print(f"  BOOK ok={d2.get('ok')} strat={d2.get('strategy')} status={d2.get('status')}")
        print("  meta:", meta)
        if d2.get("warnings"): print("  WARN:", [w[:110] for w in d2.get("warnings", [])][:4])
        chs = b.get("chapters") or []
        if chs:
            # 3) chapter page: pick a middle chapter
            ch = chs[min(2, len(chs)-1)]
            curl = ch.get("url") or ""
            if curl:
                time.sleep(2.2)
                d3 = engine_test(curl, r, "chapter", cs)
                c = (d3.get("data") or {}).get("chapter") or {}
                lines = (c.get("content") or "").split("\n")
                print(f"  CHAPTER ok={d3.get('ok')} strat={d3.get('strategy')} wc={c.get('wordCount')} next={c.get('nextUrl')}")
                print("  first3:", [l[:50] for l in lines[:3]])
                print("  last3:", [l[:50] for l in lines[-3:]])
                # suspicious short lines (potential noise survivors)
                susp = [l for l in lines if 0 < len(l) <= 26 and ('www' in l or 'http' in l or 'com' in l.lower() or '搜索' in l or '点击' in l or '广告' in l or '更多' in l or '最新' in l or '章节目录' in l)]
                print("  SUSPECT:", susp[:6])
print("\nDONE")
