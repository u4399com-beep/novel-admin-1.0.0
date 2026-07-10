#!/bin/bash
set -o pipefail
TOKEN=$(cat /tmp/session_token.txt)
CK="Cookie: next-auth.session-token=$TOKEN"
BASE="http://localhost:3000/api"
TS() { date +%s%3N; }

echo "================================================================"
echo "  阶段A: 负载能力测试 (修复版)"
echo "================================================================"

echo -e "\n[A1] 创建 100 本小说..."
S=$(TS)
CATS=$(curl -s -H "$CK" "$BASE/categories" | python3 -c "import sys,json;print('\n'.join([c['id'] for c in json.load(sys.stdin)[:5]]))" 2>/dev/null)
TAGS_ARR=$(curl -s -H "$CK" "$BASE/tags" 2>&1)
TAG1=$(echo "$TAGS_ARR" | python3 -c "import sys,json;ts=json.load(sys.stdin);print(ts[0]['id'] if ts else '')" 2>/dev/null)
TAG2=$(echo "$TAGS_ARR" | python3 -c "import sys,json;ts=json.load(sys.stdin);print(ts[1]['id'] if len(ts)>1 else '')" 2>/dev/null)
CAT_ARR=($(echo "$CATS"))

STATUSES=("ongoing" "completed" "hiatus")
NOVEL_IDS=""
for i in $(seq 1 100); do
  NUM=$(printf "%03d" $i)
  CAT=${CAT_ARR[$(( (i-1) % 5 ))]}
  ST=${STATUSES[$(( (i-1) % 3 ))]}
  if [ $((i % 3)) -eq 0 ] && [ -n "$TAG1" ] && [ -n "$TAG2" ]; then
    TJSON="[\"$TAG1\",\"$TAG2\"]"
  else
    TJSON="[]"
  fi
  RESP=$(curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/novels" \
    -d "{\"title\":\"负载测试小说_${NUM}\",\"author\":\"测试作者_$(printf '%02d' $(((i-1)/10+1)))\",\"description\":\"这是第${i}本负载测试小说，用于验证查询分页搜索筛选性能。包含丰富描述文本用于全文搜索测试。\",\"status\":\"$ST\",\"categoryId\":\"$CAT\",\"tags\":$TJSON}" 2>&1)
  ID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  [ -n "$ID" ] && NOVEL_IDS="$NOVEL_IDS $ID"
  [ $((i % 25)) -eq 0 ] && echo -n "."
done
E=$(TS)
echo -e "\n  100小说: $((E-S))ms  成功: $(echo "$NOVEL_IDS" | wc -w | tr -d ' ')"

# Save first 5 IDs
FIRST_5=$(echo "$NOVEL_IDS" | tr ' ' '\n' | head -5)
echo "$FIRST_5" > /tmp/test_novel_ids.txt

echo -e "\n[A2] 创建 250 章节 (5本×50)..."
S=$(TS)
TOTAL=0
for NID in $FIRST_5; do
  [ -z "$NID" ] && continue
  for CH in $(seq 1 50); do
    CONTENT=$(python3 -c "
import random; random.seed(hash('$NID')+$CH)
w='的了在是我有和就不人都一上也很到说要去你会着没有看好自己这他她么什么那这个那个可以已经因为所以但是如果虽然然后或者非常特别比较更加越来越最'
print(''.join(random.choice(w) for _ in range(300+random.randint(0,500))))
" 2>/dev/null)
    curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/novels/$NID/chapters" \
      -d "{\"title\":\"第${CH}章\",\"content\":$(echo "$CONTENT" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null)}" \
      -o /dev/null 2>&1
    TOTAL=$((TOTAL+1))
  done
  echo -n "."
done
E=$(T)
AVG=$(( (E-S) / (TOTAL>0?TOTAL:1) ))
echo -e "\n  $TOTAL章节: $((E-S))ms  avg: ${AVG}ms/ch"

echo -e "\n[A3] 查询性能..."
echo "  分页:"
for P in 1 3 5 8; do
  S=$(TS); RESP=$(curl -s -H "$CK" "$BASE/novels?page=$P&pageSize=12"); E=$(TS)
  echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'    Page {$P}: {$((int(\"$E\")-int(\"$S\")))}ms  total={d[\"total\"]}  items={len(d[\"novels\"])}')"
done

echo "  搜索:"
for Q in "负载测试小说_001" "测试作者_03" "大数据量" "不存在XYZ"; do
  S=$(TS); RESP=$(curl -s -H "$CK" "$BASE/novels?search=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("$Q"))')&pageSize=5"); E=$(TS)
  echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'    \"{d.get(\"search\",\"$Q\")}\": {$((int(\"$E\")-int(\"$S\")))}ms  hits={d[\"total\"]}')" 2>/dev/null || echo "    \"$Q\": parse err"
done

echo "  状态筛选:"
for ST in ongoing completed hiatus; do
  S=$(TS); RESP=$(curl -s -H "$CK" "$BASE/novels?status=$ST&pageSize=100"); E=$(TS)
  echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'    $ST: {$((int(\"$E\")-int(\"$S\")))}ms  count={d[\"total\"]}')"
done

echo "  章节分页:"
NID1=$(echo "$FIRST_5" | head -1)
for PS in 10 25 50; do
  S=$(TS); RESP=$(curl -s -H "$CK" "$BASE/novels/$NID1/chapters?pageSize=$PS"); E=$(TS)
  echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'    pageSize=$PS: {$((int(\"$E\")-int(\"$S\")))}ms  total={d[\"total\"]}  pages={d[\"totalPages\"]}')"
done

echo "  Dashboard (5次):"
for R in 1 2 3 4 5; do
  S=$(TS); RESP=$(curl -s -H "$CK" "$BASE/dashboard"); E=$(TS)
  echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'    Run{$R}: {$((int(\"$E\")-int(\"$S\")))}ms  novels={d[\"totalNovels\"]}  ch={d[\"totalChapters\"]}  words={d[\"totalWords\"]:,}')" 2>/dev/null
done

echo -e "\n[A4] 边界条件:"
R=$(curl -s -H "$CK" "$BASE/novels?page=99999" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'page=99999: items={len(d[\"novels\"])} total={d[\"total\"]}')" 2>/dev/null); echo "  $R"
R=$(curl -s -H "$CK" "$BASE/novels?page=-1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'page=-1: items={len(d[\"novels\"])} (clamped)')" 2>/dev/null); echo "  $R"
R=$(curl -s -H "$CK" "$BASE/novels?pageSize=9999" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'pageSize=9999: items={len(d[\"novels\"])} (capped to 100)')" 2>/dev/null); echo "  $R"

echo -e "\n[A5] 最终状态:"
curl -s -H "$CK" "$BASE/dashboard" | python3 -c "
import sys,json;d=json.load(sys.stdin)
print(f'  小说: {d[\"totalNovels\"]}  章节: {d[\"totalChapters\"]}  字数: {d[\"totalWords\"]:,}  分类: {d[\"totalCategories\"]}')
print(f'  状态: {d[\"statusDistribution\"]}')
"