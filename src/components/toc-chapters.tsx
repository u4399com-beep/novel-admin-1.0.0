'use client'

import { useMemo, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { ChapterListItem } from '@/lib/types'

/**
 * 主题无关的「章节目录列表」共享组件。
 *
 * - 分栏显示：章节容器用 CSS 多列流式布局（columns-*），条目按列自上而下排列
 *   （1,2,3 竖排完再排第二列），替代 grid 行优先造成的阅读顺序错乱。
 * - 分卷分组：检测到非空 volume 时按「连续相同 volume」分段，每段一个独立 section，
 *   卷头在列外（不会被分栏切断），卷内章节再分栏；全部 volume 为空时退化为单层
 *   columns 容器，不渲染任何卷头/多余 DOM。
 * - 视觉中性：组件只负责结构/布局/truncate/键盘可达（button），颜色字号等交给主题
 *   通过 className props 注入。
 * - 长目录（800+ 章）直接 map 渲染，与各主题现状一致。
 */

export interface TocChaptersProps {
  /** 章节列表（后端按 idx 升序；主题如需倒序请自行翻转后再传入，分组在传入顺序上进行） */
  chapters: ChapterListItem[]
  /** 章节跳转（主题的 navigate，ThemeView 联合类型的超集，可直接传入） */
  navigate: (view: { name: 'chapter'; chapterId: number }) => void
  /** 章节条目附加类（主题的链接色/hover/字号/内边距等）；函数形式可按条目返回不同类（已读灰、书签高亮等） */
  itemClassName?: string | ((chapter: ChapterListItem) => string)
  /** 分卷标题条附加类（仅存在分卷数据时渲染；默认左右分布，传 justify-center 可居中） */
  volumeClassName?: string
  /** 卷内章数徽标附加类 */
  countClassName?: string
  /** 覆盖默认分栏类（columns-* + gap-x-*） */
  columnsClassName?: string
  /** 自定义条目内部内容（默认渲染 truncate 标题；外层 button/截断/点击由组件负责） */
  renderItem?: (chapter: ChapterListItem) => ReactNode
}

/** 默认分栏：375px 单列，逐级升到 4 列 */
const DEFAULT_COLUMNS = 'columns-1 gap-x-6 sm:columns-2 lg:columns-3 xl:columns-4'

/** 条目中性基础样式：块级铺满列宽 + 分栏防截断 + truncate + text-left */
const ITEM_BASE = 'block w-full cursor-pointer break-inside-avoid truncate text-left'

/** 卷头中性基础样式：左右分布（名称 + 章数），主题可覆盖对齐方式 */
const VOLUME_BASE = 'flex items-center justify-between gap-2 break-inside-avoid'
const COUNT_BASE = 'shrink-0 font-normal tabular-nums'

interface VolumeSegment {
  volume: string
  items: ChapterListItem[]
}

/** 按「连续相同 volume」分段；全部为空时返回 null（无卷结构，走单列表径） */
function groupByVolume(chapters: ChapterListItem[]): VolumeSegment[] | null {
  if (!chapters.some((c) => c.volume !== '')) return null
  const segments: VolumeSegment[] = []
  for (const c of chapters) {
    const last = segments[segments.length - 1]
    if (last && last.volume === c.volume) {
      last.items.push(c)
    } else {
      segments.push({ volume: c.volume, items: [c] })
    }
  }
  return segments
}

export function TocChapters({
  chapters,
  navigate,
  itemClassName,
  volumeClassName,
  countClassName,
  columnsClassName,
  renderItem,
}: TocChaptersProps) {
  const segments = useMemo(() => groupByVolume(chapters), [chapters])
  const columns = columnsClassName || DEFAULT_COLUMNS

  const renderItems = (items: ChapterListItem[]) =>
    items.map((c) => (
      <button
        key={c.id}
        type="button"
        onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
        title={c.title}
        className={cn(ITEM_BASE, typeof itemClassName === 'function' ? itemClassName(c) : itemClassName)}
      >
        {renderItem ? renderItem(c) : c.title}
      </button>
    ))

  /* 无分卷：单层 columns 容器，与既有展示兼容（不多渲染任何卷头 DOM） */
  if (!segments) {
    return <div className={columns}>{renderItems(chapters)}</div>
  }

  /* 有分卷：每卷独立 section（卷头在列外），卷内章节再分栏 */
  return (
    <div className="space-y-4">
      {segments.map((seg, i) => (
        <section key={`${seg.volume}-${i}`}>
          {seg.volume !== '' && (
            <div className={cn(VOLUME_BASE, volumeClassName)}>
              <span className="min-w-0 truncate">{seg.volume}</span>
              <span className={cn(COUNT_BASE, countClassName)}>{seg.items.length} 章</span>
            </div>
          )}
          <div className={columns}>{renderItems(seg.items)}</div>
        </section>
      ))}
    </div>
  )
}
