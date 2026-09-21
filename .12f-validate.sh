#!/bin/bash
# Task 12-f single-session validation: dev server must live inside this bash session.
cd /home/z/my-project
OUT=/home/z/my-project/.12f-validation.txt
: > $OUT

log(){ echo "$@" | tee -a $OUT; }

# ---------- 1. start dev server ----------
setsid nohup bun run dev >> /tmp/devserver-12f.log 2>&1 < /dev/null & disown
UP=0
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:3000/api/settings" 2>/dev/null)
  if [ "$code" = "200" ]; then UP=1; break; fi
  sleep 2
done
if [ "$UP" != "1" ]; then log "FATAL: dev server did not come up"; exit 1; fi
log "dev server UP"

# ---------- 2. pick a book with chapters ----------
python3 - <<'PYEOF' > /home/z/my-project/.12f-pick.json
import json, urllib.request
def get(u):
    return json.load(urllib.request.urlopen(u, timeout=20))
pick=None
for page in [1,2]:
    d=get(f"http://localhost:3000/api/novels?page={page}&pageSize=20")
    for n in d.get('list',[]):
        if n.get('totalChapters',0) and n.get('firstChapterId'):
            pick=n; break
    if pick: break
if not pick:
    print(json.dumps({"bookId":0}))
    raise SystemExit
chapters=get(f"http://localhost:3000/api/novels/{pick['id']}/chapters")
ch = chapters[0] if isinstance(chapters,list) and chapters else None
print(json.dumps({
  "bookId": pick["id"],
  "title": pick["title"],
  "author": pick["author"],
  "chapterId": ch["id"] if ch else None,
  "chapterTitle": ch["title"] if ch else "",
}, ensure_ascii=False))
PYEOF
cat /home/z/my-project/.12f-pick.json >> $OUT 2>/dev/null
log ""
BOOK_TITLE=$(python3 -c "import json;print(json.load(open('/home/z/my-project/.12f-pick.json')).get('title',''))")
CHAP_ID=$(python3 -c "import json;print(json.load(open('/home/z/my-project/.12f-pick.json')).get('chapterId') or 0)")
if [ "$CHAP_ID" = "0" ]; then log "WARN: no chapter found, chapter-page test will be skipped/limited"; fi

AB="agent-browser"
$AB --session val12f close >/dev/null 2>&1

# ---------- 3. per-theme validation ----------
for THEME in huangjinwu ggd66 x2552 trxsw shipsay; do
  log "=== THEME: $THEME ==="
  curl -s -o /dev/null -X PATCH "http://localhost:3000/api/settings" -H 'Content-Type: application/json' -d "{\"activeTheme\":\"$THEME\"}"
  $AB --session val12f open "http://localhost:3000/" --timeout 45000 >> $OUT 2>&1
  $AB --session val12f wait --load networkidle >> $OUT 2>&1
  sleep 1
  ERRS=$($AB --session val12f errors 2>&1 | grep -v -i "no page errors" | head -5)
  CERR=$($AB --session val12f console 2>&1 | grep -iE "error" | grep -viE "error log is empty|no errors" | head -5)
  log "[$THEME] home pageErrors: ${ERRS:-none} | consoleErrors: ${CERR:-none}"
  $AB --session val12f set viewport 375 812 >/dev/null 2>&1
  OV_HOME=$($AB --session val12f eval "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth" 2>&1 | tail -1)
  log "[$THEME] home 375px overflow: $OV_HOME"
  $AB --session val12f set viewport 1280 900 >/dev/null 2>&1
  # book page
  $AB --session val12f find text "$BOOK_TITLE" click >> $OUT 2>&1
  $AB --session val12f wait --load networkidle >> $OUT 2>&1
  sleep 1
  BERRS=$($AB --session val12f errors 2>&1 | grep -v -i "no page errors" | head -5)
  log "[$THEME] book pageErrors: ${BERRS:-none}"
  $AB --session val12f set viewport 375 812 >/dev/null 2>&1
  OV_BOOK=$($AB --session val12f eval "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth" 2>&1 | tail -1)
  log "[$THEME] book 375px overflow: $OV_BOOK"
  $AB --session val12f set viewport 1280 900 >/dev/null 2>&1
  # chapter page
  if [ "$CHAP_ID" != "0" ]; then
    CLICKED=0
    for label in "开始阅读" "全文阅读" "继续阅读" "查看目录" "完整目录页" "章节目录"; do
      if $AB --session val12f find text "$label" click >/dev/null 2>&1; then CLICKED=1; break; fi
    done
    $AB --session val12f wait --load networkidle >> $OUT 2>&1
    sleep 1
    CERRS=$($AB --session val12f errors 2>&1 | grep -v -i "no page errors" | head -5)
    log "[$THEME] after-read-click pageErrors: ${CERRS:-none} (clicked:$CLICKED)"
    $AB --session val12f set viewport 375 812 >/dev/null 2>&1
    OV_CH=$($AB --session val12f eval "Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth" 2>&1 | tail -1)
    log "[$THEME] reader 375px overflow: $OV_CH"
    $AB --session val12f set viewport 1280 900 >/dev/null 2>&1
  fi
done

log "=== ALL THEMES DONE ==="
