import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SCRAPER_PORT = 3030

/**
 * 代理到 mini-services/scraper-service（端口 3030）。
 * 服务端内部直连 127.0.0.1，避免浏览器跨端口请求。
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
    return NextResponse.json(
      {
        error: '采集服务不可用',
        detail: e instanceof Error ? e.message : 'unknown',
        hint: '请确认 mini-services/scraper-service 已启动（bun run dev，端口 3030）',
      },
      { status: 502 }
    )
  }
}

export async function GET(req: NextRequest) {
  const sub = req.nextUrl.searchParams.get('proxy') ?? 'strategies'
  return proxy(`/api/${sub}`)
}

export async function POST(req: NextRequest) {
  const sub = req.nextUrl.searchParams.get('proxy') ?? 'test'
  const body = await req.text()
  return proxy(`/api/${sub}`, { method: 'POST', body })
}
