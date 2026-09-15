import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { HomeData, NovelListItem } from '@/lib/types'

export const dynamic = 'force-dynamic'

const listSelect = {
  id: true,
  title: true,
  author: true,
  description: true,
  cover: true,
  categoryId: true,
  category: { select: { name: true } },
  status: true,
  isFeatured: true,
  isHot: true,
  wordCount: true,
  clicks: true,
  updatedAt: true,
  _count: { select: { chapters: true } },
  chapters: { orderBy: { idx: 'desc' as const }, take: 1, select: { title: true } },
}

type Row = {
  id: number
  title: string
  author: string
  description: string
  cover: string
  categoryId: number
  category: { name: string } | null
  status: string
  isFeatured: boolean
  isHot: boolean
  wordCount: number
  clicks: number
  updatedAt: Date
  _count: { chapters: number }
  chapters: { title: string }[]
}

function toListItem(r: Row): NovelListItem {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    description: r.description,
    cover: r.cover,
    categoryId: r.categoryId,
    categoryName: r.category?.name ?? '未分类',
    status: r.status === 'finished' ? 'finished' : 'serial',
    isFeatured: r.isFeatured,
    isHot: r.isHot,
    wordCount: r.wordCount,
    clicks: r.clicks,
    chapterCount: r._count.chapters,
    lastChapterTitle: r.chapters[0]?.title ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function GET() {
  const dayAgo = new Date(Date.now() - 24 * 3600_000)

  const [featured, hot, latest, clickRank, updateRank, finishedRank, categories, novelCount, chapterCount, agg, todayUpdates] =
    await Promise.all([
      db.novel.findMany({ where: { isFeatured: true }, orderBy: { updatedAt: 'desc' }, take: 12, select: listSelect }),
      db.novel.findMany({ where: { isHot: true }, orderBy: { clicks: 'desc' }, take: 10, select: listSelect }),
      db.novel.findMany({ orderBy: { updatedAt: 'desc' }, take: 14, select: listSelect }),
      db.novel.findMany({ orderBy: { clicks: 'desc' }, take: 10, select: listSelect }),
      db.novel.findMany({ orderBy: { updatedAt: 'desc' }, take: 10, select: listSelect }),
      db.novel.findMany({ where: { status: 'finished' }, orderBy: { clicks: 'desc' }, take: 10, select: listSelect }),
      db.category.findMany({ orderBy: { sort: 'asc' }, select: { id: true, name: true, sort: true, _count: { select: { novels: true } } } }),
      db.novel.count(),
      db.chapter.count(),
      db.novel.aggregate({ _sum: { wordCount: true } }),
      db.chapter.count({ where: { createdAt: { gte: dayAgo } } }),
    ])

  const data: HomeData = {
    featured: featured.map(toListItem),
    hot: hot.map(toListItem),
    latest: latest.map(toListItem),
    rankings: {
      clicks: clickRank.map(toListItem),
      updates: updateRank.map(toListItem),
      finished: finishedRank.map(toListItem),
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
