#!/bin/bash
# 13-b 验证脚本：在单次调用内启动服务并完成 curl 全链路测试
cd /home/z/my-project

# ---- 启动 scraper-service 与 dev server（服务间调用会被沙箱回收，故同调用内完成测试）----
(cd /home/z/my-project/mini-services/scraper-service && setsid nohup bun run dev </dev/null >/tmp/scraper.log 2>&1 &)
(setsid nohup bun run dev </dev/null >/dev/null 2>&1 &)

ENGINE_UP=0
for i in $(seq 1 30); do
  if curl -s -m 2 http://127.0.0.1:3030/api/health >/dev/null 2>&1; then ENGINE_UP=1; echo "[boot] engine up (iter $i)"; break; fi
  sleep 1
done
[ "$ENGINE_UP" = "0" ] && echo "[boot] ENGINE FAILED TO START"

APP_UP=0
for i in $(seq 1 40); do
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:3000/api/scrape-tasks 2>/dev/null)
  if [ "$code" = "200" ]; then APP_UP=1; echo "[boot] app up (iter $i)"; break; fi
  sleep 1
done
[ "$APP_UP" = "0" ] && { echo "[boot] APP FAILED TO START"; exit 1; }

echo
echo "===== T1: GET /api/scrape-tasks ====="
curl -s "http://localhost:3000/api/scrape-tasks?page=1&pageSize=50"; echo

echo
echo "===== T2: POST single 任务 (targetUrl=https://example.com/, 无规则) ====="
RESP=$(curl -s -X POST http://localhost:3000/api/scrape-tasks -H 'Content-Type: application/json' -d '{"mode":"single","targetUrl":"https://example.com/"}')
echo "$RESP"
TID=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])")
echo "--- 轮询任务 $TID 状态 ---"
for i in $(seq 1 25); do
  ST=$(curl -s -m 3 http://localhost:3000/api/scrape-tasks/$TID | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])" 2>/dev/null)
  echo "poll $i: status=$ST"
  case "$ST" in success|partial|failed|canceled) break;; esac
  sleep 2
done
echo "--- 任务 $TID 最终详情（含 log）---"
curl -s http://localhost:3000/api/scrape-tasks/$TID | python3 -c "
import sys, json
t = json.load(sys.stdin)['task']
t['log'] = t['log'].replace('\\n', '\n    | ')
print(json.dumps(t, ensure_ascii=False, indent=1))
"

echo
echo "===== T3: PATCH cancel（running 中间态）====="
RESP2=$(curl -s -X POST http://localhost:3000/api/scrape-tasks -H 'Content-Type: application/json' -d '{"mode":"single","targetUrl":"https://192.0.2.1/"}')
echo "创建: $RESP2"
TID2=$(echo "$RESP2" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['id'])")
ST2=""
for i in $(seq 1 60); do
  ST2=$(curl -s -m 2 http://localhost:3000/api/scrape-tasks/$TID2 | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])" 2>/dev/null)
  case "$ST2" in
    running) break ;;
    success|partial|failed|canceled) break ;;
  esac
  sleep 0.5
done
echo "观测状态: $ST2"
if [ "$ST2" = "running" ]; then
  echo "--- PATCH cancel ---"
  curl -s -X PATCH http://localhost:3000/api/scrape-tasks/$TID2 -H 'Content-Type: application/json' -d '{"action":"cancel"}' -w "\nHTTP %{http_code}\n"
  echo "--- 等待 worker 30s 引擎调用超时后收尾 ---"
  sleep 33
  curl -s http://localhost:3000/api/scrape-tasks/$TID2 | python3 -c "
import sys, json
t = json.load(sys.stdin)['task']
t['log'] = t['log'].replace('\\n', '\n    | ')
print(json.dumps(t, ensure_ascii=False, indent=1))
"
else
  echo "任务已快速结束($ST2)，改测终态 PATCH（预期 400）:"
  curl -s -X PATCH http://localhost:3000/api/scrape-tasks/$TID2 -H 'Content-Type: application/json' -d '{"action":"cancel"}' -w "\nHTTP %{http_code}\n"
fi

echo
echo "===== T4: 非法输入（预期全部 400）====="
curl -s -X POST http://localhost:3000/api/scrape-tasks -H 'Content-Type: application/json' -d '{"mode":"xxx","targetUrl":"https://example.com/"}' -w " [%{http_code}]"; echo
curl -s -X POST http://localhost:3000/api/scrape-tasks -H 'Content-Type: application/json' -d '{"mode":"single","targetUrl":"ftp://example.com/"}' -w " [%{http_code}]"; echo
curl -s -X POST http://localhost:3000/api/scrape-tasks -H 'Content-Type: application/json' -d '{"mode":"list","targetUrl":"https://example.com/","pages":99}' -w " [%{http_code}]"; echo
curl -s -X PATCH http://localhost:3000/api/scrape-tasks/999999 -H 'Content-Type: application/json' -d '{"action":"cancel"}' -w " [%{http_code}]"; echo
echo "DONE"
