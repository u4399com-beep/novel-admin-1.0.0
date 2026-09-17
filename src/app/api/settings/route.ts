import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseFooterConfig, sanitizeFooterConfig } from '@/lib/footer'
import { DEFAULT_SEO } from '@/lib/seo'
import type { FooterConfig, SeoConfig, SettingsDto } from '@/lib/types'

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
    footer: parseFooterConfig(row.footerConfig),
  }
  return NextResponse.json(dto)
}

export async function PATCH(req: NextRequest) {
  let body: Partial<{ siteName: string; activeTheme: string; notice: string; seo: Partial<SeoConfig>; footer: FooterConfig }>
  try {
    body = (await req.json()) as Partial<{ siteName: string; activeTheme: string; notice: string; seo: Partial<SeoConfig>; footer: FooterConfig }>
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const row = await db.siteSetting.findUnique({ where: { id: 1 } })
  if (!row) await db.siteSetting.create({ data: { id: 1 } })

  const data: { siteName?: string; activeTheme?: string; notice?: string; seoConfig?: string; footerConfig?: string } = {}
  if (typeof body.siteName === 'string' && body.siteName.trim()) data.siteName = body.siteName.trim().slice(0, 50)
  if (typeof body.activeTheme === 'string' && body.activeTheme.trim()) data.activeTheme = body.activeTheme.trim().slice(0, 50)
  if (typeof body.notice === 'string') data.notice = body.notice.slice(0, 500)
  if (body.footer && typeof body.footer === 'object') {
    data.footerConfig = JSON.stringify(sanitizeFooterConfig(body.footer))
  }
  if (body.seo && typeof body.seo === 'object') {
    let current: Partial<SeoConfig> = {}
    try {
      current = row?.seoConfig ? (JSON.parse(row.seoConfig) as Partial<SeoConfig>) : {}
    } catch {
      // 已存配置损坏时从默认值重建，避免 PATCH 永久 500
      current = {}
    }
    data.seoConfig = JSON.stringify({ ...DEFAULT_SEO, ...current, ...body.seo })
  }
  const updated = await db.siteSetting.update({ where: { id: 1 }, data })
  return NextResponse.json({ ok: true, siteName: updated.siteName, activeTheme: updated.activeTheme })
}
