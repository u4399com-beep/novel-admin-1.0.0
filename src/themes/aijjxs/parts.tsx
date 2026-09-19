'use client'

import type { CSSProperties, ReactNode } from 'react'
import { coverBgClass, gradientClass } from '@/lib/covers'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'
import { cn } from '@/lib/utils'
import type { NovelListItem } from '@/lib/types'
import type { ThemeView } from '../types'

/* ==================== 格式化工具 ==================== */

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

export function todayStr(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/* ==================== 已读记录（localStorage） ==================== */

export function readMarkGet(key: string): number[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(window.localStorage.getItem(key) ?? '[]') as number[]
  } catch {
    return []
  }
}

export function markRead(key: string, id: number): void {
  try {
    const arr = readMarkGet(key)
    if (!arr.includes(id)) {
      arr.push(id)
      window.localStorage.setItem(key, JSON.stringify(arr.slice(-600)))
    }
  } catch {
    /* 忽略存储异常 */
  }
}

/* ==================== 渐变封面（首字 + 渐变，无外链图片） ==================== */

export function Cover({
  novel,
  className,
  rounded = 'rounded-[8px]',
  charClass = 'text-[22px]',
}: {
  novel: Pick<NovelListItem, 'title' | 'cover'>
  className?: string
  rounded?: string
  charClass?: string
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'relative flex flex-none select-none items-center justify-center overflow-hidden text-white shadow-[inset_0_0_24px_rgba(0,0,0,0.18)]',
        coverBgClass(novel.cover),
        rounded,
        className
      )}
    >
      <NovelCoverImg novel={novel} />
      {!isLocalCover(novel.cover) && (
        <span className={cn('font-bold tracking-[0.2em] [text-shadow:0_1px_4px_rgba(0,0,0,0.35)]', charClass)}>
          {(novel.title || '书').slice(0, 1)}
        </span>
      )}
    </div>
  )
}

/* ==================== 面板骨架 ==================== */

export function Panel({
  title,
  extra,
  cream,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode
  extra?: ReactNode
  cream?: boolean
  className?: string
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <section className={cn('aj-card overflow-hidden', cream && 'aj-card-cream', className)}>
      <header className="aj-panel-head">
        <span className="aj-panel-bar" aria-hidden />
        <h2 className="aj-panel-title">{title}</h2>
        {extra ? <div className="ml-auto">{extra}</div> : null}
      </header>
      <div className={cn('p-3 sm:p-4', bodyClassName)}>{children}</div>
    </section>
  )
}

/* ==================== 骨架屏 / 错误态 ==================== */

export function Sk({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-black/[0.08]', className)} style={style} />
}

export function SkRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Sk key={i} className="h-8" style={{ width: `${100 - (i % 4) * 7}%` }} />
      ))}
    </div>
  )
}

export function ErrBlock({ msg, onRetry }: { msg?: string; onRetry: () => void }) {
  return (
    <div className="aj-card m-3 p-8 text-center">
      <p className="text-[15px] text-[#b45309]">数据加载失败{msg ? `：${msg}` : ''}</p>
      <button onClick={onRetry} className="aj-btn aj-btn-teal mt-4">
        重新加载
      </button>
    </div>
  )
}

/* ==================== 列表行 / 榜单 / 作者云 ==================== */

export function NovelTextRow({
  novel,
  navigate,
  showChip = true,
  showAuthor = true,
  showDate = true,
}: {
  novel: NovelListItem
  navigate: (v: ThemeView) => void
  showChip?: boolean
  showAuthor?: boolean
  showDate?: boolean
}) {
  return (
    <div className="aj-row" onClick={() => navigate({ name: 'book', novelId: novel.id })}>
      {showChip && <span className="aj-chip">{novel.categoryName}</span>}
      <span className="aj-row-title min-w-0 flex-1">{novel.title}</span>
      {showAuthor && <span className="hidden flex-none text-xs text-[#6b7280] sm:inline">{novel.author}</span>}
      {showDate && (
        <span
          className={cn(
            'flex-none text-xs tabular-nums',
            fmtDate(novel.updatedAt) === todayStr() ? 'font-semibold text-[#e11d48]' : 'text-[#9ca3af]'
          )}
        >
          {fmtDate(novel.updatedAt)}
        </span>
      )}
    </div>
  )
}

