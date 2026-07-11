#!/usr/bin/env python3
"""Production simulation test - Load + Query + Edge Cases."""
import json, time, random, sys, urllib.request, os

TOKEN = open("/tmp/session_token.txt").read().strip()
BASE = "http://localhost:3000/api"
CK = f"next-auth.session-token={TOKEN}"

def api(method, path, data=None, retries=3):
    url = f"{BASE}{path}"
    body = json.dumps(data).encode() if data else None
    for attempt in range(retries):
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("Cookie", CK)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** (attempt + 1)
                print(f"  [429] Rate limited, waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            t = e.read().decode() if e.fp else ""
            try: return e.code, json.loads(t)
            except: return e.code, {"error": t[:200]}
        except Exception as e:
            return 0, {"error": str(e)}
    return 429, {"error": "rate_limited"}

random.seed(42)

print("=" * 60)
print("  阶段A: 负载能力测试")
print("=" * 60)

# A1: Get reference data
code, cats = api("GET", "/categories")
code, tags = api("GET", "/tags")
cat_ids = [c["id"] for c in cats[:5]] if isinstance(cats, list) else []
tag_ids = [t["id"] for t in tags[:3]] if isinstance(tags, list) else []

# A2: Create 100 novels
print(f"\n[A1] 创建 100 本小说 (cats={len(cat_ids)}, tags={len(tag_ids)})...")
t0 = time.time()
novel_ids = []
statuses = ["ongoing", "completed", "hiatus"]
for i in range(1, 101):
    ntags = [tag_ids[0], tag_ids[1]] if i % 3 == 0 and len(tag_ids) >= 2 else []
    code, resp = api("POST", "/novels", {
        "title": f"负载测试小说_{i:03d}",
        "author": f"测试作者_{(i-1)//10+1:02d}",
        "description": f"这是第{i}本负载测试小说，用于验证查询分页搜索筛选性能。包含丰富描述文本。",
        "status": statuses[(i-1) % 3],
        "categoryId": cat_ids[(i-1) % len(cat_ids)] if cat_ids else None,
        "tags": ntags
    })
    if code == 201:
        novel_ids.append(resp["id"])
dt = (time.time()-t0)*1000
print(f"  {len(novel_ids)} novels in {dt:.0f}ms ({len(novel_ids)*1000/max(dt,1):.0f} ops/s)")

# A3: Create 250 chapters
print(f"\n[A2] 创建 250 章节 (5 novels × 50)...")
t0 = time.time()
total_ch = 0
for ni, nid in enumerate(novel_ids[:5]):
    for ch in range(1, 51):
        w = '的了在是我有和就不人都一上也很到说要去你会着没有看好自己这他她么什么那这个那个可以已经因为所以但是如果虽然然后或者非常特别比较更加越来越最'
        random.seed(hash(nid) + ch)
        content = ''.join(random.choice(w) for _ in range(300 + random.randint(0, 500)))
        code, _ = api("POST", f"/novels/{nid}/chapters", {"title": f"第{ch}章", "content": content})
        if code == 201:
            total_ch += 1
dt = (time.time()-t0)*1000
print(f"  {total_ch} chapters in {dt:.0f}ms (avg {dt/max(total_ch,1):.0f}ms/ch)")

# A4: Query performance
print("\n[A3] 查询性能:")
print("  分页:")
for p in [1, 3, 5, 8]:
    t0 = time.time()
    code, d = api("GET", f"/novels?page={p}&pageSize=12")
    ms = (time.time()-t0)*1000
    print(f"    Page {p}: {ms:.0f}ms  total={d.get('total','?')}  items={len(d.get('novels',[]))}")

print("  搜索:")
for q in ["负载测试小说_001", "测试作者_03", "大数据量", "不存在XYZ123"]:
    t0 = time.time()
    code, d = api("GET", f"/novels?search={q}&pageSize=5")
    ms = (time.time()-t0)*1000
    print(f"    '{q}': {ms:.0f}ms  hits={d.get('total','ERR')}")

print("  状态筛选:")
for s in ["ongoing", "completed", "hiatus"]:
    t0 = time.time()
    code, d = api("GET", f"/novels?status={s}&pageSize=100")
    ms = (time.time()-t0)*1000
    print(f"    {s}: {ms:.0f}ms  count={d.get('total','ERR')}")

print("  章节分页:")
nid = novel_ids[0] if novel_ids else None
if nid:
    for ps in [10, 25, 50]:
        t0 = time.time()
        code, d = api("GET", f"/novels/{nid}/chapters?pageSize={ps}")
        ms = (time.time()-t0)*1000
        print(f"    pageSize={ps}: {ms:.0f}ms  total={d.get('total','?')}  pages={d.get('totalPages','?')}")

print("  Dashboard (5 runs):")
times = []
for r in range(5):
    t0 = time.time()
    code, d = api("GET", "/dashboard")
    ms = (time.time()-t0)*1000
    times.append(ms)
    if r == 0:
        print(f"    Run{r+1}: {ms:.0f}ms  novels={d['totalNovels']}  ch={d['totalChapters']}  words={d['totalWords']:,}  cats={d['totalCategories']}")
    else:
        print(f"    Run{r+1}: {ms:.0f}ms")
print(f"    Avg: {sum(times)/len(times):.0f}ms  Min: {min(times):.0f}ms  Max: {max(times):.0f}ms")

# A5: Edge cases
print("\n[A4] 边界条件:")
for label, path in [
    ("page=99999", "/novels?page=99999&pageSize=12"),
    ("page=-1", "/novels?page=-1&pageSize=12"),
    ("pageSize=9999", "/novels?page=1&pageSize=9999"),
    ("search=empty", "/novels?search=&pageSize=3"),
]:
    code, d = api("GET", path)
    items = len(d.get("novels", []))
    total = d.get("total", "?")
    print(f"  {label}: items={items}  total={total}  (code={code})")

# Long search (201 chars)
long_q = "测" * 201
code, d = api("GET", f"/novels?search={long_q}&pageSize=3")
print(f"  search=201chars: total={d.get('total','?')}  (truncated to 200)")

# Final state
print("\n[A5] 最终数据状态:")
code, d = api("GET", "/dashboard")
print(f"  小说: {d['totalNovels']}  章节: {d['totalChapters']}  字数: {d['totalWords']:,}  分类: {d['totalCategories']}")
print(f"  状态分布: {d['statusDistribution']}")

# Save novel IDs
with open("/tmp/test_novel_ids.txt", "w") as f:
    f.write("\n".join(novel_ids[:5]))

print("\n✅ 阶段A 完成")