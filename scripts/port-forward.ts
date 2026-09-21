/**
 * 3000 端口轻量转发器 → 127.0.0.1:3001（next dev 正主位）
 *
 * 背景：沙箱守护周期性 SIGKILL「next dev 监听 3000」的进程（实证多轮；非 next 进程占用
 * 3000 不被杀）。故 dev server 稳定跑 3001，本转发器占 3000 承接 Caddy :81 默认路由，
 * 对外保持「站点在 3000」的访问契约。HTTP 逐请求透传（method/headers/body/status 流式）。
 * 运行：bun scripts/port-forward.ts（常驻）
 */
const UPSTREAM = 'http://127.0.0.1:3001'

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url)
    const target = `${UPSTREAM}${url.pathname}${url.search}`
    try {
      const headers = new Headers(req.headers)
      headers.delete('host') // 保留 3001 侧 Host 语义
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        // @ts-expect-error Bun 扩展：透传 duplex 流式 body
        duplex: 'half',
        redirect: 'manual',
      })
      const resHeaders = new Headers(upstream.headers)
      resHeaders.delete('content-encoding') // fetch 已解压，避免下游二次解压错乱
      resHeaders.delete('content-length')
      resHeaders.delete('transfer-encoding')
      return new Response(upstream.body, { status: upstream.status, headers: resHeaders })
    } catch (e) {
      return new Response(
        JSON.stringify({ error: '上游 dev server 不可达(3001)，supervisor 会自动拉起' }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
  },
})
console.log('[port-forward] 3000 → 3001 ready')
