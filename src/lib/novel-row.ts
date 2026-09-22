/**
 * 小说列表行 → 前台条目（单一来源，12-g 收敛）。
 *
 * 此前 /api/home 与 lib/pseo.ts 各自维护同构的 select 对象 + Row 类型 + toListItem
 * 映射（字段完全相同，双份漂移风险）；现统一为本模块的 novelListSelect /
 * NovelListRow / toNovelListItem，两端共用。
 *
 * 使用方式：Prisma findMany({ select: novelListSelect }) → rows.map(toNovelListItem)。
 */
import type { NovelListItem } from '@/lib/types'

/** 首页/分类列表/PSEO 聚合页共用的书籍查询列（含最新一章标题与章节数） */
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

/** novelListSelect 的查询结果行形态 */
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

/** Prisma 行 → 前台 NovelListItem（/api/home、/api/pseo/[kw] 与 /pseo/[kw] 落地页共用） */
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
