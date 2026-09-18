'use client'

/**
 * trxsw（天天中文风）共享 UI 原子件 —— 杰奇经典 960px 系
 * 配色令牌：主强调 #FF6600 / 错误红 #FF3300 / 品牌红 #C00 /
 *          边框 #E4E4E4 / 表头底 #F2F2F2 / 亮条 #D9EDFF+#33CCFF /
 *          链接 #2F468F / hover #FF6600 / 正文 #666 / 标题 #333 / 阅读底 #E6F3FF
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { coverBgClass } from '@/lib/covers'
import type { NovelListItem } from '@/lib/types'
import type { ThemeView, ViewProps } from '../types'

/* ==================== 格式化工具 ==================== */

export function formatWords(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`
  return String(n)
}

export function shortDate(s?: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s.slice(5, 10)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fullDate(s?: string | null): string {
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
        'flex shrink-0 select-none items-center justify-center overflow-hidden',
        coverBgClass(novel.cover),
        className,
      )}
    >
      <span className={cn('font-bold tracking-widest text-white/95 drop-shadow-sm', charClass)}>
        {novel.title.trim().charAt(0) || '书'}
      </span>
    </div>
  )
}

/* ==================== 杰奇式区块：2px 亮条 + 40px 渐变标题栏 ==================== */

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
    <section className={cn('border border-[#E4E4E4] border-t-2 border-t-[#33CCFF] bg-white', className)}>
      <header className="flex h-10 items-center justify-between border-b border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E9E9E9] px-3">
        <h2 className="text-sm font-bold text-[#333]">{title}</h2>
        {extra ? <div className="text-[11px] text-[#999]">{extra}</div> : null}
      </header>
      <div className={cn('p-3', bodyClass)}>{children}</div>
    </section>
  )
}

/* ==================== 面包屑（无框细行） ==================== */

export function Crumbs({
  items,
  navigate,
  className,
}: {
  items: { label: string; view?: ThemeView }[]
  navigate: ViewProps['navigate']
  className?: string
}) {
  return (
    <nav className={cn('flex flex-wrap items-center gap-1 text-xs text-[#999]', className)}>
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-[#D5D5D5]">›</span>}
          {it.view ? (
            <button
              type="button"
              onClick={() => navigate(it.view as ThemeView)}
              className="cursor-pointer text-[#2F468F] hover:text-[#FF6600] hover:underline"
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
    <div
      aria-hidden
      className={cn('animate-pulse border border-[#E4E4E4] border-t-2 border-t-[#BFE9F7] bg-white', className)}
    >
      <div className="h-10 border-b border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E9E9E9]" />
      <div className="space-y-2.5 p-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-4 bg-[#F0F0F0]" style={{ width: `${90 - ((i * 13) % 38)}%` }} />
        ))}
      </div>
    </div>
  )
}

export function SkeletonLines({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden className={cn('animate-pulse space-y-2.5', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 bg-[#F0F0F0]" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
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
    <div className="flex flex-col items-center gap-3 border border-dashed border-[#E4E4E4] bg-[#FAFAFA] px-6 py-12 text-center">
      <p className="text-sm text-[#999]">{message}，请检查网络后重试</p>
      <button
        type="button"
        onClick={onRetry}
        className="cursor-pointer bg-[#FF6600] px-5 py-1.5 text-sm text-white transition-colors hover:bg-[#E05A00]"
      >
        重新加载
      </button>
    </div>
  )
}

/* ==================== 榜单行（序号 + 书名 + 右浮数字） ==================== */

export function RankRows({
  novels,
  navigate,
  limit = 15,
  value = 'clicks',
}: {
  novels: NovelListItem[]
  navigate: ViewProps['navigate']
  limit?: number
  value?: 'clicks' | 'words'
}) {
  if (novels.length === 0) return <p className="py-4 text-center text-xs text-[#999]">暂无数据</p>
  return (
    <ol>
      {novels.slice(0, limit).map((n, i) => (
        <li
          key={n.id}
          className="flex items-center gap-1.5 border-b border-dotted border-[#E4E4E4] py-[4px] text-xs last:border-b-0"
        >
          <span
            className={cn(
              'w-4 shrink-0 text-center font-bold',
              i < 3 ? 'text-[#FF3300]' : 'text-[#BBB]',
            )}
          >
            {i + 1}
          </span>
          <button
            type="button"
            onClick={() => navigate({ name: 'book', novelId: n.id })}
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-[#2F468F] hover:text-[#FF6600] hover:underline"
            title={n.title}
          >
            {n.title}
          </button>
          <span className="shrink-0 text-[10px] text-[#999]">
            {formatWords(value === 'clicks' ? n.clicks : n.wordCount)}
          </span>
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
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-dotted border-[#E4E4E4] px-1 py-2 text-xs leading-[16px] hover:bg-[#FBFBFB] md:grid-cols-[64px_minmax(0,1fr)_minmax(0,1.4fr)_64px_52px] md:items-center md:py-[7px]"
    >
      <span className="hidden truncate text-[#999] md:block">[{novel.categoryName}]</span>
      <span className="truncate font-medium text-[#2F468F]">{novel.title}</span>
      <span className="col-span-2 order-last truncate text-[#888] md:order-none md:col-span-1">
        {novel.lastChapterTitle ?? '连载中…'}
      </span>
      <span className="hidden truncate text-[#999] md:block">{novel.author}</span>
      <span className="truncate text-right text-[#999] md:text-left">{shortDate(novel.updatedAt)}</span>
    </div>
  )
}

/* ==================== 六列数据行（书名18%/最新章节46%/作者13%/字数8%/更新9%/状态6%） ==================== */

export function BookRow({
  novel,
  navigate,
}: {
  novel: NovelListItem
  navigate: ViewProps['navigate']
}) {
  return (
    <div
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-dotted border-[#E4E4E4] px-2 py-2 text-xs hover:bg-[#FBFBFB] md:grid-cols-[minmax(0,18fr)_minmax(0,46fr)_minmax(0,13fr)_minmax(0,8fr)_minmax(0,9fr)_minmax(0,6fr)] md:items-center md:py-[7px]"
    >
      <span className="truncate font-medium text-[#2F468F]">{novel.title}</span>
      <span className="hidden truncate text-[#666] md:block">{novel.lastChapterTitle ?? '—'}</span>
      <span className="hidden truncate text-[#666] md:block">{novel.author}</span>
      <span className="hidden text-right text-[#999] md:block">{formatWords(novel.wordCount)}</span>
      <span className="truncate text-right text-[#999] md:text-left">{shortDate(novel.updatedAt)}</span>
      <span
        className={cn(
          'hidden text-center md:block',
          novel.status === 'finished' ? 'text-[#FF6600]' : 'text-[#999]',
        )}
      >
        {statusText(novel.status)}
      </span>
    </div>
  )
}

/* ==================== 分页（橙红当前页） ==================== */

export function pageWindow(page: number, total: number): (number | 'gap')[] {
  if (total <= 9) return Array.from({ length: total }, (_, i) => i + 1)
  const out: (number | 'gap')[] = [1]
  if (page > 3) out.push('gap')
  for (let i = Math.max(2, page - 1); i <= Math.min(total - 1, page + 1); i++) out.push(i)
  if (page < total - 2) out.push('gap')
  out.push(total)
  return out
}

export function Pager({
  page,
  totalPages,
  onPage,
  className,
}: {
  page: number
  totalPages: number
  onPage: (p: number) => void
  className?: string
}) {
  if (totalPages <= 1) return null
  const items = pageWindow(page, totalPages)
  const base = 'min-w-[28px] cursor-pointer border px-2 py-1 text-center text-xs transition-colors'
  const idle = 'border-[#E4E4E4] bg-white text-[#2F468F] hover:border-[#FF6600] hover:text-[#FF6600]'
  const off = 'cursor-not-allowed border-[#F0F0F0] bg-[#FAFAFA] text-[#CCC]'
  return (
    <nav className={cn('flex flex-wrap items-center justify-center gap-1.5 pt-3', className)}>
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className={cn(base, page <= 1 ? off : idle)}
      >
        上一页
      </button>
      {items.map((it, i) =>
        it === 'gap' ? (
          <span key={`gap-${i}`} className="px-1 text-xs text-[#999]">
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            onClick={() => onPage(it)}
            className={cn(base, it === page ? 'border-[#FF6600] bg-[#FF6600] font-bold text-white' : idle)}
          >
            {it}
          </button>
        ),
      )}
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        className={cn(base, page >= totalPages ? off : idle)}
      >
        下一页
      </button>
    </nav>
  )
}
