'use client'

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ChapterListItem } from '@/lib/types'

/**
 * 主题无关的「章节目录列表」共享组件。
 *
 * - 分栏显示：章节容器用 CSS 多列流式布局（columns-*），条目按列自上而下排列
 *   （1,2,3 竖排完再排第二列），替代 grid 行优先造成的阅读顺序错乱。
 * - 视觉中性：组件只负责结构/布局/truncate/键盘可达（button），颜色字号等交给主题
 *   通过 className props 注入。
 * - 长目录（800+ 章）直接 map 渲染，与各主题现状一致。
 * - 注：分卷分组分支已随 Chapter.volume 字段从 schema 移除而删除
 *   （API /api/novels/[id]/chapters 不返回 volume）；章节标题原样渲染。
 */

export interface TocChaptersProps {
  /** 章节列表（后端按 idx 升序；主题如需倒序请自行翻转后再传入，分组在传入顺序上进行） */
  chapters: ChapterListItem[]
  /** 章节跳转（主题的 navigate，ThemeView 联合类型的超集，可直接传入） */
  navigate: (view: { name: 'chapter'; chapterId: number }) => void
  /** 章节条目附加类（主题的链接色/hover/字号/内边距等）；函数形式可按条目返回不同类（已读灰、书签高亮等） */
  itemClassName?: string | ((chapter: ChapterListItem) => string)
  /** 覆盖默认分栏类（columns-* + gap-x-*） */
  columnsClassName?: string
  /** 自定义条目内部内容（默认渲染 truncate 标题；外层 button/截断/点击由组件负责） */
  renderItem?: (chapter: ChapterListItem) => ReactNode
}

/** 默认分栏：375px 单列，逐级升到 4 列 */
const DEFAULT_COLUMNS = 'columns-1 gap-x-6 sm:columns-2 lg:columns-3 xl:columns-4'

/** 条目中性基础样式：块级铺满列宽 + 分栏防截断 + truncate + text-left */
const ITEM_BASE = 'block w-full cursor-pointer break-inside-avoid truncate text-left'

export function TocChapters({
  chapters,
  navigate,
  itemClassName,
  columnsClassName,
  renderItem,
}: TocChaptersProps) {
  const columns = columnsClassName || DEFAULT_COLUMNS

  return (
    <div className={columns}>
      {chapters.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
          title={c.title}
          className={cn(ITEM_BASE, typeof itemClassName === 'function' ? itemClassName(c) : itemClassName)}
        >
          {renderItem ? renderItem(c) : c.title}
        </button>
      ))}
    </div>
  )
}
