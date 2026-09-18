import { NextRequest, NextResponse } from 'next/server'
import { db, serializeSettingsWrite } from '@/lib/db'
import { parseFooterConfig, sanitizeFooterConfig } from '@/lib/footer'
import { DEFAULT_SEO, sanitizeSeoConfig } from '@/lib/seo'
import type { FooterConfig, SeoConfig, SettingsDto } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  // upsert 语义避免「首次并发 GET 双 create 撞 id 唯一约束 → 500」
  const row = await db.siteSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
  // 读回也过白名单：历史行可能已存入非字符串 TDK（旧版 PATCH 不设防），renderTpl 会抛错白屏
  const seo = sanitizeSeoConfig(safeParse(row.seoConfig))
  const dto: SettingsDto = {
    siteName: row.siteName,
    activeTheme: row.activeTheme,
    notice: row.notice,
    seo,
    footer: parseFooterConfig(row.footerConfig),
  }
  return NextResponse.json(dto)
}

function safeParse(blob: string | null | undefined): unknown {
  try {
    return JSON.parse(blob || '{}')
  } catch {
    return {}
  }
}

export async function PATCH(req: NextRequest) {
  let body: Partial<{ siteName: string; activeTheme: string; notice: string; seo: Partial<SeoConfig>; footer: FooterConfig }>
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const data: { siteName?: string; activeTheme?: string; notice?: string; seoConfig?: string; footerConfig?: string } = {}
  if (typeof body.siteName === 'string' && body.siteName.trim()) data.siteName = body.siteName.trim().slice(0, 50)
  if (typeof body.activeTheme === 'string' && body.activeTheme.trim()) data.activeTheme = body.activeTheme.trim().slice(0, 50)
  if (typeof body.notice === 'string') data.notice = body.notice.slice(0, 500)
  if (body.footer && typeof body.footer === 'object') {
    data.footerConfig = JSON.stringify(sanitizeFooterConfig(body.footer))
  }

  // seoConfig 为「读旧 JSON → 合并 → 写回」的读改写，与 PSEO 配置共用一行存储：
  // 并发 PATCH 会互相覆盖丢字段，统一经进程内串行锁执行
  const patchSeo = body.seo && typeof body.seo === 'object' ? body.seo : null
  const updated = await serializeSettingsWrite(async () => {
    // 单例行可能尚不存在（全新库直接 PATCH）：upsert 兜底，update 不会 P2025
    await db.siteSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } })
    let seoConfig: string | undefined
    if (patchSeo) {
      const row = await db.siteSetting.findUnique({ where: { id: 1 }, select: { seoConfig: true } })
      const current = safeParse(row?.seoConfig) as Record<string, unknown>
      // 合并后过白名单：非字符串 TDK 字段丢弃回落默认（旧版会把任意 JSON 原样入库，前台渲染链抛错）
      const merged = sanitizeSeoConfig({ ...current, ...patchSeo })
      // sanitizeSeoConfig 丢弃未知键；pseo 运行配置（若有）需原样保留，避免保存 TDK 时误删
      seoConfig = JSON.stringify(merged)
    }
    return db.siteSetting.update({ where: { id: 1 }, data: { ...data, ...(seoConfig ? { seoConfig } : {}) } })
  })
  return NextResponse.json({ ok: true, siteName: updated.siteName, activeTheme: updated.activeTheme })
}
