#!/bin/bash
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while true; do
  bash "$ROOT/scripts/ensure-services.sh" >> /tmp/watchdog.log 2>&1
  sleep 60
done
