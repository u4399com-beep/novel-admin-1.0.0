#!/usr/bin/env python3
"""R124: 逐规则实测目录提取质量——用户报告「许多书籍不是从第一章开始」。

对每条启用规则：
  1. 引擎 /api/test + listRule 抓列表页 → 取前 N 本书 URL
  2. 引擎 /api/test + bookRule 抓书页 → book.chapters（与生产 fetchBookPage 同代码路径）
  3. 分析目录序列：首章编号 / 是否从第 1 章开始 / 头部倒序块（最新章节块残留）/ 中段大缺口

结果写 /tmp/toc_probe_result.json（增量落盘，防中断丢失）。
礼貌约束：全部经引擎域槽队列串行放行（1.2s+/域），不并发轰炸源站。
"""
import json, re, sys, time, urllib.request

ENGINE = "http://127.0.0.1:3030"
OUT = "/tmp/toc_probe_result.json"
BOOKS_PER_RULE = 2
LIST_TIMEOUT_MS = 60000
BOOK_TIMEOUT_MS = 60000

# 与 backend-go parseChapterNo 同族语义：开头锚定 第N章/节/回/话/卷（含中文数字）
CN = "零〇一二两三四五六七八九十百千万"
RE_NO = re.compile(r"^第\s*([0-9０-９]{1,7}|[%s]{1,12})\s*[章节回话卷]" % CN)


def cn2int(s):
    if re.fullmatch(r"[0-9０-９]+", s):
        return int(s.translate(str.maketrans("０１２３４５６７８９", "0123456789")))
    # 简化中文数字解析（覆盖 千万内常规形态）
    digits = {c: v for c, v in zip("零〇一二两三四五六七八九", [0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9][:12])}
    digits = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}
    units = {"十": 10, "百": 100, "千": 1000, "万": 10000}
    total, section, num = 0, 0, 0
    for ch in s:
        if ch in digits:
            num = digits[ch]
        elif ch in units:
            u = units[ch]
            if u == 10000:
                section = (section + num) * 10000
                total += section
                section, num = 0, 0
            else:
                section += (num if num else 1) * u
                num = 0
    return total + section + num


def parse_no(title):
    m = RE_NO.match(title or "")
    if not m:
        return None
    try:
        v = cn2int(m.group(1))
        return v if 0 <= v < 99_999_999 else None
    except Exception:
        return None


def engine_post(path, body, timeout=150):
    req = urllib.request.Request(ENGINE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def load_rules():
    with urllib.request.urlopen("http://127.0.0.1:3000/api/scrape-rules", timeout=15) as r:
        d = json.loads(r.read().decode())
    return d if isinstance(d, list) else d.get("rules", [])


def analyze_refs(refs):
    """返回目录质量画像"""
    n = len(refs)
    if n == 0:
        return {"count": 0, "verdict": "EMPTY"}
    nums = [parse_no(c.get("title", "")) for c in refs]
    numbered = [x for x in nums if x is not None]
    parse_rate = len(numbered) / n
    first_no = next((x for x in nums if x is not None), None)
    last_no = next((x for x in reversed(nums) if x is not None), None)
    # 头部倒序块长度（最新章节块特征：开头连续编号严格递减）
    desc_head = 0
    prev = None
    for x in nums:
        if x is None:
            break
        if prev is not None and x >= prev:
            break
        prev = x
        desc_head += 1
        if desc_head > 60:
            break
    # 中段最大缺口（仅在整体升序假定下观察编号跳变）
    gaps = []
    if parse_rate > 0.6:
        seq = [x for x in nums if x is not None]
        for a, b in zip(seq, seq[1:]):
            if b > a and b - a > 20:
                gaps.append((a, b))
    # 前言类标题
    first_title = refs[0].get("title", "")
    prelude = bool(re.match(r"^(序|楔子|前言|引子|Prologue|序章|作品相关|上架感言|完本感言)", first_title))
    verdict = []
    if n < 10:
        verdict.append("TOO_FEW")
    if first_no is not None and first_no > 2 and not prelude:
        verdict.append("NOT_FROM_CH1")
    if prelude:
        verdict.append("PRELUDE_FIRST")
    if desc_head >= 2 and desc_head < n:
        verdict.append(f"DESC_HEAD_{desc_head}")
    if gaps:
        verdict.append("GAP_" + "_".join(f"{a}-{b}" for a, b in gaps[:3]))
    return {"count": n, "parseRate": round(parse_rate, 2), "firstNo": first_no,
            "lastNo": last_no, "descHead": desc_head, "firstTitle": first_title[:40],
            "lastTitle": (refs[-1].get("title") or "")[:40], "gaps": gaps[:3],
            "verdict": ",".join(verdict) if verdict else "OK"}


def probe():
    rules = load_rules()
    enabled = [r for r in rules if r.get("enabled")]
    results = {}
    try:
        results = json.load(open(OUT))
    except Exception:
        pass
    only = sys.argv[1].split(",") if len(sys.argv) > 1 else None
    for r in enabled:
        rid = str(r["id"])
        if only and rid not in only:
            continue
        if rid in results and "error" not in results[rid]:
            continue
        rec = {"name": r.get("name"), "site": r.get("siteUrl")}
        try:
            # 段 1：列表页
            lr = engine_post("/api/test", {"url": r["siteUrl"], "rule": {"listRule": r["listRule"]},
                                           "charset": r.get("charset"), "cookies": r.get("cookies"),
                                           "timeoutMs": LIST_TIMEOUT_MS})
            items = ((lr.get("data") or {}).get("list") or {}).get("items") or []
            rec["listCount"] = len(items)
            if not items:
                rec["error"] = "list empty; warnings=" + "; ".join(lr.get("warnings") or [])[:200]
                results[rid] = rec
                save(results)
                continue
            books = [it["url"] for it in items if it.get("url")][:BOOKS_PER_RULE]
            rec["books"] = []
            for bu in books:
                time.sleep(2)
                br = engine_post("/api/test", {"url": bu, "rule": {"bookRule": r["bookRule"]},
                                               "charset": r.get("charset"), "cookies": r.get("cookies"),
                                               "timeoutMs": BOOK_TIMEOUT_MS})
                book = (br.get("data") or {}).get("book") or {}
                refs = book.get("chapters") or []
                entry = {"url": bu, "title": (book.get("title") or "")[:30],
                         "strategy": br.get("strategy"), "status": br.get("status"),
                         "analysis": analyze_refs(refs),
                         "warnings": [w for w in (br.get("warnings") or []) if "启发" in w or "回退" in w or "分页" in w][:4]}
                rec["books"].append(entry)
                save(results)
        except Exception as e:
            rec["error"] = f"{type(e).__name__}: {e}"[:200]
        results[rid] = rec
        save(results)
    print("PROBE-DONE")


def save(d):
    json.dump(d, open(OUT, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    probe()
