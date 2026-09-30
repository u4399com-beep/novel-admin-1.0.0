#!/bin/bash
# R26 恢复轮：拉起双服务 + 常驻看护（失败码收尾模式，进程才不被沙箱收割）
cd /home/z/my-project
mkdir -p db

# 1. backend-go（all 模式 :3000，首次启动自动 DDL+seed）
pkill -f 'backend-go[.]bin' 2>/dev/null; sleep 1
cd /home/z/my-project/mini-services/backend-go
setsid nohup env BACKEND_PORT=3000 BACKEND_MODE=all ./backend-go.bin >> /tmp/backend-go-api.log 2>&1 </dev/null &
cd /home/z/my-project

# 2. scraper-go（引擎 :3030）
pkill -f 'scraper-go[.]bin' 2>/dev/null; sleep 1
cd /home/z/my-project/mini-services/scraper-go
setsid nohup ./scraper-go.bin >> /tmp/engine.log 2>&1 </dev/null &
cd /home/z/my-project

# 3. 常驻看护：60s/轮 ensure-services 循环（独立进程，双服务兜底拉起）
cat > /tmp/watchdog-loop.sh <<'EOF'
#!/bin/bash
while true; do
  bash /home/z/my-project/scripts/ensure-services.sh >> /tmp/watchdog.log 2>&1
  sleep 60
done
EOF
chmod +x /tmp/watchdog-loop.sh
pkill -f 'watchdog-loop[.]sh' 2>/dev/null; sleep 0.5
setsid nohup bash /tmp/watchdog-loop.sh >> /tmp/watchdog-loop.log 2>&1 </dev/null &

sleep 4
echo "=== health backend ==="
curl -s --max-time 5 http://127.0.0.1:3000/api/health || echo "backend not ready yet"
echo ""
echo "=== engine strategies ==="
curl -s --max-time 5 http://127.0.0.1:3030/api/strategies -o /dev/null -w '%{http_code}\n' || echo "engine not ready yet"

exit 7
