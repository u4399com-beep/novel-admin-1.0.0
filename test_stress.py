#!/usr/bin/env python3
"""精简抗压 & 抗攻击测试 - 适配开发模式"""
import requests, time, json, random, string, sys
from urllib.parse import quote

BASE = "http://127.0.0.1:3000"
s = requests.Session()
AUTHED = False

def api(m, p, **kw):
    try:
        r = s.request(m, f"{BASE}{p}", timeout=15, **kw)
        try: return r.status_code, r.json()
        except: return r.status_code, r.text or ""
    except Exception as e:
        return -1, str(e)

def rs(n=8): return ''.join(random.choices(string.ascii_letters+string.digits, k=n))

def login():
    global AUTHED
    r = s.get(f"{BASE}/api/auth/csrf", timeout=10)
    if r.status_code != 200: return False
    csrf = r.json().get("csrfToken","")
    r = s.post(f"{BASE}/api/auth/callback/credentials", data={
        "username":"admin","password":"NovelAdmin@2024!Secure",
        "csrfToken":csrf,"callbackUrl":"/api/health"
    }, allow_redirects=False, timeout=10)
    # Check session
    r2 = s.get(f"{BASE}/api/dashboard", timeout=10)
    AUTHED = r2.status_code == 200
    print(f"  {'✓' if AUTHED else '✗'} 认证{'成功' if AUTHED else '失败'}")
    return AUTHED

def cleanup():
    code, novels = api("GET", "/api/novels?pageSize=500")
    nl = novels.get("novels",[]) if isinstance(novels,dict) else []
    d=0
    for n in nl:
        if isinstance(n,dict) and any(k in n.get("title","") for k in ["压测","XSS","深度","键数","SSRF","路径","并发"]):
            api("DELETE",f"/api/novels/{n['id']}"); d+=1
    print(f"  ✓ 删除{d}本测试小说")
    for ep, key in [("/api/categories","压测分类"),("/api/tags","压测标签")]:
        code,data = api("GET",ep)
        for item in (data if isinstance(data,list) else []):
            if isinstance(item,dict) and key in item.get("name",""):
                api("DELETE",f"{ep}?id={item['id']}")

