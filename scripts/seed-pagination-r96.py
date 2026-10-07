#!/usr/bin/env python3
"""R96 修复②：seed.json 全量回写 chapterListPaginationSelector（分页能力防回退）。

背景：R82-R95 的分页规则修复全部只落运行时 DB（API PUT），seed.json 从未同步。
沙箱清理/新部署重建库后规则回退到无分页状态 → 目录恒为书页内嵌前 100 章 + 最新块
（用户实证《诸天领主》1-100 后直跳 796）。本脚本幂等：已有键不覆盖。

跳过：ixdzs8（id=24，chapterListApi JSON 目录，书页无 HTML 分页锚，walker 不适用）。
"""
import json, sys

SEED = "/home/z/my-project/mini-services/backend-go/seed/seed.json"

# 与引擎 defaultTocPaginationSelectors 完全一致（extract.go R96）
SEL = ("a.morechapter,.pagelink a,.pageLink a,.pagination a,.pagination-list a,"
       ".pagelist a,#pages a,#pagelist a,#page_bar a,#pagebar a,"
       ".pageNav a,.page-nav a,.pagebar a,.page_bar a,"
       "a:contains(下一页),a:contains(下一頁)")

SKIP_IDS = {24}  # ixdzs8：JSON 目录 API，HTML 分页选择器不适用

d = json.load(open(SEED))
rules = d.get("rules") or []
changed = 0
for r in rules:
    if r.get("id") in SKIP_IDS:
        print(f"skip id={r.get('id')} {r.get('name')}（JSON 目录 API）")
        continue
    br = {}
    try:
        br = json.loads(r.get("bookRule") or "{}")
    except Exception:
        br = {}
    if br.get("chapterListPaginationSelector"):
        print(f"keep id={r.get('id')} {r.get('name')}（已有键，不覆盖）")
        continue
    br["chapterListPaginationSelector"] = SEL
    r["bookRule"] = json.dumps(br, ensure_ascii=False)
    changed += 1
    print(f"set  id={r.get('id')} {r.get('name')}")

json.dump(d, open(SEED, "w"), ensure_ascii=False, indent=2)
print(f"done: {changed} rules updated -> {SEED}")
