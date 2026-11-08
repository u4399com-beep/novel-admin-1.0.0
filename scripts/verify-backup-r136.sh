#!/usr/bin/env bash
# verify-backup-r136.sh —— P1 运维整改（R136）：备份恢复演练（verify，非假设）。
#
# 三级验证：
#   L1 完整性：PRAGMA integrity_check（备份文件不是撕裂副本）
#   L2 一致性：关键表行数与活库比对（快照允许略旧——差值打印不判 FAIL，
#      但活库为 0 表缺列/文件损坏 → FAIL）
#   L3 可服务性：restore 库拉起临时 backend 实例（BACKEND_MODE=api 不触发 runner/
#      fleetkeeper 写入），/api/health dbOk:true + /api/novels 200 → 可用性实证
#
# 用法：bash scripts/verify-backup-r136.sh [snapshot.db]
#   无参 = 自动取 $BACKUP_DIR（默认 db/backups）最新 custom-*.db
# 退出码：0=PASS 1=FAIL
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
DB_LIVE="${DB_PATH:-$REPO/db/custom.db}"
BK_DIR="${BACKUP_DIR:-$(dirname "$DB_LIVE")/backups}"
SNAP="${1:-}"
PORT_TEST="${PORT_TEST:-3444}"
WORK=/tmp/restore-drill.$$
PASS=1

say() { echo "[drill] $*"; }
fail() { say "FAIL: $*"; PASS=0; }

trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK"

# ---- 选快照（兼容 R135 novel-* 与早期 custom-* 命名） ----
if [ -z "$SNAP" ]; then
  SNAP=$( { ls -1 "$BK_DIR"/novel-*.db 2>/dev/null; ls -1 "$BK_DIR"/custom-*.db 2>/dev/null; } | sort | tail -1)
fi
[ -n "$SNAP" ] && [ -f "$SNAP" ] || { say "FAIL: 无快照可验（$BK_DIR/custom-*.db）"; exit 1; }
say "快照: $SNAP ($(stat -c%s "$SNAP") bytes, $(stat -c%y "$SNAP" | cut -d. -f1))"
# 半成品防误检：R136 起 backupx.go 先写 .tmp 再原子改名，此处校验无 .tmp 残留
ls "$BK_DIR"/*.tmp >/dev/null 2>&1 && say "注意: 发现 .tmp 半成品（异常态，正常应为 0 个）" || say "无 .tmp 半成品 ✓"

# ---- L1 完整性 ----
cp "$SNAP" "$WORK/restore.db"
L1=$(python3 -c "
import sqlite3
con=sqlite3.connect('$WORK/restore.db')
print(con.execute('PRAGMA integrity_check').fetchone()[0])")
[ "$L1" = "ok" ] && say "L1 integrity_check: ok" || fail "L1 integrity_check=$L1"

# ---- L2 一致性（关键表行数比对，允许快照滞后） ----
python3 - "$WORK/restore.db" "$DB_LIVE" <<'PYEOF' || PASS=0
import sqlite3, sys
tables = ["ScrapeRule", "ScrapeTask", "Novel", "Chapter", "ChapterContent"]
snap = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=3)
live = sqlite3.connect(f"file:{sys.argv[2]}?mode=ro", uri=True, timeout=3)
bad = 0
for t in tables:
    def cnt(con, name):
        try:
            return con.execute(f'select count(*) from "{name}"').fetchone()[0]
        except Exception as e:
            return f"ERR:{e}"
    s, l = cnt(snap, t), cnt(live, t)
    flag = "OK" if (isinstance(s, int) and isinstance(l, int) and s <= l) else "CHECK"
    if flag != "OK":
        bad += 1
    print(f"[drill] L2 {t}: snapshot={s} live={l} [{flag}]")
sys.exit(1 if bad else 0)
PYEOF

# ---- L3 可服务性（restore 库起临时 api 实例） ----
BIN="$REPO/mini-services/backend-go/backend-go.bin"
[ -x "$BIN" ] || BIN="$REPO/mini-services/backend-go/bin/backend-go"
[ -x "$BIN" ] || { say "FAIL: backend 二进制不可用"; exit 1; }
env BACKEND_PORT=$PORT_TEST BACKEND_MODE=api DB_PATH="$WORK/restore.db" FLEETKEEPER_OFF=1 \
  "$BIN" >"$WORK/api.log" 2>&1 &
API_PID=$!
OK3=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  H=$(curl -s -m 2 "http://localhost:$PORT_TEST/api/health" 2>/dev/null)
  echo "$H" | grep -q '"dbOk":true' && { OK3=1; break; }
done
if [ "$OK3" = "1" ]; then
  CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://localhost:$PORT_TEST/api/novels?page=1&pageSize=5" 2>/dev/null)
  [ "$CODE" = "200" ] && say "L3 restore 实例: health dbOk + /api/novels 200" || fail "L3 /api/novels=$CODE"
else
  fail "L3 restore 实例 health 未就绪（tail: $(tail -2 "$WORK/api.log" | tr '\n' ' ')）"
fi
kill "$API_PID" 2>/dev/null; wait "$API_PID" 2>/dev/null

[ "$PASS" = "1" ] && { say "=== 恢复演练 PASS ==="; exit 0; }
say "=== 恢复演练 FAIL ==="; exit 1
