'use client'

/**
 * trxsw（唐人小说网 trxsw.com / 葡萄模板风）共享 UI 原子件 —— 葡萄系 980px 圆角蓝框区块
 * 配色令牌：主强调 #FF6600 / 错误红 #FF3300 / 品牌强调 #c42205（源站 .sys）/
 *          区块框 2px #a6d3e8 / 区块底 #f7fbfd / 区块标题条 #e1eced /
 *          导航 #88c6e5（hover #459df5）/ 分类黄条 #fff9d9 边 #fc3 /
 *          链接 #6f78a7 / hover #FF6600 / 正文 #666 / 标题 #333 / 阅读底 #e9faff
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
        'relative flex shrink-0 select-none items-center justify-center overflow-hidden',
        coverBgClass(novel.cover),
        className,
      )}
    >
      <NovelCoverImg novel={novel} />
      {!isLocalCover(novel.cover) && (
        <span className={cn('font-bold tracking-widest text-white/95 drop-shadow-sm', charClass)}>
          {novel.title.trim().charAt(0) || '书'}
        </span>
      )}
    </div>
  )
}

/* ==================== 葡萄式区块：2px 蓝框圆角 + 30px 标题条（源站 .l/.r 圆角盒） ==================== */

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
    <section className={cn('rounded-[10px] border-2 border-[#a6d3e8] bg-[#f7fbfd]', className)}>
      <header className="flex h-[30px] items-center justify-between rounded-t-[8px] border-b border-[#a6d3e8] bg-[#e1eced] px-3">
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
              className="cursor-pointer text-[#6f78a7] hover:text-[#FF6600] hover:underline"
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
      className={cn('animate-pulse rounded-[10px] border-2 border-[#a6d3e8] bg-[#f7fbfd]', className)}
    >
      <div className="h-[30px] rounded-t-[8px] border-b border-[#a6d3e8] bg-[#e1eced]" />
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
    <div className="flex flex-col items-center gap-3 border border-dashed border-[#a6d3e8] bg-[#FAFAFA] px-6 py-12 text-center">
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
          className="flex items-center gap-1.5 border-b border-dotted border-[#a6d3e8] py-[4px] text-xs last:border-b-0"
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
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-[#6f78a7] hover:text-[#FF6600] hover:underline"
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
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-dotted border-[#a6d3e8] px-1 py-2 text-xs leading-[16px] hover:bg-[#FBFBFB] md:grid-cols-[64px_minmax(0,1fr)_minmax(0,1.4fr)_64px_52px] md:items-center md:py-[7px]"
    >
      <span className="hidden truncate text-[#999] md:block">[{novel.categoryName}]</span>
      <span className="truncate font-medium text-[#6f78a7]">{novel.title}</span>
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
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-dotted border-[#a6d3e8] px-2 py-2 text-xs hover:bg-[#FBFBFB] md:grid-cols-[minmax(0,18fr)_minmax(0,46fr)_minmax(0,13fr)_minmax(0,8fr)_minmax(0,9fr)_minmax(0,6fr)] md:items-center md:py-[7px]"
    >
      <span className="truncate font-medium text-[#6f78a7]">{novel.title}</span>
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
  const idle = 'border-[#a6d3e8] bg-white text-[#6f78a7] hover:border-[#FF6600] hover:text-[#FF6600]'
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
