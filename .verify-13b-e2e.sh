#!/bin/bash
# 13-b 端到端验证：本地假站 + SCRAPER_ALLOW_PRIVATE=1 引擎实例，验证 single 全管线
cd /home/z/my-project

echo "===== S0: tsc + lint ====="
bunx tsc --noEmit 2>&1 | head -10; echo "tsc exit=$?"
bun run lint 2>&1 | tail -3; echo "lint exit=$?"

# ---- 启动假站 / 引擎(允许私网) / 主站 ----
(setsid nohup bun .tmp-fake-site.ts </dev/null >/tmp/fake-site.log 2>&1 &)
(cd /home/z/my-project/mini-services/scraper-service && SCRAPER_ALLOW_PRIVATE=1 setsid nohup bun run dev </dev/null >/tmp/scraper.log 2>&1 &)
(setsid nohup bun run dev </dev/null >/dev/null 2>&1 &)

for i in $(seq 1 20); do curl -s -m 2 http://127.0.0.1:3999/book/1 >/dev/null 2>&1 && { echo "[boot] fake-site up"; break; }; sleep 1; done
for i in $(seq 1 20); do curl -s -m 2 http://127.0.0.1:3030/api/health >/dev/null 2>&1 && { echo "[boot] engine up"; break; }; sleep 1; done
for i in $(seq 1 40); do code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:3000/api/scrape-tasks 2>/dev/null); [ "$code" = "200" ] && { echo "[boot] app up"; break; }; sleep 1; done

echo
echo "===== S1: 建测试规则 ====="
RULE_RESP=$(curl -s -X POST http://localhost:3000/api/scrape-rules -H 'Content-Type: application/json' -d '{
  "name":"13b-本地假站测试规则",
  "siteUrl":"http://127.0.0.1:3999/",
  "enabled":true,
  "charset":"utf-8",
  "notes":"13-b 验证用，测完删除",
  "bookRule":{"titleSelector":"#info h1","authorSelector":"p.author","descriptionSelector":"#intro","chapterLinkSelector":"#list dd a"},
  "chapterRule":{"titleSelector":"h1","contentSelector":"#content"}
}')
echo "$RULE_RESP"
RID=$(echo "$RULE_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

echo
echo "===== S2: single 任务（假站书页，期望 success + 12 章）====="
RESP=$(curl -s -X POST http://localhost:3000/api/scrape-tasks -H 'Content-Type: application/json' -d "{\"mode\":\"single\",\"targetUrl\":\"http://127.0.0.1:3999/book/1\",\"ruleId\":$RID}")
echo "$RESP"
TID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])")
for i in $(seq 1 40); do
  ST=$(curl -s -m 3 http://localhost:3000/api/scrape-tasks/$TID | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])" 2>/dev/null)
  case "$ST" in success|partial|failed|canceled) break;; esac
  sleep 1
done
echo "--- 任务 $TID 最终状态: $ST ---"
curl -s http://localhost:3000/api/scrape-tasks/$TID | python3 -c "
import sys, json
t = json.load(sys.stdin)['task']
t['log'] = t['log'].replace('\\n', '\n    | ')
print(json.dumps(t, ensure_ascii=False, indent=1))
"

echo
echo "===== S3: 重复执行（期望 updated=1，章节跳过，success）====="
RESP3=$(curl -s -X POST http://localhost:3000/api/scrape-tasks -H 'Content-Type: application/json' -d "{\"mode\":\"single\",\"targetUrl\":\"http://127.0.0.1:3999/book/1\",\"ruleId\":$RID}")
TID3=$(echo "$RESP3" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])")
for i in $(seq 1 40); do
  ST3=$(curl -s -m 3 http://localhost:3000/api/scrape-tasks/$TID3 | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])" 2>/dev/null)
  case "$ST3" in success|partial|failed|canceled) break;; esac
  sleep 1
done
curl -s http://localhost:3000/api/scrape-tasks/$TID3 | python3 -c "
import sys, json
t = json.load(sys.stdin)['task']
print('状态:', t['status'], '| created:', t['created'], '| updated:', t['updated'], '| chapters:', t['chapters'], '| message:', t['message'])
print('log:')
print('    | ' + t['log'].replace(chr(10), chr(10) + '    | '))
"

echo
echo "===== S4: 列表接口复核 ====="
curl -s "http://localhost:3000/api/scrape-tasks?page=1&pageSize=50" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('total:', d['total'])
for t in d['list']:
    print(f\"  #{t['id']} {t['mode']} {t['status']} done={t['done']}/{t['total']} c={t['created']} u={t['updated']} ch={t['chapters']}\")
"

echo
echo "===== S5: 清理验证数据（书籍/分类/规则/任务）====="
python3 - <<'EOF'
import json, urllib.request

def req(method, path, body=None):
    r = urllib.request.Request('http://localhost:3000' + path, method=method,
                               headers={'Content-Type': 'application/json'},
                               data=json.dumps(body).encode() if body else None)
    try:
        with urllib.request.urlopen(r, timeout=10) as res:
            return json.loads(res.read().decode())
    except Exception as e:
        return {'err': str(e)}

# 删除测试书籍及其章节（连带已生成的分类）
novels = req('GET', '/api/novels?page=1&pageSize=100')
for n in novels.get('novels', novels.get('list', [])):
    if n.get('title') == '沙盒测试之书':
        nid = n['id']
        print('删除测试书籍', nid, req('DELETE', f'/api/novels/{nid}'))
# 删除测试规则
rules = req('GET', '/api/scrape-rules')
for r in rules:
    if r['name'] == '13b-本地假站测试规则':
        print('删除测试规则', r['id'], req('DELETE', f'/api/scrape-rules?id={r["id"]}'))
# 删除验证任务
tasks = req('GET', '/api/scrape-tasks?page=1&pageSize=50')
for t in tasks.get('list', []):
    print('删除任务', t['id'], req('DELETE', f'/api/scrape-tasks/{t["id"]}'))
EOF
echo "CLEANUP DONE"
