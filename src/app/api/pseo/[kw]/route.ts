import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { PseoPageData, NovelListItem } from '@/lib/types'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ kw: string }> }

function toItem(r: {
  id: number; title: string; author: string; description: string; cover: string; categoryId: number
  category: { name: string } | null; status: string; isFeatured: boolean; isHot: boolean
  wordCount: number; clicks: number; updatedAt: Date
  _count: { chapters: number }; chapters: { title: string }[]
}): NovelListItem {
  return {
    id: r.id, title: r.title, author: r.author, description: r.description, cover: r.cover,
    categoryId: r.categoryId, categoryName: r.category?.name ?? '未分类',
    status: r.status === 'finished' ? 'finished' : 'serial',
    isFeatured: r.isFeatured, isHot: r.isHot, wordCount: r.wordCount, clicks: r.clicks,
    chapterCount: r._count.chapters, lastChapterTitle: r.chapters[0]?.title ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }
}

const fullSelect = {
  id: true, title: true, author: true, description: true, cover: true, categoryId: true,
  category: { select: { name: true } }, status: true, isFeatured: true, isHot: true,
  wordCount: true, clicks: true, updatedAt: true,
  _count: { select: { chapters: true } },
  chapters: { orderBy: { idx: 'desc' as const }, take: 1, select: { title: true } },
} as const

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { kw: rawKw } = await params
  const keyword = decodeURIComponent(rawKw).trim()
  if (!keyword) return NextResponse.json({ error: '关键词不能为空' }, { status: 400 })

  const row = await db.pseoKeyword.findUnique({ where: { keyword } })

  // 优先使用已生成的聚合数据
  if (row?.status === 'generated' && row.pageData) {
    try {
      const saved = JSON.parse(row.pageData) as { novelIds: number[]; title: string; description: string; keywords: string }
      const novels = await db.novel.findMany({
        where: { id: { in: saved.novelIds } },
        orderBy: { clicks: 'desc' },
        select: fullSelect,
      })
      const data: PseoPageData = {
        keyword,
        novels: novels.map(toItem),
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
  let novels = await db.novel.findMany({ where: { OR: or }, orderBy: { clicks: 'desc' }, take: 12, select: fullSelect })
  if (novels.length < 3) {
    novels = await db.novel.findMany({ orderBy: { clicks: 'desc' }, take: 12, select: fullSelect })
  }
  const setting = await db.siteSetting.findUnique({ where: { id: 1 } })
  const siteName = setting?.siteName ?? '青阅文学'
  const data: PseoPageData = {
    keyword,
    novels: novels.map(toItem),
    generatedTitle: `${keyword}小说推荐_关于${keyword}的小说 - ${siteName}`,
    generatedDescription: `${siteName}为您精选与“${keyword}”相关的小说合集，包含 ${novels.length} 本热门作品，在线免费阅读。`,
    generatedKeywords: `${keyword},${keyword}小说,${keyword}推荐`,
  }
  return NextResponse.json(data)
}
