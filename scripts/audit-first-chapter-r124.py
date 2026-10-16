#!/usr/bin/env python3
"""R124: 全库首章审计——直接回答「有多少书籍不是从第一章开始」。

对库内每本有章节的书：取 idx 升序全章，解析首个编号章节的序号：
  - firstNo <= 2 或前言类标题（序/楔子/前言/引子） → OK
  - firstNo > 2 → NOT_FROM_CH1（记录规则来源、章数、首章标题）
另统计每书头部 12 章的编号形态（区分「从最新章开始」vs「缺前置」）。

用法：python3 scripts/audit-first-chapter-r124.py [输出文件]
"""
import json, re, sys, time, urllib.request

BASE = "http://127.0.0.1:3000"
CN = "零〇一二两三四五六七八九十百千万"
RE_NO = re.compile(r"^第\s*([0-9０-９]{1,7}|[%s]{1,12})\s*[章节回话]" % CN)
# R124b: 与 backend-go parseChapterNo 同族的纯数字前缀形态（"123."/"123、"/"1 丶"/"001章"）——
# 源站章名前缀格式多样，旧版只认 第N章 导致大量首章为 1 的书被误报 NOT_FROM_CH1
RE_PREFIX = re.compile(r"^([0-9０-９]{1,5})\s*[.、丶]\s*\S")
RE_PLAIN_CH = re.compile(r"^([0-9０-９]{1,5})\s*章")
RE_PRELUDE = re.compile(r"^(序章?|楔子|前言|引子|Prologue|作品相关|内容简介|上架感言|完本感言|终章|尾声|番外)", re.I)


def cn2int(s):
    if re.fullmatch(r"[0-9０-９]+", s):
        return int(s.translate(str.maketrans("０１２３４５６７８９", "0123456789")))
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
    t = (title or "").strip()
    m = RE_NO.match(t)
    if m:
        try:
            v = cn2int(m.group(1))
            return v if 0 <= v < 99_999_999 else None
        except Exception:
            return None
    m = RE_PREFIX.match(t) or RE_PLAIN_CH.match(t)
    if m:
        return int(m.group(1).translate(str.maketrans("０１２３４５６７８９", "0123456789")))
    return None


def get_json(path, timeout=30):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read().decode())


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/first-chapter-audit.json"
    novels = get_json("/api/novels?page=1&pageSize=5000")
    items = novels.get("items") or novels.get("list") or novels.get("data") or []
    if isinstance(novels, list):
        items = novels
    report = {"scanned": 0, "ok": 0, "notFromCh1": [], "noChapters": 0, "noSignal": []}
    for n in items:
        nid = n.get("id")
        cc = n.get("chapterCount") or 0
        if not cc:
            report["noChapters"] += 1
            continue
        try:
            ch = get_json(f"/api/novels/{nid}/chapters", timeout=30)
        except Exception as e:
            continue
        rows = ch if isinstance(ch, list) else (ch.get("chapters") or ch.get("list") or ch.get("data") or [])
        if not rows:
            report["noChapters"] += 1
            continue
        report["scanned"] += 1
        first = rows[0]
        first_title = first.get("title") or ""
        no = parse_no(first_title)
        # 首章无编号时再看前 3 章（前言/卷名开头算 OK）
        if no is None:
            if RE_PRELUDE.match(first_title.strip()) or any(parse_no(r.get("title")) == 1 for r in rows[:3]):
                report["ok"] += 1
            else:
                report["noSignal"].append({"id": nid, "title": n.get("title"), "chapters": cc,
                                           "firstTitles": [r.get("title", "")[:20] for r in rows[:3]]})
            continue
        if no <= 2:
            report["ok"] += 1
        else:
            # 头部形态画像
            head = [parse_no(r.get("title")) for r in rows[:12]]
            desc_head = all(head[i] is not None and head[i + 1] is not None and head[i] > head[i + 1] for i in range(len(head) - 1)) if len(head) > 1 else False
            report["notFromCh1"].append({
                "id": nid, "title": n.get("title"), "chapters": cc,
                "firstNo": no, "firstTitle": first_title[:30],
                "descHead": desc_head,
                "headNums": [h for h in head if h is not None][:8],
            })
    json.dump(report, open(out_path, "w"), ensure_ascii=False, indent=1)
    print(f"scanned={report['scanned']} ok={report['ok']} notFromCh1={len(report['notFromCh1'])} "
          f"noSignal={len(report['noSignal'])} noChapters={report['noChapters']}")


if __name__ == "__main__":
    main()
