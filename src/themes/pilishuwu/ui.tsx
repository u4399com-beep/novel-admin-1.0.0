'use client'

/**
 * pilishuwu（飞速小说风）共享 UI 原子件 —— 经典杰奇蓝白系
 * 配色令牌：主色 #3B76A8 / hover 橙 #FF6600 / 边框 #BFD8EA /
 *          标题栏 #EAF3FB / 链接 #3366BB / 强调红 #CC0000 / 次要 #999
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { coverBgClass } from '@/lib/covers'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'
import type { NovelListItem } from '@/lib/types'
import type { ThemeView, ViewProps } from '../types'

/* ==================== 格式化工具 ==================== */

export function formatWords(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}

export function formatDate(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s.slice(0, 10)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function statusText(s: NovelListItem['status']): string {
  return s === 'finished' ? '完本' : '连载'
}

/* ==================== 渐变封面（书名首字，禁外链图片） ==================== */

export function Cover({
  novel,
  className,
  charClass = 'text-4xl',
}: {
  novel: Pick<NovelListItem, 'cover' | 'title'>
  className?: string
  charClass?: string
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'relative flex shrink-0 select-none items-center justify-center overflow-hidden',
        coverBgClass(novel.cover),
        className,
      )}
    >
      <NovelCoverImg novel={novel} />
      {!isLocalCover(novel.cover) && (
        <span className={cn('font-serif font-bold text-white/90 drop-shadow-sm', charClass)}>
          {novel.title.trim().charAt(0) || '书'}
        </span>
      )}
    </div>
  )
}

/* ==================== 杰奇式区块：30px 标题条 + 细蓝边白盒 ==================== */

