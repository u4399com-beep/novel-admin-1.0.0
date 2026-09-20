import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sanitizeKeyword } from '@/lib/suggest'
import { novelListSelect, toNovelListItem } from '@/lib/novel-list'
import type { PseoPageData } from '@/lib/types'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ kw: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { kw: rawKw } = await params
  // decodeURIComponent 对畸形转义序列（如 %zz）会抛 URIError，必须兜底
  let decoded: string
  try {
    decoded = decodeURIComponent(rawKw)
  } catch {
    decoded = rawKw
  }
  const keyword = sanitizeKeyword(decoded)
  if (!keyword) return NextResponse.json({ error: '关键词不能为空' }, { status: 400 })

  const row = await db.pseoKeyword.findUnique({ where: { keyword } })

  // 优先使用已生成的聚合数据
  if (row?.status === 'generated' && row.pageData) {
    try {
      const saved = JSON.parse(row.pageData) as { novelIds: number[]; title: string; description: string; keywords: string }
      const novels = await db.novel.findMany({
        where: { id: { in: saved.novelIds } },
        orderBy: { clicks: 'desc' },
        select: novelListSelect,
      })
      const data: PseoPageData = {
        keyword,
        novels: novels.map(toNovelListItem),
        generatedTitle: saved.title,
        generatedDescription: saved.description,
        generatedKeywords: saved.keywords,
      }
      return NextResponse.json(data)
    } catch { /* 落入实时计算 */ }
  }

  // 实时计算
  const parts = keyword.split(/\s+/).filter(Boolean)
  const or = parts.flatMap((p) => [
    { title: { contains: p } },
    { author: { contains: p } },
    { description: { contains: p } },
    { category: { is: { name: { contains: p } } } },
  ])
  let novels = await db.novel.findMany({ where: { OR: or }, orderBy: { clicks: 'desc' }, take: 12, select: novelListSelect })
  if (novels.length < 3) {
    novels = await db.novel.findMany({ orderBy: { clicks: 'desc' }, take: 12, select: novelListSelect })
  }
  const setting = await db.siteSetting.findUnique({ where: { id: 1 } })
  const siteName = setting?.siteName ?? '青阅文学'
  const data: PseoPageData = {
    keyword,
    novels: novels.map(toNovelListItem),
    generatedTitle: `${keyword}小说推荐_关于${keyword}的小说 - ${siteName}`,
    generatedDescription: `${siteName}为您精选与“${keyword}”相关的小说合集，包含 ${novels.length} 本热门作品，在线免费阅读。`,
    generatedKeywords: `${keyword},${keyword}小说,${keyword}推荐`,
  }
  return NextResponse.json(data)
}
