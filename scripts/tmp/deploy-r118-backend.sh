#!/usr/bin/env bash
# R118 临时部署脚本：重启 backend（新主题 washai 生效）。失败码收尾保进程存活。
pkill -f 'bin/backend-go[ ]?$|backend-go$' 2>/dev/null; pkill -f 'mini-services/backend-go/bin' 2>/dev/null; sleep 1
cd /home/z/my-project/mini-services/backend-go
setsid nohup env DB_PATH=/home/z/my-project/db/custom.db ./bin/backend-go >> /tmp/backend-go.log 2>&1 < /dev/null &
sleep 3
curl -s --max-time 3 http://127.0.0.1:3000/api/health | head -c 120
echo
exit 7