export function Block({
  title,
  extra,
  children,
  bodyClass,
  className,
}: {
  title: ReactNode
  extra?: ReactNode
  children: ReactNode
  bodyClass?: string
  className?: string
}) {
  return (
    <section className={cn('border border-[#BFD8EA] bg-white', className)}>
      <header className="flex h-[30px] items-center justify-between border-b border-[#BFD8EA] bg-[#EAF3FB] px-3">
        <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-[#2F5E8C]">
          <span aria-hidden className="h-3 w-[3px] bg-[#3B76A8]" />
          {title}
        </h2>
        {extra ? <div className="text-[11px] text-[#999]">{extra}</div> : null}
      </header>
      <div className={cn('p-3', bodyClass)}>{children}</div>
    </section>
  )
}

/* ==================== 面包屑 ==================== */

export function Crumbs({
  items,
  navigate,
}: {
  items: { label: string; view?: ThemeView }[]
  navigate: ViewProps['navigate']
}) {
  return (
    <nav className="flex flex-wrap items-center gap-1 border border-[#BFD8EA] bg-white px-3 py-1.5 text-xs">
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-[#C9DEEF]">›</span>}
          {it.view ? (
            <button
              type="button"
              onClick={() => navigate(it.view as ThemeView)}
              className="cursor-pointer text-[#3366BB] hover:text-[#FF6600] hover:underline"
            >
              {it.label}
            </button>
          ) : (
            <span className="text-[#666]">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

/* ==================== 骨架屏 / 错误态 ==================== */

export function SkeletonBlock({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden className={cn('animate-pulse border border-[#BFD8EA] bg-white', className)}>
      <div className="h-[30px] border-b border-[#BFD8EA] bg-[#EAF3FB]" />
      <div className="space-y-2.5 p-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 bg-[#E4EEF7]" style={{ width: `${90 - ((i * 13) % 38)}%` }} />
        ))}
      </div>
    </div>
  )
}

export function SkeletonLines({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden className={cn('animate-pulse space-y-2.5', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 bg-[#E4EEF7]" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  )
}

export function ErrorBox({
  onRetry,
  message = '数据加载失败',
}: {
  onRetry: () => void
  message?: string
}) {
  return (
    <div className="flex flex-col items-center gap-3 border border-dashed border-[#BFD8EA] bg-white px-6 py-12 text-center">
      <p className="text-sm text-[#999]">{message}，请检查网络后重试</p>
      <button
        type="button"
        onClick={onRetry}
        className="cursor-pointer bg-[#3B76A8] px-5 py-1.5 text-sm text-white transition-colors hover:bg-[#2F6FA3]"
      >
        重新加载
      </button>
    </div>
  )
}

/* ==================== 排行榜（序号 + 书名，前三名红） ==================== */

export function RankList({
  novels,
  navigate,
  limit = 10,
}: {
  novels: NovelListItem[]
  navigate: ViewProps['navigate']
  limit?: number
}) {
  if (novels.length === 0) return <p className="py-4 text-center text-xs text-[#999]">暂无数据</p>
  return (
    <ol>
      {novels.slice(0, limit).map((n, i) => (
        <li
          key={n.id}
          className="flex items-center gap-2 border-b border-dotted border-[#DCE9F5] py-[5px] text-xs last:border-b-0"
        >
          <span
            className={cn(
              'w-4 shrink-0 text-center font-bold',
              i < 3 ? 'text-[#CC0000]' : 'text-[#8FB4D4]',
            )}
          >
            {i + 1}
          </span>
          <button
            type="button"
            onClick={() => navigate({ name: 'book', novelId: n.id })}
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-[#3366BB] hover:text-[#FF6600] hover:underline"
            title={n.title}
          >
            {n.title}
          </button>
          <span className="shrink-0 text-[10px] text-[#999]">{n.categoryName}</span>
        </li>
      ))}
    </ol>
  )
}

/* ==================== 五段式更新行（分类/书名/最新章节/作者/时间） ==================== */

export function UpdateRow({
  novel,
  navigate,
}: {
  novel: NovelListItem
  navigate: ViewProps['navigate']
}) {
  return (
    <div
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-dotted border-[#D5E6F3] px-1 py-2 text-xs hover:bg-[#F7FBFF] md:grid-cols-[70px_minmax(0,1fr)_minmax(0,1.3fr)_76px_64px] md:items-center md:py-[7px]"
    >
      <span className="hidden truncate text-[#999] md:block">[{novel.categoryName}]</span>
      <span className="truncate font-medium text-[#3366BB]">{novel.title}</span>
      <span className="col-span-2 order-last truncate text-[#888] md:order-none md:col-span-1">
        {novel.lastChapterTitle ?? '连载中…'}
      </span>
      <span className="hidden truncate text-[#999] md:block">{novel.author}</span>
      <span className="truncate text-right text-[#999] md:text-left">{formatDate(novel.updatedAt)}</span>
    </div>
  )
}

/* ==================== 六段式结果行（书名/最新章节/作者/字数/更新/状态） ==================== */

export function ResultRow({
  novel,
  navigate,
}: {
  novel: NovelListItem
  navigate: ViewProps['navigate']
}) {
  return (
    <div
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-dotted border-[#D5E6F3] px-1 py-2 text-xs hover:bg-[#F7FBFF] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_74px_56px_66px_38px] md:items-center md:py-[7px]"
    >
      <span className="truncate font-medium text-[#3366BB]">{novel.title}</span>
      <span className="hidden truncate text-[#888] md:block">{novel.lastChapterTitle ?? '—'}</span>
      <span className="hidden truncate text-[#999] md:block">{novel.author}</span>
      <span className="hidden text-right text-[#999] md:block">{formatWords(novel.wordCount)}</span>
      <span className="truncate text-right text-[#999] md:text-left">{formatDate(novel.updatedAt)}</span>
      <span
        className={cn(
          'hidden text-center md:block',
          novel.status === 'finished' ? 'text-[#2E8B57]' : 'text-[#CC0000]',
        )}
      >
        {statusText(novel.status)}
      </span>
    </div>
  )
}
