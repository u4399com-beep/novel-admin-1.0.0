import type { MetadataRoute } from 'next'
import { db } from '@/lib/db'

// 站点基准 URL：sitemap 协议要求 <loc> 为绝对 URL，相对路径 "/" 是非法的
const BASE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date()
  const entries: MetadataRoute.Sitemap = [
    {
      url: `${BASE_URL}/`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 1,
    },
  ]

  // PSEO 已生成聚合页：/pseo/{keyword} 服务端落地页（src/app/pseo/[kw]/page.tsx，仅 generated 状态可访问）
  try {
    const rows = await db.pseoKeyword.findMany({
      where: { status: 'generated' },
      select: { keyword: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    })
    for (const r of rows) {
      if (!r.keyword) continue
      entries.push({
        url: `${BASE_URL}/pseo/${encodeURIComponent(r.keyword)}`,
        lastModified: r.updatedAt,
        changeFrequency: 'daily',
        priority: 0.6,
      })
    }
  } catch {
    // DB 不可用时保底仅返回首页条目，不让 /sitemap.xml 整体 500
  }

  return entries
}
