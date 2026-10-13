#!/usr/bin/env python3
"""章节正文吞吐监控：每 60s 采样 ChapterContent 增量 + 引擎 host-health 摘要，写 /tmp/throughput.log"""
import sqlite3, time, json, urllib.request, sys

DB = '/home/z/my-project/db/custom.db'

def q(sql):
    c = sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=5)
    try:
        return c.execute(sql).fetchone()[0]
    finally:
        c.close()

def get(url, to=5):
    try:
        return json.loads(urllib.request.urlopen(url, timeout=to).read().decode())
    except Exception as e:
        return {'err': str(e)}

prev = None
start = time.time()
while True:
    try:
        n = q('SELECT COUNT(*) FROM ChapterContent')
        novels = q('SELECT COUNT(*) FROM Novel')
        now = time.time()
        line = f'{time.strftime("%H:%M:%S")} contents={n} novels={novels}'
        if prev is not None:
            dt = now - prev[1]
            rate = (n - prev[0]) / dt * 3600 if dt > 0 else 0
            line += f' dContents={n-prev[0]} rate={rate:.0f}/h'
        prev = (n, now)
        # engine host health summary: adaptive (backed off) hosts
        hh = get('http://127.0.0.1:3030/api/host-health')
        if isinstance(hh, dict) and hh.get('adaptiveHosts'):
            line += ' aimd=' + ','.join(f"{h['host'].split('.')[0]}:{h['adaptiveIntervalMs']}" for h in hh['adaptiveHosts'][:6])
        # backend rule health
        st = get('http://127.0.0.1:3000/api/health')
        if isinstance(st, dict) and st.get('ruleHealth'):
            line += f" ruleHealth={st['ruleHealth'].get('healthy')}/{st['ruleHealth'].get('checked')}"
        with open('/tmp/throughput.log', 'a') as f:
            f.write(line + '\n')
    except Exception as e:
        with open('/tmp/throughput.log', 'a') as f:
            f.write(f'{time.strftime("%H:%M:%S")} ERR {e}\n')
    time.sleep(60)
