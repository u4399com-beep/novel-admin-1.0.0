#!/bin/bash
set -o pipefail
TOKEN=$(cat /tmp/session_token.txt)
AUTH="Authorization: Bearer $TOKEN"
# NextAuth uses cookie, not Bearer — use cookie header
CK="Cookie: next-auth.session-token=$TOKEN"
BASE="http://localhost:3000/api"
T() { date +%s%3N; }
JQ() { python3 -c "import sys,json;$1" 2>/dev/null || echo "ERR"; }

echo "================================================================"
echo "  生产环境模拟审计测试"
echo "================================================================"
echo "Token: ${TOKEN:0:20}..."

# ======== Phase A: LOAD TEST ========
echo -e "\n================================================================"
echo "  阶段A: 负载能力测试"
echo "================================================================"

# A0: Clean old data (do NOT delete non-test data to keep categories)
echo -e "\n[A0] 环境准备..."
# Check existing
echo "  当前数据:"
curl -s -H "$CK" "$BASE/dashboard" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'    小说={d[\"totalNovels\"]}  章节={d[\"totalChapters\"]}  字数={d[\"totalWords\"]:,}  分类={d[\"totalCategories\"]}')
"

# A1: Create 100 novels
echo -e "\n[A1] 创建 100 本小说 (含分类+标签)..."
S=$(T)
# Get 5 category IDs
CATS=$(curl -s -H "$CK" "$BASE/categories" | python3 -c "
import sys,json; cats=json.load(sys.stdin)
ids=[c['id'] for c in cats[:5] if c.get('name','').startswith('负载测试分类')]
if not ids:
    ids=[c['id'] for c in cats[:5]]
print(','.join(ids))
")
# Get 3 tag IDs  
TAGS=$(curl -s -H "$CK" "$BASE/tags" | python3 -c "
import sys,json; tags=json.load(sys.stdin)
if isinstance(tags, list) and len(tags)>=3:
    print(','.join([t['id'] for t in tags[:3]]))
else:
    print(',,,')
" 2>/dev/null)

NOVEL_IDS=""
STATUSES=("ongoing" "completed" "hiatus")
for i in $(seq 1 100); do
  CAT=$(echo "$CATS" | cut -d',' -f$(( (i-1) % 5 + 1 )))
  ST=${STATUSES[$(( (i-1) % 3 ))]}
  TAGS_JSON="[]"
  if [ $((i % 3)) -eq 0 ]; then
    T1=$(echo "$TAGS" | cut -d',' -f1)
    T2=$(echo "$TAGS" | cut -d',' -f2)
    if [ -n "$T1" ] && [ "$T1" != "" ]; then
      TAGS_JSON="[\"$T1\",\"$T2\"]"
    fi
  fi
  RESP=$(curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/novels" \
    -d "{\"title\":\"负载测试小说_${i:03d}\",\"author\":\"测试作者_$(((i-1)/10+1))\",\"description\":\"这是第${i}本负载测试小说，用于验证系统在大数据量下的查询、分页、搜索和筛选性能。\",\"status\":\"$ST\",\"categoryId\":\"$CAT\",\"tags\":$TAGS_JSON}" 2>&1)
  ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERR'))" 2>/dev/null)
  if [ -n "$NOVEL_IDS" ] && [ "$ID" != "ERR" ]; then
    NOVEL_IDS="$NOVEL_IDS,$ID"
  elif [ "$ID" != "ERR" ]; then
    NOVEL_IDS="$ID"
  fi
  if [ $((i % 25)) -eq 0 ]; then echo -n "."; fi
done
E=$(T)
echo -e "\n  100小说写入: $((E-S))ms"
NOVEL_TIME=$((E-S))

# Save first 5 novel IDs
FIRST_NOVELS=$(echo "$NOVEL_IDS" | tr ',' '\n' | head -5 | tr '\n' ',')
echo "$FIRST_NOVELS" > /tmp/test_novel_ids.txt

# A2: Create 50 chapters per novel (5 novels × 50 = 250 chapters)
echo -e "\n[A2] 创建章节 (5本×50章=250章)..."
S=$(T)
TOTAL_CH=0
for NI in $(seq 1 5); do
  NID=$(echo "$FIRST_NOVELS" | cut -d',' -f$NI)
  if [ -z "$NID" ] || [ "$NID" = "ERR" ]; then continue; fi
  for CH in $(seq 1 50); do
    # Generate fake Chinese content (200-800 chars)
    CONTENT=$(python3 -c "
import random; random.seed($NI*1000+$CH)
w='的了在是我有和就不人都一上也很到说要去你会着没有看好自己这他她么什么那这个那个可以已经因为所以但是如果虽然然后或者非常特别比较更加越来越最'
print(''.join(random.choice(w) for _ in range(200+random.randint(0,600))))
" 2>/dev/null)
    curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/novels/$NID/chapters" \
      -d "{\"title\":\"第${CH}章\",\"content\":$(python3 -c "import json;print(json.dumps('$CONTENT'))" 2>/dev/null)}" \
      -o /dev/null 2>&1
    TOTAL_CH=$((TOTAL_CH+1))
  done
  echo -n "."
done
E=$(T)
echo -e "\n  $TOTAL_CH章节写入: $((E-S))ms (avg: $(( (E-S)/TOTAL_CH ))ms/ch)"

# A3: Read performance
echo -e "\n[A3] 查询性能测试..."
echo "  --- 分页 ---"
for P in 1 3 5 8; do
  S=$(T)
  RESP=$(curl -s -H "$CK" "$BASE/novels?page=$P&pageSize=12" 2>&1)
  E=$(T)
  echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ms=$(((int('$E')-int('$S'))))
print(f'  Page $P: {ms}ms  total={d[\"total\"]}  items={len(d[\"novels\"])}')
" 2>/dev/null || echo "  Page $P: ERR"
done

echo "  --- 搜索 ---"
for Q in "负载测试小说_001" "测试作者_03" "大数据量查询" "不存在XYZ"; do
  S=$(T)
  RESP=$(curl -s -H "$CK" "$BASE/novels?search=$Q&pageSize=5" 2>&1)
  E=$(T)
  echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ms=$(((int('$E')-int('$S'))))
print(f'  \"$Q\": {ms}ms  hits={d[\"total\"]}')
" 2>/dev/null || echo "  \"$Q\": ERR"
done

echo "  --- 状态筛选 ---"
for ST in ongoing completed hiatus; do
  S=$(T)
  RESP=$(curl -s -H "$CK" "$BASE/novels?status=$ST&pageSize=100" 2>&1)
  E=$(T)
  echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ms=$(((int('$E')-int('$S'))))
print(f'  $ST: {ms}ms  count={d[\"total\"]}')
" 2>/dev/null || echo "  $ST: ERR"
done

echo "  --- 章节分页 ---"
NID1=$(echo "$FIRST_NOVELS" | cut -d',' -f1)
if [ -n "$NID1" ] && [ "$NID1" != "ERR" ]; then
  for PS in 10 25 50; do
    S=$(T)
    RESP=$(curl -s -H "$CK" "$BASE/novels/$NID1/chapters?pageSize=$PS" 2>&1)
    E=$(T)
    echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ms=$(((int('$E')-int('$S'))))
print(f'  pageSize={PS}: {ms}ms  total={d[\"total\"]}  pages={d[\"totalPages\"]}')
" 2>/dev/null || echo "  pageSize=$PS: ERR"
  done
fi

echo "  --- Dashboard 聚合 ---"
for RUN in 1 2 3 4 5; do
  S=$(T)
  RESP=$(curl -s -H "$CK" "$BASE/dashboard" 2>&1)
  E=$(T)
  echo "$RESP" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ms=$(((int('$E')-int('$S'))))
print(f'  Run $RUN: {ms}ms  novels={d[\"totalNovels\"]}  chapters={d[\"totalChapters\"]}  words={d[\"totalWords\"]:,}  cats={d[\"totalCategories\"]}')
" 2>/dev/null
done

# A4: Edge cases
echo -e "\n[A4] 边界条件测试..."
echo "  --- 超大页码 ---"
curl -s -H "$CK" "$BASE/novels?page=99999&pageSize=12" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  page=99999: items={len(d[\"novels\"])}  total={d[\"total\"]}')
"

echo "  --- 负数页码 ---"
curl -s -H "$CK" "$BASE/novels?page=-1&pageSize=12" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  page=-1: items={len(d[\"novels\"])}  (clamped to 1)')
"

echo "  --- 超大pageSize ---"
curl -s -H "$CK" "$BASE/novels?page=1&pageSize=9999" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  pageSize=9999: items={len(d[\"novels\"])}  (capped to 100)')
"

echo "  --- 空搜索 ---"
curl -s -H "$CK" "$BASE/novels?search=&pageSize=3" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  search=\"\": hits={d[\"total\"]}  (no filter)')
"

echo "  --- 超长搜索 (200+chars) ---"
LONG_Q=$(python3 -c "print('测'*201)")
curl -s -H "$CK" "$BASE/novels?search=$LONG_Q&pageSize=3" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  search=201chars: hits={d[\"total\"]}  (truncated to 200)')
"

# ======== Phase B: SCRAPE SYSTEM ========
echo -e "\n================================================================"
echo "  阶段B: 采集系统测试"
echo "================================================================"

# B1: Create scrape rule
echo -e "\n[B1] 创建采集规则..."
S=$(T)
RULE_RESP=$(curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/scrape-rules" \
  -d "{
    \"name\": \"测试采集规则_笔趣阁\",
    \"description\": \"用于测试的采集规则\",
    \"listUrl\": \"https://www.example-biquge.com/sort/1/\",
    \"listSelector\": {\"type\":\"css\",\"value\":\".novelslist .item\"},
    \"bookTitleSelector\": \".bookname\",
    \"bookAuthorSelector\": \".author\",
    \"bookDescriptionSelector\": \".intro\",
    \"bookCoverSelector\": \".cover img\",
    \"chapterListSelector\": {\"type\":\"css\",\"value\":\"#chapterlist li a\"},
    \"chapterTitleSelector\": {\"type\":\"css\",\"value\":\"text\"},
    \"chapterLinkSelector\": {\"type\":\"css\",\"value\":\"href\"},
    \"contentSelector\": {\"type\":\"css\",\"value\":\"#content\"},
    \"scrapeMode\": \"incremental\",
    \"threadCount\": 3,
    \"minDelay\": 1000,
    \"maxDelay\": 3000,
    \"dedupMode\": \"url\",
    \"enabled\": true
  }" 2>&1)
E=$(T)
RULE_ID=$(echo "$RULE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERR'))" 2>/dev/null)
echo "  创建规则: $((E-S))ms  ID=$RULE_ID"

# B2: Get rules list
echo -e "\n[B2] 查询规则列表..."
curl -s -H "$CK" "$BASE/scrape-rules?pageSize=5" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  规则数: {d[\"total\"]}')
for r in d.get('rules',[])[:3]:
    print(f'    - {r[\"name\"]} (enabled={r[\"enabled\"]} tasks={r[\"_count\"][\"tasks\"]})')
"

# B3: Create scrape task
echo -e "\n[B3] 创建采集任务..."
if [ -n "$RULE_ID" ] && [ "$RULE_ID" != "ERR" ]; then
  TASK_RESP=$(curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/scrape-tasks" \
    -d "{\"ruleId\":\"$RULE_ID\",\"mode\":\"full\"}" 2>&1)
  TASK_ID=$(echo "$TASK_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERR'))" 2>/dev/null)
  echo "  任务ID: $TASK_ID"
  echo "$TASK_ID" > /tmp/test_task_id.txt
  
  # B4: Get task list
  echo -e "\n[B4] 查询任务列表..."
  curl -s -H "$CK" "$BASE/scrape-tasks?pageSize=10" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  任务数: {d[\"total\"]}')
for t in d.get('tasks',[])[:3]:
    print(f'    - {t[\"rule\"][\"name\"]} status={t[\"status\"]} mode={t[\"mode\"]}')
"
else
  echo "  SKIP: 规则创建失败"
fi

# B5: SSRF protection test on scraper service
echo -e "\n[B5] Scraper SSRF 防护测试..."
echo "  --- 内网IP localhost ---"
curl -s -X POST "http://localhost:3099/scrape/list" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1:3000/api/health","selector":{"type":"css","value":"body"}}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_error = 'error' in d or 'message' in d
print(f'  127.0.0.1: {\"BLOCKED ✅\" if has_error else \"ALLOWED ❌\"}  resp={list(d.keys())}')
"

echo "  --- 内网IP 192.168.x ---"
curl -s -X POST "http://localhost:3099/scrape/list" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://192.168.1.1/admin","selector":{"type":"css","value":"body"}}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_error = 'error' in d or 'message' in d
print(f'  192.168.1.1: {\"BLOCKED ✅\" if has_error else \"ALLOWED ❌\"}')
"

echo "  --- 内网IP 10.x ---"
curl -s -X POST "http://localhost:3099/scrape/list" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://10.0.0.1/secret","selector":{"type":"css","value":"body"}}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_error = 'error' in d or 'message' in d
print(f'  10.0.0.1: {\"BLOCKED ✅\" if has_error else \"ALLOWED ❌\"}')
"

echo "  --- file:// 协议 ---"
curl -s -X POST "http://localhost:3099/scrape/list" \
  -H "Content-Type: application/json" \
  -d '{"url":"file:///etc/passwd","selector":{"type":"css","value":"body"}}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_error = 'error' in d or 'message' in d
print(f'  file://: {\"BLOCKED ✅\" if has_error else \"ALLOWED ❌\"}')
"

echo "  --- javascript: 协议 ---"
curl -s -X POST "http://localhost:3099/scrape/list" \
  -H "Content-Type: application/json" \
  -d '{"url":"javascript:alert(1)","selector":{"type":"css","value":"body"}}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_error = 'error' in d or 'message' in d
print(f'  javascript:: {\"BLOCKED ✅\" if has_error else \"ALLOWED ❌\"}')
"

# B6: Path traversal test for download-cover
echo -e "\n[B6] 路径穿越防护测试..."
curl -s -X POST "http://localhost:3099/download-cover" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/img.jpg","savePath":"/etc/cron.d/malicious.webp"}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_error = 'error' in d or 'message' in d
print(f'  /etc/cron.d: {\"BLOCKED ✅\" if has_error else \"ALLOWED ❌\"}  resp={list(d.keys())}')
"

curl -s -X POST "http://localhost:3099/download-cover" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/img.jpg","savePath":"/app/public/covers/../../../etc/passwd.webp"}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_error = 'error' in d or 'message' in d
print(f'  ../穿越: {\"BLOCKED ✅\" if has_error else \"ALLOWED ❌\"}')
"

curl -s -X POST "http://localhost:3099/download-cover" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/img.jpg","savePath":"/app/public/covers/test.png"}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_error = 'error' in d or 'message' in d
print(f'  .png扩展名: {\"BLOCKED ✅\" if has_error else \"ALLOWED ❌\"}  (must be .webp)')
"

# B7: Scraper CORS test
echo -e "\n[B7] Scraper CORS 测试..."
ORIGIN_HEADER=$(curl -sI -X OPTIONS -H "Origin: https://evil-site.com" -H "Access-Control-Request-Method: POST" "http://localhost:3099/scrape/list" 2>&1 | rg -i "access-control-allow-origin" || echo "NOT SET")
echo "  Origin=evil-site.com: $ORIGIN_HEADER"

# B8: Clean content test
echo -e "\n[B8] 内容清洗测试..."
CLEAN_RESP=$(curl -s -X POST "http://localhost:3099/clean" \
  -H "Content-Type: application/json" \
  -d '{"html":"<p>正文内容</p><script>alert(1)</script><!-- 广告 -->广告文字<a href=\"http://ad.com\">链接</a>","config":{"removeScripts":true,"removeComments":true,"removeAds":true}}' 2>&1)
echo "$CLEAN_RESP" | python3 -c "
import sys,json; d=json.load(sys.stdin)
has_script = '<script' in d.get('content','')
has_comment = '<!--' in d.get('content','')
has_ad = '广告文字' in d.get('content','')
print(f'  原始: <p>正文</p><script>...</script><!-- 广告 -->广告文字<a>链接</a>')
print(f'  清洗后: {d.get(\"content\",\"\")[:80]}...')
print(f'  script移除: {\"❌ 未移除\" if has_script else \"✅ 已移除\"}')
print(f'  注释移除: {\"❌ 未移除\" if has_comment else \"✅ 已移除\"}')
print(f'  广告移除: {\"❌ 未移除\" if has_ad else \"✅ 已移除\"}')
print(f'  字数: {d.get(\"wordCount\",0)}')
"

# ======== Phase C: SITE CLUSTER ========
echo -e "\n================================================================"
echo "  阶段C: 站群系统测试"
echo "================================================================"

# C1: Create theme
echo -e "\n[C1] 创建主题..."
THEME_RESP=$(curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/themes" \
  -d "{
    \"name\": \"暗黑主题\",
    \"description\": \"深色背景的阅读主题，适合夜间阅读\",
    \"identifier\": \"dark-reading-theme\",
    \"config\": {\"primaryColor\":\"#8b5cf6\",\"bgColor\":\"#1a1a2e\",\"textColor\":\"#e2e8f0\",\"fontSize\":\"18px\"},
    \"enabled\": true
  }" 2>&1)
THEME_ID=$(echo "$THEME_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERR'))" 2>/dev/null)
echo "  暗黑主题: ID=$THEME_ID"

THEME2_RESP=$(curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/themes" \
  -d "{
    \"name\": \"清新主题\",
    \"description\": \"浅色清新风格\",
    \"identifier\": \"fresh-light-theme\",
    \"config\": {\"primaryColor\":\"#22c55e\",\"bgColor\":\"#f0fdf4\",\"textColor\":\"#1a2e1a\",\"fontSize\":\"16px\"},
    \"enabled\": true
  }" 2>&1)
THEME2_ID=$(echo "$THEME2_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERR'))" 2>/dev/null)
echo "  清新主题: ID=$THEME2_ID"

# C2: Create sites with themes
echo -e "\n[C2] 创建站点 (3个)..."
SITES_DATA=(
  "novel-reading.com|小说阅读网|领先的在线小说阅读平台"
  "book-download.net|电子书下载|海量电子书免费下载"
  "story-hub.cn|故事集|原创文学社区"
)

for SD in "${SITES_DATA[@]}"; do
  IFS='|' read -r DOMAIN NAME DESC <<< "$SD"
  SITE_RESP=$(curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/sites" \
    -d "{
      \"domain\": \"$DOMAIN\",
      \"name\": \"$NAME\",
      \"description\": \"$DESC\",
      \"themeId\": \"$THEME_ID\",
      \"enabled\": true,
      \"siteTitle\": \"$NAME - 海量小说免费阅读\",
      \"siteDescription\": \"$DESC，提供最新最全的网络小说阅读体验\",
      \"siteKeywords\": \"小说,阅读,在线阅读,免费小说,网络小说\",
      \"novelOffset\": 0,
      \"chapterOffset\": 0
    }" 2>&1)
  SITE_ID=$(echo "$SITE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERR'))" 2>/dev/null)
  echo "  $DOMAIN: ID=$SITE_ID"
done

# C3: List sites
echo -e "\n[C3] 查询站点列表..."
curl -s -H "$CK" "$BASE/sites" | python3 -c "
import sys,json; sites=json.load(sys.stdin)
print(f'  站点数: {len(sites)}')
for s in sites:
    t = s.get('theme',{})
    print(f'    - {s[\"domain\"]} → {t.get(\"name\",\"无主题\")} (enabled={s[\"enabled\"]})')
"

# C4: Site validation tests
echo -e "\n[C4] 站点输入验证..."
echo "  --- 空域名 ---"
curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/sites" \
  -d '{"name":"test","domain":"","description":"test"}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  空域名: {\"400 ✅\" if d.get(\"error\") else \"FAIL ❌\"}  {d}')
"

echo "  --- 超长域名 (501 chars) ---"
LONG_D=$(python3 -c "print('a'*501)")
curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/sites" \
  -d "{\"name\":\"t\",\"domain\":\"$LONG_D\"}" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  超长域名: {\"400 ✅\" if d.get(\"error\") else \"FAIL ❌\"}  {d.get(\"error\",d)[:40]}')
"

echo "  --- 不存在的主题ID ---"
curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/sites" \
  -d '{"name":"t","domain":"test.invalid","themeId":"nonexistent-id"}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  无效主题: {\"400 ✅\" if d.get(\"error\") else \"FAIL ❌\"}  {d.get(\"error\",d)[:40]}')
"

# C5: Download configs
echo -e "\n[C5] 下载配置测试..."
DC_RESP=$(curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/download-configs" \
  -d "{
    \"name\": \"标准TXT下载\",
    \"format\": \"txt\",
    \"insertConfusion\": true,
    \"confusionText\": \"本章未完，请翻页阅读更多精彩内容\",
    \"insertAd\": true,
    \"adContent\": \"【广告】推荐阅读最新热门小说\",
    \"adInterval\": 50,
    \"adPosition\": \"middle\",
    \"insertSiteInfo\": true,
    \"siteInfoContent\": \"本文来自小说阅读网\",
    \"fileNamePattern\": \"{title} - {author}\"
  }" 2>&1)
DC_ID=$(echo "$DC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','ERR'))" 2>/dev/null)
echo "  标准TXT配置: ID=$DC_ID"

# Validation: invalid format
echo "  --- 无效格式 ---"
curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/download-configs" \
  -d '{"name":"t","format":"pdf"}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  format=pdf: {\"400 ✅\" if d.get(\"error\") else \"FAIL ❌\"}  {d.get(\"error\",d)[:40]}')
"

# Validation: adInterval out of range
echo "  --- adInterval=0 ---"
curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/download-configs" \
  -d '{"name":"t","format":"txt","adInterval":0}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  interval=0: {\"400 ✅\" if d.get(\"error\") else \"FAIL ❌\"}  {d.get(\"error\",d)[:40]}')
"

echo "  --- adInterval=2000 ---"
curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/download-configs" \
  -d '{"name":"t","format":"txt","adInterval":2000}' | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  interval=2000: {\"400 ✅\" if d.get(\"error\") else \"FAIL ❌\"}  {d.get(\"error\",d)[:40]}')
"

echo "  --- 超长混淆文本 (5001 chars) ---"
curl -s -H "$CK" -H "Content-Type: application/json" -X POST "$BASE/download-configs" \
  -d "{\"name\":\"t\",\"format\":\"txt\",\"insertConfusion\":true,\"confusionText\":\"$(python3 -c "print('x'*5001)")\"}" | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  5001 chars: {\"400 ✅\" if d.get(\"error\") else \"FAIL ❌\"}  {d.get(\"error\",d)[:40]}')
"

# ======== SUMMARY ========
echo -e "\n================================================================"
echo "  测试完成！最终数据状态:"
echo "================================================================"
curl -s -H "$CK" "$BASE/dashboard" 2>&1 | python3 -c "
import sys,json; d=json.load(sys.stdin)
print(f'  小说: {d[\"totalNovels\"]}')
print(f'  章节: {d[\"totalChapters\"]}')
print(f'  总字数: {d[\"totalWords\"]:,}')
print(f'  分类: {d[\"totalCategories\"]}')
print(f'  状态分布: {d[\"statusDistribution\"]}')
"