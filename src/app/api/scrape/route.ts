import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SCRAPER_PORT = 3030

/** 允许代理的子路由白名单（方法级），防止路径拼接被滥用 */
const GET_SUBS = new Set(['strategies', 'health'])
const POST_SUBS = new Set(['test', 'chapter'])

/**
 * 代理到 mini-services/scraper-service（端口 3030）。
 * 服务端内部直连 127.0.0.1，避免浏览器跨端口请求。
 * 超时 60s 与策略链预算（scraper-service 硬上限 55s）对齐，错误结构化透传。
 */
async function proxy(path: string, init?: RequestInit): Promise<NextResponse> {
  try {
    const res = await fetch(`http://127.0.0.1:${SCRAPER_PORT}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
    })
  } catch (e) {
    const timedOut = e instanceof Error && /timeout|abort/i.test(e.message)
    return NextResponse.json(
      {
        error: timedOut ? '采集服务响应超时' : '采集服务不可用',
        detail: e instanceof Error ? e.message : 'unknown',
        hint: timedOut
          ? '策略链整体预算为 55s，可尝试减小 timeoutMs 或指定单一 strategy'
          : '请确认 mini-services/scraper-service 已启动（bun run dev，端口 3030）',
      },
      { status: 502 }
    )
  }
}

export async function GET(req: NextRequest) {
  const sub = req.nextUrl.searchParams.get('proxy') ?? 'strategies'
  if (!GET_SUBS.has(sub)) {
    return NextResponse.json({ error: '不支持的 proxy 子路由', detail: `GET 仅允许: ${[...GET_SUBS].join(', ')}` }, { status: 404 })
  }
  return proxy(`/api/${sub}`)
}

export async function POST(req: NextRequest) {
  const sub = req.nextUrl.searchParams.get('proxy') ?? 'test'
  if (!POST_SUBS.has(sub)) {
    return NextResponse.json({ error: '不支持的 proxy 子路由', detail: `POST 仅允许: ${[...POST_SUBS].join(', ')}` }, { status: 404 })
  }
  const body = await req.text()
  return proxy(`/api/${sub}`, { method: 'POST', body })
}
