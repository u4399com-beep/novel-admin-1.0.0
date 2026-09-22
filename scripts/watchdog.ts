/**
 * 服务看护 Watchdog（bun 常驻进程）
 *
 * 背景实证：setsid 的 bash while-loop 看护会被环境静默回收（1 轮即死），
 * bun 常驻进程（runner/engine）反而长期稳定 —— 故本看护用 bun 实现。
 *
 * 职责（每 30s 一轮）：
 * 1. runner 存活判定 = /tmp/scrape-runner-heartbeat 10s 内刷新；过期则杀残留并重启
 * 2. engine 存活判定 = GET :3030/api/strategies 200；失败则杀残留并重启
 *
 * 运行：setsid nohup bun scripts/watchdog.ts >> /tmp/watchdog.log 2>&1
 */
import { statSync } from 'node:fs'

const HB = '/tmp/scrape-runner-heartbeat'
const ROOT = '/home/z/my-project'
const ENGINE_URL = 'http://127.0.0.1:3030/api/strategies'

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

function spawnDetached(cwd: string, cmd: string, env: Record<string, string>, logFile: string): void {
  // bun --hot <file> >> log 2>&1（Bun.spawn 的 stdio 仅接受 inherit/ignore/null，重定向交给 bash）
  const proc = Bun.spawn({
    cmd: ['bash', '-c', `exec bun ${cmd} >> ${logFile} 2>&1`],
    cwd,
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  proc.unref()
}

async function engineAlive(): Promise<boolean> {
  try {
    const res = await fetch(ENGINE_URL, { signal: AbortSignal.timeout(8000) })
    return res.ok
  } catch {
    return false
  }
}

function runnerAlive(): boolean {
  try {
    return Date.now() - statSync(HB).mtimeMs < 10_000
  } catch {
    return false
  }
}

async function tick(): Promise<void> {
  if (!runnerAlive()) {
    try {
      Bun.spawnSync(['pkill', '-f', 'scripts/worker-runner'])
    } catch { /* 无残留进程时 pkill 非零退出，忽略 */ }
    spawnDetached(ROOT, '--hot scripts/worker-runner.ts', { SCRAPE_WORKER_RUNNER: '1' }, '/tmp/runner.log')
    log('runner 拉起（心跳缺失/过期）')
  }
  if (!(await engineAlive())) {
    try {
      Bun.spawnSync(['pkill', '-f', 'scraper-service'])
    } catch { /* 同上 */ }
    spawnDetached(`${ROOT}/mini-services/scraper-service`, '--hot index.ts', { SCRAPER_PORT: '3030' }, '/tmp/engine.log')
    log('engine 拉起（/api/strategies 不可达）')
  }
}

log('watchdog started (bun)')
for (;;) {
  try {
    await tick()
  } catch (e) {
    log(`tick error: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`)
  }
  await new Promise((r) => setTimeout(r, 30_000))
}
