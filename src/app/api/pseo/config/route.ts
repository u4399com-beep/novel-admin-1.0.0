import { NextRequest, NextResponse } from 'next/server'
import { getPseoConfig, savePseoConfig } from '@/lib/pseo'

export const dynamic = 'force-dynamic'

// GET /api/pseo/config — 读取 PSEO 运行配置（multi-search-engine 批量获取设置）
export async function GET() {
  return NextResponse.json(await getPseoConfig())
}

// PATCH /api/pseo/config — 保存配置（服务端读改写 seoConfig JSON 的 pseo 字段，白名单校验）
// body: { config: Partial<PseoRunnerConfig> }
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { config?: unknown } | null
  if (!body || typeof body !== 'object' || !('config' in body)) {
    return NextResponse.json({ error: '缺少 config 字段' }, { status: 400 })
  }
  const saved = await savePseoConfig(body.config)
  return NextResponse.json(saved)
}
