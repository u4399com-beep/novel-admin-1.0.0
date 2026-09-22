/**
 * API 总代理（Go 迁移切换层）—— 全部 /api/* 请求转发到 backend-go（127.0.0.1:3005）。
 *
 * 背景（Task 18）：项目后端已整体迁移为 Go（mini-services/backend-go），本文件是
 * Next.js 侧唯一的 API 出口：浏览器仍请求同源相对路径 /api/*（契约不变），由本层
 * 原样转发。服务端内部直连 127.0.0.1:3005（与 engine-client 直连 3030 同一先例）。
 *
 * 契约：
 * - 路径/查询串/方法/请求体原样透传；响应状态码 + Content-Type + body 原样回写
 * - 超时 65s（采集引擎策略链预算 55s + 余量，对齐原 /api/scrape 代理的 60s+）
 * - 后端不可达 → 502 {error, detail}（结构与 TS 版一致）
 *
 * 原各域 route.ts 已删除（git 历史保留）；业务逻辑一律以 backend-go 为准：
 *   mini-services/backend-go/api_*.go（对照原 src/app/api 各域 route.ts 逐行移植）
 */
import { NextRequest, NextResponse } from 'next/server'
import { ensureBackendGo } from '@/lib/backend-supervisor'

export const dynamic = 'force-dynamic'

const BACKEND_ORIGIN = 'http://127.0.0.1:3005'
const PROXY_TIMEOUT_MS = 65_000

async function proxy(req: NextRequest, method: string): Promise<NextResponse> {
  // 进程看护：backend-go 由本进程拉起与自愈（详见 backend-supervisor.ts）
  ensureBackendGo()
  const url = new URL(req.url)
  const target = `${BACKEND_ORIGIN}${url.pathname}${url.search}`
  const headers: Record<string, string> = {
    'Content-Type': req.headers.get('content-type') ?? 'application/json',
  }
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const body = hasBody ? await req.text() : undefined
  try {
    const res = await fetch(target, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
    })
  } catch (e) {
    const timedOut = e instanceof Error && (/timeout|abort/i.test(e.message) || (e as { name?: string }).name === 'TimeoutError')
    // 后端不可达时立即尝试重新拉起（ensureBackendGo 自带冷却，不影响本次 502 响应）
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
  return proxy(req, 'GET')
}
export async function POST(req: NextRequest) {
  return proxy(req, 'POST')
}
export async function PUT(req: NextRequest) {
  return proxy(req, 'PUT')
}
export async function DELETE(req: NextRequest) {
  return proxy(req, 'DELETE')
}
export async function PATCH(req: NextRequest) {
  return proxy(req, 'PATCH')
}
export async function OPTIONS(req: NextRequest) {
  return proxy(req, 'OPTIONS')
}
