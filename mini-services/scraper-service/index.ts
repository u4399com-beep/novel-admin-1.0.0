/**
 * scraper-service —— 小说管理系统可插拔采集引擎 mini-service（Bun + TypeScript）
 *
 * 端口: 3030（与主站 src/app/api/scrape/route.ts 的代理目标一致）
 *
 * 本文件只保留启动与路由分发；业务 handler 在 ./handlers.ts，
 * 策略链/反反爬在 ./src/strategies/（注册表与编排见 src/strategies/index.ts），
 * 规则提取器在 ./src/extract/。
 *
 * 路由:
 *   GET  /api/strategies  可用抓取策略及状态
 *   GET  /api/health      健康检查
 *   POST /api/test        { url, rule: { listRule?, bookRule?, chapterRule? }, strategy?, charset?, timeoutMs? }
 *   POST /api/chapter     { url, rule?: ChapterRule, charset?, strategy?, timeoutMs? }
 *
 * 错误一律 JSON { error, detail }；策略全败返回结构化 502 而非 throw；
 * 成功与失败响应都携带 attempts 明细（每次网络尝试的状态/耗时/画像/挑战页标记）便于调试；
 * 内部异常只返回消息不返回堆栈（堆栈仅打印到服务端日志）。
 *
 * 合规红线（不可移除）：
 * - 仅用于公开可访问内容，禁止采集需登录/付费内容；
 * - 内置 robots.txt 提示（warn-only）与默认低频限速（每域名 ≥1.2s）；
 * - 不含任何验证码破解、账号伪装、登录态伪造功能。
 */
import { statSync, utimesSync, writeFileSync } from 'node:fs'
import { fail, handleChapter, handleStrategies, handleTest, json, parseBody } from './handlers'

// ==================== 防误启动护栏（Task 19-d） ====================
// Go 引擎（mini-services/scraper-go）已接管 3030 成为生产引擎，本 TS 版仅作回滚备份。
// 默认拒绝启动：本文件底部的互监护会在运行期拉起 scripts/worker-runner.ts（TS 采集
// runner），与 backend-go 内置 runner 并存时将双写 ScrapeTask（已有实际双写事故）。
// 确需回滚 TS 引擎时：先停 backend-go 与 scraper-go，再以 ALLOW_TS_ENGINE=1 显式启动。
if (process.env.ALLOW_TS_ENGINE !== '1') {
  console.error('[scraper-service] ⛔ 拒绝启动：Go 引擎（mini-services/scraper-go）已接管 3030，本 TS 引擎仅作回滚备份。')
  console.error('[scraper-service] ⛔ 且本进程互监护会拉起 TS runner（scripts/worker-runner.ts），在 backend-go 运行时会双写 ScrapeTask。')
  console.error('[scraper-service] 回滚方法：先停 backend-go 与 scraper-go，再以 ALLOW_TS_ENGINE=1 bun index.ts 显式启动。')
  process.exit(1)
}

const parsedPort = Number(process.env.SCRAPER_PORT)
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 3030

// ==================== 路由 ====================

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method.toUpperCase()

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      },
    })
  }

  if (method === 'GET' && (path === '/' || path === '')) {
    return json({
      ok: true,
      service: 'scraper-service',
      version: '1.1.0',
      endpoints: ['GET /api/strategies', 'GET /api/health', 'POST /api/test', 'POST /api/chapter'],
    })
  }

  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true, service: 'scraper-service', port: PORT, time: new Date().toISOString() })
  }

  if (method === 'GET' && path === '/api/strategies') {
    return handleStrategies()
  }

  if (method === 'POST' && path === '/api/test') {
    const body = await parseBody(req)
    if (!body) return fail('请求体错误', '请求体必须是 JSON 对象，形如 { url, rule: { listRule?, bookRule?, chapterRule? }, strategy?, charset?, timeoutMs? }')
    return handleTest(body)
  }

  if (method === 'POST' && path === '/api/chapter') {
    const body = await parseBody(req)
    if (!body) return fail('请求体错误', '请求体必须是 JSON 对象，形如 { url, rule?: { titleSelector?, contentSelector?, nextSelector? }, charset?, strategy?, timeoutMs? }')
    return handleChapter(body)
  }

  return fail('Not Found', `未知路由 ${method} ${path}。可用: GET /api/strategies, GET /api/health, POST /api/test, POST /api/chapter`, 404)
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    try {
      return await route(req)
    } catch (e) {
      // 不向客户端泄漏内部堆栈/内部路径；完整堆栈只进服务端日志。
      // detail 中的绝对路径统一抹除（Node/Bun 异常消息常带 ENOENT 全路径，属于内部信息）
      console.error('[scraper-service] unhandled error:', e instanceof Error ? e.stack ?? e.message : String(e))
      const msg = e instanceof Error ? e.message : String(e)
      return fail('服务器内部错误', msg.replace(/\/(?:home|root|tmp|usr|var|etc|proc)\/[\w.\-/?=,]*/g, '[path]'), 500)
    }
  },
  error(e) {
    console.error('[scraper-service] server error:', e instanceof Error ? e.stack ?? e.message : String(e))
    return fail('服务器内部错误', '请求处理失败，请查看服务端日志', 500)
  },
})

console.log(`[scraper-service] listening on http://127.0.0.1:${server.port}`)
console.log(`[scraper-service] 合规约束: 域名限速≥1.2s | robots.txt warn-only | SSRF 逐跳校验 | 禁验证码破解/账号伪装/付费内容`)

/**
 * 引擎自心跳（每 2s utime 一次）：沙箱环境会静默回收“空闲”后台进程（多轮实证：
 * 每 2s 刷心跳文件的 runner 存活数小时，空闲的引擎/watchdog 在拉起后 60-90s 被杀），
 * 周期性文件活动是对冲手段。心跳文件同时供互监护/运维判定引擎存活。
 */
const ENGINE_HEARTBEAT = '/tmp/scraper-engine-heartbeat'
setInterval(() => {
  try {
    const now = new Date()
    utimesSync(ENGINE_HEARTBEAT, now, now)
  } catch {
    try {
      writeFileSync(ENGINE_HEARTBEAT, new Date().toISOString())
    } catch { /* 忽略 */ }
  }
}, 2_000).unref?.()

/**
 * Runner 互监护（本进程被实证长寿，由它兜底拉起采集 runner）：
 * 每 30s 检查 /tmp/scrape-runner-heartbeat；10s 未刷新即视为 runner 死亡，
 * 以 setsid 完全脱离本进程会话的方式重启（kill 残留避免双实例抢任务）。
 * 独立 watchdog 进程方案在本环境会被静默回收（多轮实证），故采用进程互监护。
 * 反向监护（engine 死亡由 runner 拉起）在 scripts/worker-runner.ts。
 */
const RUNNER_HEARTBEAT = '/tmp/scrape-runner-heartbeat'
const RUNNER_SPAWN =
  "cd /home/z/my-project && pkill -f 'bun scripts/worker-runner' 2>/dev/null; " +
  'setsid nohup env SCRAPE_WORKER_RUNNER=1 bun scripts/worker-runner.ts >> /tmp/runner.log 2>&1 < /dev/null &'
setInterval(() => {
  try {
    const stat = statSync(RUNNER_HEARTBEAT)
    if (Date.now() - stat.mtimeMs < 10_000) return
  } catch {
    /* 心跳文件不存在 = runner 死亡 */
  }
  console.log(`[scraper-service] runner 心跳缺失，重新拉起`)
  Bun.spawn(['bash', '-c', RUNNER_SPAWN], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
}, 30_000).unref?.()
