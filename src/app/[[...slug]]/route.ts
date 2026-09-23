/**
 * 全站反向代理（Task 24 全 Go 化切换层）—— 3000 端口唯一的 Next.js 出口。
 *
 * 背景：用户指令「取消 Next.js 前端，整个项目全部 go 化改造」。页面渲染已全部
 * 迁移至 backend-go（mini-services/backend-go/web.go + web/templates/），本文件把
 * 3000 收到的所有请求原样转发到 Go 层，Next.js 从此只是网络管道。
 *
 * 拓扑（Task 25 合并单进程）：全部流量 → 127.0.0.1:3005（backend-go mode=all：
 * 页面渲染 + 业务 API + 采集 runner，由 backend-supervisor.ts ensureBackendGo()
 * 看护自愈）。此前的 3007 mode=api「页面双保险」进程因沙箱会回收 bash 派生进程
 * 且 supervisor 只看护 3005，反复死亡导致页面 502，已裁撤——单进程即唯一真身。
 *
 * 契约：路径/查询串/方法/请求头（白名单）/请求体原样透传；响应状态码 + 头 + body
 * 原样回写；超时 65s；后端不可达 → 502 {error, detail}。
 */
import { NextRequest, NextResponse } from 'next/server'
import { ensureBackendGo } from '@/lib/backend-supervisor'

export const dynamic = 'force-dynamic'

const API_ORIGIN = process.env.GO_API_ORIGIN ?? 'http://127.0.0.1:3005'
const PROXY_TIMEOUT_MS = 65_000

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

async function proxy(req: NextRequest): Promise<NextResponse> {
  ensureBackendGo()
  const url = new URL(req.url)
  const target = `${API_ORIGIN}${url.pathname}${url.search}`

  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value
  })

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let body: string | undefined
  if (hasBody) {
    body = await req.text()
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
  }

  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
    const out = new Headers()
    res.headers.forEach((value, key) => {
      const k = key.toLowerCase()
      if (HOP_BY_HOP.has(k) || k === 'content-encoding' || k === 'content-length') return
      out.set(key, value)
    })
    const text = await res.text()
    out.set('content-length', String(Buffer.byteLength(text)))
    return new NextResponse(text, { status: res.status, headers: out })
  } catch (e) {
    const timedOut = e instanceof Error && (/timeout|abort/i.test(e.message) || (e as { name?: string }).name === 'TimeoutError')
    if (!timedOut) ensureBackendGo()
    return NextResponse.json(
      {
        error: timedOut ? '后端服务响应超时' : '后端服务不可用',
        detail: e instanceof Error ? e.message : 'unknown',
      },
      { status: 502 },
    )
  }
}

export async function GET(req: NextRequest) {
  return proxy(req)
}
export async function POST(req: NextRequest) {
  return proxy(req)
}
export async function PUT(req: NextRequest) {
  return proxy(req)
}
export async function DELETE(req: NextRequest) {
  return proxy(req)
}
export async function PATCH(req: NextRequest) {
  return proxy(req)
}
export async function HEAD(req: NextRequest) {
  return proxy(req)
}
export async function OPTIONS(req: NextRequest) {
  return proxy(req)
}
