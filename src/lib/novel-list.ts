/**
 * 小说列表行的共用 select 与 DTO 映射（服务端专用）：
 * /api/home、/api/novels(GET)、/api/pseo/[kw] 与 pseo.ts 聚合查询共用同一份
 * 字段清单（含最新一章标题、章节数）与 NovelListItem 映射，避免四处拷贝漂移。
 */
import type { NovelListItem } from '@/lib/types'

/** 列表/聚合页共用的小说行 select：含分类名、章节数与最新一章标题 */
export const novelListSelect = {
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
} as const

/** novelListSelect 查询结果的结构化类型（与 Prisma 推导一致；category 留 null 余量） */
export type NovelListRow = {
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

/** 数据库行 → 前端列表 DTO（NovelListItem，updatedAt 转字符串） */
export function toNovelListItem(r: NovelListRow): NovelListItem {
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
