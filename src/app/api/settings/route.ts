import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { DEFAULT_SEO } from '@/lib/seo'
import type { SeoConfig, SettingsDto } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  let row = await db.siteSetting.findUnique({ where: { id: 1 } })
  if (!row) {
    row = await db.siteSetting.create({ data: { id: 1 } })
  }
  let seo: SeoConfig = { ...DEFAULT_SEO }
  try {
    const parsed = JSON.parse(row.seoConfig || '{}') as Partial<SeoConfig>
    seo = { ...seo, ...parsed }
  } catch {
    // 保持默认
  }
  const dto: SettingsDto = {
    siteName: row.siteName,
    activeTheme: row.activeTheme,
    notice: row.notice,
    seo,
  }
  return NextResponse.json(dto)
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as Partial<{ siteName: string; activeTheme: string; notice: string; seo: Partial<SeoConfig> }>
  const row = await db.siteSetting.findUnique({ where: { id: 1 } })
  if (!row) await db.siteSetting.create({ data: { id: 1 } })

  const data: { siteName?: string; activeTheme?: string; notice?: string; seoConfig?: string } = {}
  if (typeof body.siteName === 'string' && body.siteName.trim()) data.siteName = body.siteName.trim().slice(0, 50)
  if (typeof body.activeTheme === 'string' && body.activeTheme.trim()) data.activeTheme = body.activeTheme.trim().slice(0, 50)
  if (typeof body.notice === 'string') data.notice = body.notice.slice(0, 500)
  if (body.seo && typeof body.seo === 'object') {
    const current = row?.seoConfig ? JSON.parse(row.seoConfig) : {}
    data.seoConfig = JSON.stringify({ ...DEFAULT_SEO, ...current, ...body.seo })
  }
  const updated = await db.siteSetting.update({ where: { id: 1 }, data })
  return NextResponse.json({ ok: true, siteName: updated.siteName, activeTheme: updated.activeTheme })
}
