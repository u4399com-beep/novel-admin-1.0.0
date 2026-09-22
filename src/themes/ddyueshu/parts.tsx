'use client'

import type { CSSProperties } from 'react'
import { coverBgClass } from '@/lib/covers'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'
import { cn } from '@/lib/utils'
import type { ChapterListItem, NovelListItem } from '@/lib/types'
import type { ThemeView } from '../types'

/* ==================== 格式化 ==================== */

export function fmtWords(n: number | null | undefined): string {
  const v = n ?? 0
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)}亿字`
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万字`
  return `${v}字`
}

export function fmtNum(n: number | null | undefined): string {
  const v = n ?? 0
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`
  return String(v)
}

export function fmtDate(s: string | null | undefined): string {
  return (s ?? '').slice(0, 10)
}

/** 分类展示名：名称已含「小说」后缀则不重复追加（避免「其他小说小说」） */
export function catLabel(name: string): string {
  return /小说$/.test(name) ? name : `${name}小说`
}

/* ==================== 书签（localStorage） ==================== */

export function getMarks(key: string): number[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(window.localStorage.getItem(`dd-marks-${key}`) ?? '[]') as number[]
  } catch {
    return []
  }
}

export function toggleMark(key: string, id: number): boolean {
  try {
    const arr = getMarks(key)
    const has = arr.includes(id)
    const next = has ? arr.filter((x) => x !== id) : [...arr.slice(-199), id]
    window.localStorage.setItem(`dd-marks-${key}`, JSON.stringify(next))
    return !has
  } catch {
    return false
  }
}

/* ==================== 封面（渐变 + 首字，直角） ==================== */

export function Cover({
  novel,
  className,
  charClass = 'text-[20px]',
}: {
  novel: Pick<NovelListItem, 'title' | 'cover'>
  className?: string
  charClass?: string
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'relative flex flex-none select-none items-center justify-center overflow-hidden border border-[#a6d3e8] text-white',
        coverBgClass(novel.cover),
        className
      )}
    >
      <NovelCoverImg novel={novel} />
      {!isLocalCover(novel.cover) && (
        <span className={cn('dd-hei font-bold tracking-[0.15em] [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]', charClass)}>
          {(novel.title || '书').slice(0, 1)}
        </span>
      )}
    </div>
  )
}

/* ==================== 骨架屏 / 错误态 ==================== */

export function Sk({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={cn('animate-pulse bg-black/[0.08]', className)} style={style} />
}

export function SkRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-1', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Sk key={i} className="h-[25px]" style={{ width: `${100 - (i % 4) * 6}%` }} />
      ))}
    </div>
  )
}

export function ErrBlock({ msg, onRetry }: { msg?: string; onRetry: () => void }) {
  return (
    <div className="dd-box m-2 bg-white p-6 text-center">
      <p className="dd-hottext text-[13px]">数据加载失败{msg ? `：${msg}` : ''}</p>
      <button
        onClick={onRetry}
        className="mt-3 h-[28px] cursor-pointer bg-[#88c6e5] px-4 text-[13px] font-bold text-white transition-colors hover:bg-[#459df5]"
      >
        重新加载
      </button>
    </div>
  )
}

/* ==================== 行列表 ==================== */

/** 最近更新行：[分类] 书名 最新章节 作者 日期 */
export function UpdateRow({
  novel,
  navigate,
  showChapter = true,
}: {
  novel: NovelListItem
  navigate: (v: ThemeView) => void
  showChapter?: boolean
}) {
  return (
    <div
      className="dd-row25 flex cursor-pointer items-center gap-1.5 px-1 transition-colors hover:bg-white"
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
    >
      <span className="w-[70px] flex-none truncate text-[#999]">[{novel.categoryName}]</span>
      <span className="dd-link w-[120px] flex-none truncate">{novel.title}</span>
      {showChapter && (
        <span className="min-w-0 flex-1 truncate text-[#555]">{novel.lastChapterTitle ?? '即将更新…'}</span>
      )}
      <span className="hidden w-[70px] flex-none truncate text-[#b3b3b3] sm:block">{novel.author}</span>
      <span className="w-[72px] flex-none truncate text-right text-[#b3b3b3]">{fmtDate(novel.updatedAt)}</span>
    </div>
  )
}

/** 简单行：[分类] 书名 作者/日期 */
export function SimpleRow({
  novel,
  navigate,
  showDate = false,
}: {
  novel: NovelListItem
  navigate: (v: ThemeView) => void
  showDate?: boolean
}) {
  return (
    <div
      className="dd-row25 flex cursor-pointer items-center gap-1.5 px-1 transition-colors hover:bg-white"
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
    >
      <span className="w-[62px] flex-none truncate text-[#999]">[{novel.categoryName}]</span>
      <span className="dd-link min-w-0 flex-1 truncate">{novel.title}</span>
      {showDate ? (
        <span className="flex-none text-[#b3b3b3]">{fmtDate(novel.updatedAt)}</span>
      ) : (
        <span className="w-[56px] flex-none truncate text-right text-[#b3b3b3]">{novel.author}</span>
      )}
    </div>
  )
}

/** dl>dd 章节项（33% 三栏） */
export function DdChapter({
  chapter,
  navigate,
}: {
  chapter: ChapterListItem
  navigate: (v: ThemeView) => void
}) {
  return (
    <div className="dd-dd-item">
      <button onClick={() => navigate({ name: 'chapter', chapterId: chapter.id })}>{chapter.title}</button>
    </div>
  )
}

/* ==================== 强推封面卡（120×150 封面 + 点线书名 + 简介） ==================== */

export function CoverItem({
  novel,
  navigate,
  descH = 'h-[120px]',
}: {
  novel: NovelListItem
  navigate: (v: ThemeView) => void
  descH?: string
}) {
  return (
    <article
      className="flex cursor-pointer gap-2.5"
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
    >
      <Cover novel={novel} className="h-[150px] w-[120px]" charClass="text-[28px]" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="dd-link border-b border-dotted border-[#9db4c0] pb-1 text-[14px] font-bold leading-[20px] text-[#333] transition-colors hover:text-[#cc0000]">
          {novel.title}
        </span>
        <span className="mt-0.5 truncate text-[#b3b3b3]">
          作者：{novel.author} · {novel.categoryName}
        </span>
        <p className={cn('mt-1 overflow-hidden text-[12px] leading-[19px] text-[#555] [text-indent:2em]', descH)}>
          {novel.description}
        </p>
      </div>
    </article>
  )
}

/* ==================== 表头行（分类/书名/最新章节/作者/日期） ==================== */

export function TableHead({ showChapter = true }: { showChapter?: boolean }) {
  return (
    <div className="dd-row25 flex items-center gap-1.5 px-1 text-[#777]">
      <span className="w-[70px] flex-none">分类</span>
      <span className="w-[120px] flex-none">书名</span>
      {showChapter && <span className="min-w-0 flex-1">最新章节</span>}
      <span className="hidden w-[70px] flex-none sm:block">作者</span>
      <span className="w-[72px] flex-none text-right">日期</span>
    </div>
  )
}