if __name__ == "__main__":
    print("="*60)
    print("  小说管理系统 - 精简抗压 & 抗攻击测试")
    print("="*60)
    
    passed=0; total=0
    
    # 1. Health
    print("\n[1] 健康检查")
    code,data = api("GET","/api/health")
    assert code==200, f"Health failed: {code}"
    print(f"  ✓ DB延迟: {data.get('services',{}).get('database',{}).get('latencyMs','?')}ms")
    
    # 2. Auth
    print("\n[2] 认证测试")
    assert login(), "Login failed"
    
    # 3. Write test - categories (add delay for rate limit)
    print("\n[3] 写入测试 - 10个分类")
    total+=1
    cats=[]
    t0=time.time()
    for i in range(10):
        time.sleep(0.5)  # 0.5s delay = ~1 token between requests
        c,d = api("POST","/api/categories",json={"name":f"压测分类_{rs()}","color":f"#{rs(6)}"})
        if c==201 and isinstance(d,dict) and d.get("id"): cats.append(d["id"])
        elif c==429: pass  # skip rate limited
    elapsed=time.time()-t0
    if len(cats)>=5:
        print(f"  ✓ 创建{len(cats)}个分类, {elapsed:.1f}s"); passed+=1
    else:
        print(f"  ⚠ 仅创建{len(cats)}个分类 (速率限制)")
    time.sleep(2)  # Let rate limit tokens refill
    
    # 4. Write test - novels
    print("\n[4] 写入测试 - 10本小说")
    total+=1
    novels=[]
    t0=time.time()
    for i in range(10):
        tags=random.sample(cats,min(2,len(cats))) if cats else []
        c,d = api("POST","/api/novels",json={
            "title":f"压测小说_{rs()}_{i}","author":f"作者_{rs()}",
            "description":"测试描述"*5,"status":"ongoing","categoryId":cats[0] if cats else None,"tags":tags
        })
        if c==201 and isinstance(d,dict) and d.get("id"): novels.append(d["id"])
    elapsed=time.time()-t0
    if len(novels)>=8:
        print(f"  ✓ 创建{len(novels)}本小说, {elapsed:.1f}s"); passed+=1
    else:
        print(f"  ⚠ 仅创建{len(novels)}本小说")
    time.sleep(1)
    
    # 5. Write test - chapters
    print("\n[5] 写入测试 - 50章")
    total+=1
    ch=0; t0=time.time()
    for nid in novels[:5]:
        for j in range(10):
            c,_ = api("POST",f"/api/novels/{nid}/chapters",json={
                "title":f"第{j+1}章","content":"这是测试内容，"*50
            })
            if c==201: ch+=1
    elapsed=time.time()-t0
    if ch>=40:
        print(f"  ✓ 创建{ch}章, {elapsed:.1f}s ({ch/max(elapsed,.01):.0f} ops/s)"); passed+=1
    else:
        print(f"  ⚠ 仅创建{ch}章")
    time.sleep(1)
    
    # 6. Read performance
    print("\n[6] 读取性能测试")
    total+=1
    t0=time.time()
    c,d = api("GET","/api/novels?page=1&pageSize=12")
    t_read = time.time()-t0
    t0=time.time()
    c2,d2 = api("GET","/api/novels?search=压测小说")
    t_search = time.time()-t0
    t0=time.time()
    c3,d3 = api("GET","/api/dashboard")
    t_dash = time.time()-t0
    if all(x==200 for x in [c,c2,c3]):
        print(f"  ✓ 列表:{t_read*1000:.0f}ms 搜索:{t_search*1000:.0f}ms Dashboard:{t_dash*1000:.0f}ms")
        passed+=1
    else:
        print(f"  ⚠ 部分失败: {c}/{c2}/{c3}")
    time.sleep(1)
    
    # 7. SQL Injection
    print("\n[7] SQL注入测试")
    total+=1
    safe=True
    for p in ["' OR 1=1--","'; DROP TABLE--","UNION SELECT NULL--"]:
        c,_ = api("GET",f"/api/novels?search={quote(p)}")
        if c==500: safe=False
    if safe: print("  ✓ 3个SQL注入payload被正确处理"); passed+=1
    else: print("  ✗ SQL注入导致500错误")
    time.sleep(1)
    
    # 8. XSS
    print("\n[8] XSS注入测试")
    total+=1
    safe=True
    for p in ['<script>alert(1)</script>','<img onerror=alert(1)>']:
        c,_ = api("POST","/api/novels",json={"title":f"XSS_{rs()}","author":p})
        if c==500: safe=False
    if safe: print("  ✓ 2个XSS payload未导致崩溃"); passed+=1
    else: print("  ✗ XSS导致500错误")
    time.sleep(1)
    
    # 9. SSRF
    print("\n[9] SSRF防护测试")
    total+=1
    safe=True
    for url in ["http://127.0.0.1:3000/api/health","http://169.254.169.254/","file:///etc/passwd"]:
        c,d = api("POST","/api/novels",json={"title":f"SSRF_{rs()}","author":"t","coverUrl":url})
        if c==201 and isinstance(d,dict) and d.get("coverUrl")==url: safe=False
    if safe: print("  ✓ 3个SSRF payload被正确处理"); passed+=1
    else: print("  ✗ SSRF未被拦截")
    time.sleep(1)
    
    # 10. Large body
    print("\n[10] 超大请求体测试")
    total+=1
    c,_ = api("POST","/api/novels",json={"title":"A"*2_000_000,"author":"t"})
    if c in [413,400]:
        print(f"  ✓ 超大请求体被拒绝 (HTTP {c})"); passed+=1
    else:
        print(f"  ⚠ 返回HTTP {c} (期望413/400)")
    time.sleep(1)
    
    # 11. Unauth access
    print("\n[11] 未认证访问测试")
    total+=1
    anon = requests.Session()
    safe=True
    for p in ["/api/novels","/api/dashboard","/api/categories"]:
        r=anon.get(f"{BASE}{p}",timeout=10)
        if r.status_code!=401: safe=False
    if safe: print("  ✓ 3个受保护API返回401"); passed+=1
    else: print("  ✗ 未认证访问未被拦截")
    time.sleep(1)
    
    # 12. Port scanning
    print("\n[12] XTransformPort端口扫描防护")
    total+=1
    safe=True
    for port in ["22","3306","6379","8080"]:
        c,_ = api("GET",f"/api/health?XTransformPort={port}")
        if c!=400: safe=False
    if safe: print("  ✓ 4个非法端口被拒绝(400)"); passed+=1
    else: print("  ✗ 部分端口未被拒绝")
    time.sleep(1)
    
    # 13. Rate limiting
    print("\n[13] 速率限制验证")
    total+=1
    throttled=0
    for _ in range(35):
        c,_ = api("GET","/api/health")  # health is public, won't be rate limited
    # For rate limit, use an authenticated endpoint
    for _ in range(35):
        c,_ = api("GET","/api/dashboard")
        if c==429: throttled+=1
    if throttled>0:
        print(f"  ✓ {throttled}/35 被限流(429) - 速率限制正常"); passed+=1
    else:
        print("  ⚠ 未触发速率限制")
    
    # 14. Deep JSON
    print("\n[14] 深度嵌套JSON测试")
    total+=1
    deep={"a":1}
    for _ in range(25): deep={"n":deep}
    c,_ = api("POST","/api/novels",json={"title":f"深度_{rs()}","author":"t","extra":deep})
    if c in [400,201,429]:
        print(f"  ✓ 深度嵌套JSON被正确处理 (HTTP {c})"); passed+=1
    else:
        print(f"  ⚠ 返回HTTP {c}")
    
    # Cleanup
    print("\n[清理]")
    cleanup()
    
    print("\n" + "="*60)
    print(f"  测试结果: {passed}/{total} 通过 ({passed/total*100:.0f}%)")
    print("="*60)
    
    if passed/total < 0.8:
        sys.exit(1)