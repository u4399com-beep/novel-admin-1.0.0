'use client'

/**
 * 书籍页「相关标签」行 —— PSEO 种子词 chips（全主题通用中性样式）。
 *
 * 数据来源：GET /api/novels/{id} 的 tags 字段（backend-go novelPseoTags）：
 * ① 书名种子词（pseo 自动种子的主词，聚合页按书名 LIKE 命中本书）
 * ② 作者词（聚合页命中该作者全部作品）
 * ③ 已生成的含书名长尾词（下拉词扩展，如「XX全文阅读」）
 * 点击标签跳转 {name:'pseo'} 聚合页（PseoView，通用实现）。
 * tags 为空（如该书尚未登记种子）时整行不渲染。
 */
import type { ThemeView } from '@/themes/types'
import { cn } from '@/lib/utils'

interface NovelTagsRowProps {
  tags: string[]
  navigate: (view: ThemeView) => void
  /** 外层追加类（各主题按自己的间距/配色微调） */
  className?: string
}

export function NovelTagsRow({ tags, navigate, className }: NovelTagsRowProps) {
  if (!tags || tags.length === 0) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className="text-xs font-medium text-neutral-500">相关标签：</span>
      {tags.map((kw) => (
        <button
          key={kw}
          type="button"
          onClick={() => navigate({ name: 'pseo', keyword: kw })}
          className="cursor-pointer rounded-full border border-neutral-300 bg-neutral-100/80 px-2.5 py-0.5 text-xs leading-5 text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-200"
          aria-label={`查看标签「${kw}」相关小说聚合页`}
        >
          {kw}
        </button>
      ))}
    </div>
  )
}