export function RankList({
  novels,
  navigate,
  limit = 10,
}: {
  novels: NovelListItem[]
  navigate: (v: ThemeView) => void
  limit?: number
}) {
  return (
    <ol className="mt-1">
      {novels.slice(0, limit).map((n, i) => (
        <li key={n.id}>
          <div className="aj-row py-[5px]" onClick={() => navigate({ name: 'book', novelId: n.id })}>
            <span
              className={cn(
                'w-5 flex-none text-center text-[13px] font-bold tabular-nums',
                i < 3 ? 'text-[#9a3412]' : 'text-[#c2854f]'
              )}
            >
              {i + 1}
            </span>
            <span className="aj-row-title min-w-0 flex-1">{n.title}</span>
            <span className="flex-none text-[11px] tabular-nums text-[#9ca3af]">{fmtNum(n.clicks)}</span>
          </div>
        </li>
      ))}
    </ol>
  )
}

export function AuthorCloud({
  authors,
  navigate,
  className,
}: {
  authors: string[]
  navigate: (v: ThemeView) => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {authors.map((a) => (
        <button
          key={a}
          onClick={() => navigate({ name: 'search', query: a })}
          className="rounded-full bg-[#eef9f7] px-3 py-1.5 text-xs text-[#0f766e] transition-colors hover:bg-[#0f766e] hover:text-white"
        >
          {a}
        </button>
      ))}
    </div>
  )
}

export function collectAuthors(lists: NovelListItem[][], max = 18): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const n of list) {
      if (n.author && !seen.has(n.author)) {
        seen.add(n.author)
        out.push(n.author)
        if (out.length >= max) return out
      }
    }
  }
  return out
}

/* ==================== 封面推荐卡（88×122 左封右文） ==================== */

export function CoverCard({
  novel,
  navigate,
}: {
  novel: NovelListItem
  navigate: (v: ThemeView) => void
}) {
  return (
    <article
      className="group flex cursor-pointer gap-3"
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
    >
      <Cover novel={novel} className="h-[122px] w-[88px]" />
      <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-1.5 text-[15px] font-bold text-[#1f2937] transition-colors group-hover:text-[#0f766e]">
          <span className="min-w-0 truncate">{novel.title}</span>
          {novel.isHot && <span className="aj-badge">新</span>}
        </h3>
        <p className="mt-1 truncate text-xs text-[#6b7280]">
          {novel.categoryName} · {novel.author} · {fmtWords(novel.wordCount)}
        </p>
        <p className="mt-1.5 line-clamp-3 text-[13px] leading-[1.6] text-[#6b7280]">{novel.description}</p>
      </div>
    </article>
  )
}

/* ==================== 分页器 ==================== */

export function Pager({
  page,
  totalPages,
  go,
}: {
  page: number
  totalPages: number
  go: (p: number) => void
}) {
  if (totalPages <= 1) return null
  const nums: number[] = []
  const start = Math.max(1, Math.min(page - 3, totalPages - 6))
  for (let p = start; p <= Math.min(totalPages, start + 6); p++) nums.push(p)
  return (
    <nav className="flex flex-wrap items-center justify-center gap-1.5 py-4" aria-label="分页">
      <button className="aj-pager-btn" disabled={page <= 1} onClick={() => go(1)}>
        首页
      </button>
      <button className="aj-pager-btn" disabled={page <= 1} onClick={() => go(page - 1)}>
        上一页
      </button>
      {nums.map((p) => (
        <button key={p} className="aj-pager-btn" aria-current={p === page} onClick={() => go(p)}>
          {p}
        </button>
      ))}
      <button className="aj-pager-btn" disabled={page >= totalPages} onClick={() => go(page + 1)}>
        下一页
      </button>
      <button className="aj-pager-btn" disabled={page >= totalPages} onClick={() => go(totalPages)}>
        尾页
      </button>
    </nav>
  )
}

/* ==================== 头像渐变令牌 ==================== */

export function avatarGradient(i: number): string {
  return gradientClass(`g${(i % 12) + 1}`)
}
