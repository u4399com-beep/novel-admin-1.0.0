#!/usr/bin/env python3
"""
backfill-covers.py —— 全量封面重取驱动（Task 69，用户指令「根据采集任务日志，
重新获取所有在库书籍的封面图」）。

原理：采集任务运行时每本书的源站封面 URL 已落库 Novel.coverSrc（采集日志的
结构化沉淀）。本脚本循环调用 backend 的补抓端点，按 coverSrc 逐本重下封面：

  常规模式（默认）：只补抓「渐变 token 封面 + coverSrc 非空」的书（缺图收敛）；
  --force        ：全量重取——coverSrc 非空的全部书（含已落盘本地封面）强制重下
                    原子覆盖，修正错位/陈旧封面；失败时旧图原样保留不降级。

端点自带护栏：串行下载 + 40s 总预算（WriteTimeout=65s 内必回）+ 网络类失败自动
回退规则代理池（fetchCoverWithFallback）+ afterId 游标分页。本脚本只负责翻页循环。

用法：
  python3 scripts/backfill-covers.py               # 常规补抓（缺图收敛）
  python3 scripts/backfill-covers.py --force       # 全量重取（错位/陈旧修正）
  python3 scripts/backfill-covers.py --limit 50 --sleep 2 --base http://127.0.0.1:3000

退出码：0=跑完（hasMore 收敛）；1=HTTP/网络错误；130=中断。
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def main() -> int:
    ap = argparse.ArgumentParser(description="封面补抓/全量重取驱动")
    ap.add_argument("--base", default="http://127.0.0.1:3000", help="backend 基址")
    ap.add_argument("--force", action="store_true", help="全量重取（默认只补缺图）")
    ap.add_argument("--limit", type=int, default=50, help="单批书数（1-100，缺省 50）")
    ap.add_argument("--sleep", type=float, default=1.5, help="批间休眠秒数")
    ap.add_argument("--proxy", default="", help="主出口代理（缺省直连，失败自动回退规则池）")
    ap.add_argument("--max-rounds", type=int, default=10000, help="安全上限轮数")
    args = ap.parse_args()

    totals = {"attempted": 0, "fixed": 0, "failed": 0, "batches": 0}
    after_id = 0
    mode = "force 全量重取" if args.force else "常规补抓"
    print(f"[backfill-covers] 模式={mode} base={args.base} limit={args.limit}")

    for rnd in range(1, args.max_rounds + 1):
        qs = [f"limit={max(1, min(100, args.limit))}"]
        if args.force:
            qs.append("force=1")
        if after_id > 0:
            qs.append(f"afterId={after_id}")
        if args.proxy:
            qs.append(f"proxy={urllib.parse.quote(args.proxy)}")
        url = f"{args.base}/api/novels/backfill-covers?{'&'.join(qs)}"
        try:
            # 端点为 POST-only（GET 400）
            req = urllib.request.Request(url, data=b"", method="POST")
            with urllib.request.urlopen(req, timeout=70) as resp:
                d = json.loads(resp.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            print(f"[backfill-covers] 轮 {rnd} 请求失败: {e}", file=sys.stderr)
            return 1

        attempted = int(d.get("attempted") or 0)
        fixed = int(d.get("fixed") or 0)
        failed = int(d.get("failed") or 0)
        has_more = bool(d.get("hasMore"))
        next_id = int(d.get("nextAfterId") or 0)
        totals["attempted"] += attempted
        totals["fixed"] += fixed
        totals["failed"] += failed
        totals["batches"] += 1
        fails = d.get("failures") or []
        tail = "; ".join(
            f"#{f.get('id')}:{(f.get('reason') or '')[:40]}" for f in fails[:3]
        )
        print(
            f"[backfill-covers] 轮 {rnd}: attempted={attempted} fixed={fixed} "
            f"failed={failed} nextAfterId={next_id} hasMore={has_more}"
            + (f" | 失败样例: {tail}" if tail else "")
        )

        # 预算截断（attempted=0 且还有候选）：游标不推进，休眠后重试同批
        if attempted == 0:
            if not has_more:
                break
            time.sleep(5.0)
            continue
        if next_id > 0:
            after_id = next_id
        if not has_more:
            break
        time.sleep(args.sleep)

    print(
        f"[backfill-covers] 完成：批数={totals['batches']} attempted={totals['attempted']} "
        f"fixed={totals['fixed']} failed={totals['failed']}"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("[backfill-covers] 中断", file=sys.stderr)
        sys.exit(130)
