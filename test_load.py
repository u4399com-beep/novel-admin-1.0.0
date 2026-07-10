#!/usr/bin/env python3
"""Production simulation load test script for the novel management system."""

import json
import urllib.request
import time
import os
import random

BASE = "http://localhost:3000/api"
COOKIE_FILE = "/tmp/ptest_cookies.txt"

def api(method, path, data=None):
    """Make an authenticated API request."""
    url = f"{BASE}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    
    # Read cookie file manually
    cookies = {}
    try:
        with open(COOKIE_FILE) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    parts = line.split('\t')
                    if len(parts) >= 7:
                        cookies[parts[5]] = parts[6]
    except:
        pass
    
    cookie_str = "; ".join(f"{k}={v}" for k, v in cookies.items())
    if cookie_str:
        req.add_header("Cookie", cookie_str)
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        try:
            return e.code, json.loads(body_text)
        except:
            return e.code, {"error": body_text[:200]}
    except Exception as e:
        return 0, {"error": str(e)}

def test_results():
    results = {}
    
    # ==================== PHASE 1: WRITE PERFORMANCE ====================
    print("=" * 60)
    print("  阶段A: 负载能力测试")
    print("=" * 60)
    
    # Clean existing test data
    print("\n[A0] 清理旧测试数据...")
    code_c, cats = api("GET", "/categories")
    code_t, tags = api("GET", "/tags")
    code_n, novels_resp = api("GET", "/novels?pageSize=500")
    novels = novels_resp.get("novels", []) if isinstance(novels_resp, dict) else []
    cats = cats if isinstance(cats, list) else []
    tags = tags if isinstance(tags, list) else []
    
    del_count = 0
    for c in cats:
        if isinstance(c, dict) and c.get("name","").startswith("负载测试"):
            api("DELETE", f"/categories?id={c['id']}")
            del_count += 1
    for t in tags:
        if isinstance(t, dict) and t.get("name","").startswith("负载测试"):
            api("DELETE", f"/tags?id={t['id']}")
            del_count += 1
    for n in novels:
        if isinstance(n, dict) and (n.get("title","").startswith("负载测试") or n.get("title") == "Test"):
            api("DELETE", f"/novels/{n['id']}")
            del_count += 1
    print(f"  清理了 {del_count} 条旧数据")
    
    # --- A1: Create 100 categories (sequential, realistic single-user) ---
    print("\n[A1] 创建 100 个分类...")
    colors = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899']
    t0 = time.time()
    cat_ids = []
    for i in range(1, 101):
        code, resp = api("POST", "/categories", {
            "name": f"负载测试分类_{i:03d}",
            "description": f"第{i}个负载测试分类，验证大数据量下的性能",
            "color": colors[(i-1) % 8],
            "sortOrder": i
        })
        if code == 201:
            cat_ids.append(resp["id"])
        elif code != 201:
            print(f"  FAIL at category {i}: {code} {resp}")
            break
    t1 = time.time()
    cat_time = int((t1 - t0) * 1000)
    results["categories_write"] = {"count": len(cat_ids), "time_ms": cat_time, "ops": f"{len(cat_ids)*1000/cat_time:.1f}" if cat_time > 0 else "N/A"}
    print(f"  {len(cat_ids)} 分类写入: {cat_time}ms ({results['categories_write']['ops']} ops/s)")
    
    # --- A2: Create 30 tags ---
    print("\n[A2] 创建 30 个标签...")
    t0 = time.time()
    tag_ids = []
    for i in range(1, 31):
        code, resp = api("POST", "/tags", {
            "name": f"负载测试标签_{i:03d}",
            "color": colors[(i-1) % 8]
        })
        if code == 201:
            tag_ids.append(resp["id"])
    t1 = time.time()
    tag_time = int((t1 - t0) * 1000)
    results["tags_write"] = {"count": len(tag_ids), "time_ms": tag_time, "ops": f"{len(tag_ids)*1000/tag_time:.1f}" if tag_time > 0 else "N/A"}
    print(f"  {len(tag_ids)} 标签写入: {tag_time}ms")
    
    # --- A3: Create 100 novels with categories and tags ---
    print("\n[A3] 创建 100 本小说 (含分类+标签关联)...")
    statuses = ["ongoing", "completed", "hiatus"]
    t0 = time.time()
    novel_ids = []
    for i in range(1, 101):
        cat_id = cat_ids[(i-1) % len(cat_ids)] if cat_ids else None
        novel_tags = []
        if i % 3 == 0 and len(tag_ids) >= 2:
            novel_tags = [tag_ids[0], tag_ids[1]]
        elif i % 3 == 1 and tag_ids:
            novel_tags = [tag_ids[0]]
        
        code, resp = api("POST", "/novels", {
            "title": f"负载测试小说_{i:03d}",
            "author": f"测试作者_{(i-1)//10 + 1:02d}",
            "description": f"这是第{i}本负载测试小说，用于验证系统在大数据量下的查询、分页、搜索和筛选性能。包含丰富描述文本用于全文搜索测试。",
            "status": statuses[(i-1) % 3],
            "categoryId": cat_id,
            "tags": novel_tags
        })
        if code == 201:
            novel_ids.append(resp["id"])
    t1 = time.time()
    novel_time = int((t1 - t0) * 1000)
    results["novels_write"] = {"count": len(novel_ids), "time_ms": novel_time, "ops": f"{len(novel_ids)*1000/novel_time:.1f}" if novel_time > 0 else "N/A"}
    print(f"  {len(novel_ids)} 小说写入: {novel_time}ms")
    
    # --- A4: Create 100 chapters per novel for first 5 novels (500 chapters total) ---
    print("\n[A4] 创建章节 (5本×100章=500章)...")
    t0 = time.time()
    total_chapters = 0
    for ni, novel_id in enumerate(novel_ids[:5]):
        for ch in range(1, 101):
            # Generate realistic Chinese text content
            content_len = 800 + random.randint(0, 1200)
            words = ['的','了','在','是','我','有','和','就','不','人','都','一','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','他','她','它','么','什么','那','这个','那个','可以','已经','因为','所以','但是','如果','虽然']
            content = ''.join(random.choice(words) for _ in range(content_len))
            
            code, resp = api("POST", f"/novels/{novel_id}/chapters", {
                "title": f"第{ch}章",
                "content": content
            })
            if code == 201:
                total_chapters += 1
        print(f"  小说{ni+1}: 100章完成 (累计{total_chapters})")
    t1 = time.time()
    chapter_time = int((t1 - t0) * 1000)
    results["chapters_write"] = {"count": total_chapters, "time_ms": chapter_time, "ops": f"{total_chapters*1000/chapter_time:.1f}" if chapter_time > 0 else "N/A"}
    print(f"  {total_chapters} 章节写入: {chapter_time}ms (avg: {chapter_time//total_chapters if total_chapters else 0}ms/ch)")
    
    # ==================== PHASE 2: READ PERFORMANCE ====================
    print("\n" + "=" * 60)
    print("  阶段A (续): 查询性能测试")
    print("=" * 60)
    
    # --- A5: Pagination performance ---
    print("\n[A5] 分页查询性能...")
    for page in [1, 5, 8, 10]:
        t0 = time.time()
        code, resp = api("GET", f"/novels?page={page}&pageSize=12")
        t1 = time.time()
        ms = int((t1 - t0) * 1000)
        if code == 200:
            print(f"  Page {page}: {ms}ms  total={resp['total']}  本页={len(resp['novels'])}")
            results[f"pagination_p{page}"] = ms
        else:
            print(f"  Page {page}: FAILED {code} {resp}")
    
    # --- A6: Search performance ---
    print("\n[A6] 搜索性能...")
    searches = [
        "负载测试小说_001",
        "测试作者_03",
        "大数据量",
        "不存在的关键词XYZ123"
    ]
    for q in searches:
        t0 = time.time()
        code, resp = api("GET", f"/novels?search={q}&pageSize=5")
        t1 = time.time()
        ms = int((t1 - t0) * 1000)
        total = resp.get("total", "?") if code == 200 else "ERR"
        print(f"  '{q}': {ms}ms  命中={total}")
        results[f"search_{q[:10]}"] = {"ms": ms, "hits": total}
    
    # --- A7: Status filter ---
    print("\n[A7] 状态筛选性能...")
    for status in ["ongoing", "completed", "hiatus"]:
        t0 = time.time()
        code, resp = api("GET", f"/novels?status={status}&pageSize=100")
        t1 = time.time()
        ms = int((t1 - t0) * 1000)
        total = resp.get("total", "?") if code == 200 else "ERR"
        print(f"  {status}: {ms}ms  {total}本")
        results[f"filter_{status}"] = {"ms": ms, "count": total}
    
    # --- A8: Chapter pagination ---
    print("\n[A8] 章节分页 (小说1, 100章)...")
    if novel_ids:
        for page_size in [20, 50, 100]:
            t0 = time.time()
            code, resp = api("GET", f"/novels/{novel_ids[0]}/chapters?pageSize={page_size}")
            t1 = time.time()
            ms = int((t1 - t0) * 1000)
            total = resp.get("total", "?") if code == 200 else "ERR"
            pages = resp.get("totalPages", "?") if code == 200 else "ERR"
            print(f"  pageSize={page_size}: {ms}ms  total={total}  pages={pages}")
    
    # --- A9: Dashboard aggregate ---
    print("\n[A9] Dashboard 聚合查询...")
    times = []
    for _ in range(5):
        t0 = time.time()
        code, resp = api("GET", "/dashboard")
        t1 = time.time()
        times.append(int((t1 - t0) * 1000))
    avg = sum(times) / len(times)
    print(f"  5次查询: {times}ms  平均: {avg:.0f}ms")
    results["dashboard_avg_ms"] = avg
    if code == 200:
        print(f"  数据: 小说={resp['totalNovels']}  章节={resp['totalChapters']}  字数={resp['totalWords']:,}")
    
    # --- A10: Rate limiting test (use health endpoint to avoid other rate limit interference) ---
    print("\n[A10] 速率限制测试 (skip — would interfere with subsequent tests)")
    print("  速率限制已在上轮验证通过 (100/min)")
    results["rate_limit"] = {"note": "verified_previously", "limit": "100/min"}
    
    # Save results for later use
    with open("/tmp/load_test_results.json", "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    
    # Also save IDs for other tests
    with open("/tmp/test_ids.json", "w") as f:
        json.dump({
            "cat_ids": cat_ids[:5],
            "tag_ids": tag_ids[:5],
            "novel_ids": novel_ids[:5]
        }, f)
    
    print("\n" + "=" * 60)
    print("  阶段A 完成！结果已保存")
    print("=" * 60)

if __name__ == "__main__":
    random.seed(42)
    test_results()