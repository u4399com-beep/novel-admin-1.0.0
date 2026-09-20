import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { novelListSelect, toNovelListItem } from '@/lib/novel-list'
import type { HomeData } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  const dayAgo = new Date(Date.now() - 24 * 3600_000)

  const [featured, hot, latest, clickRank, updateRank, finishedRank, categories, novelCount, chapterCount, agg, todayUpdates] =
    await Promise.all([
      db.novel.findMany({ where: { isFeatured: true }, orderBy: { updatedAt: 'desc' }, take: 12, select: novelListSelect }),
      db.novel.findMany({ where: { isHot: true }, orderBy: { clicks: 'desc' }, take: 10, select: novelListSelect }),
      db.novel.findMany({ orderBy: { updatedAt: 'desc' }, take: 14, select: novelListSelect }),
      db.novel.findMany({ orderBy: { clicks: 'desc' }, take: 10, select: novelListSelect }),
      db.novel.findMany({ orderBy: { updatedAt: 'desc' }, take: 10, select: novelListSelect }),
      db.novel.findMany({ where: { status: 'finished' }, orderBy: { clicks: 'desc' }, take: 10, select: novelListSelect }),
      db.category.findMany({ orderBy: { sort: 'asc' }, select: { id: true, name: true, sort: true, _count: { select: { novels: true } } } }),
      db.novel.count(),
      db.chapter.count(),
      db.novel.aggregate({ _sum: { wordCount: true } }),
      db.chapter.count({ where: { createdAt: { gte: dayAgo } } }),
    ])

  const data: HomeData = {
    featured: featured.map(toNovelListItem),
    hot: hot.map(toNovelListItem),
    latest: latest.map(toNovelListItem),
    rankings: {
      clicks: clickRank.map(toNovelListItem),
      updates: updateRank.map(toNovelListItem),
      finished: finishedRank.map(toNovelListItem),
    },
    categories: categories.map((c) => ({ id: c.id, name: c.name, sort: c.sort, novelCount: c._count.novels })),
    stats: {
      novelCount,
      chapterCount,
      totalWordCount: agg._sum.wordCount ?? 0,
      todayUpdates,
    },
  }

  return NextResponse.json(data)
}
