'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { coverBgClass } from '@/lib/covers'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'
import type { NovelListItem } from '@/lib/types'
import type { ThemeView } from '../types'

/* ==================== 格式化工具 ==================== */

export function fmtWan(n: number): string {
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

export function fmtWords(n: number): string {
  return `${fmtWan(n)}字`
}

/* 日期格式化与 lib/format.formatDate 完全同实现，直接共享（保持 fmtDate 导出名不变） */
export { formatDate as fmtDate } from '@/lib/format'

export function statusLabel(s: string): string {
  return s === 'finished' ? '完本' : '连载中'
}

export function dedupMerge(lists: NovelListItem[][], limit: number): NovelListItem[] {
  const seen = new Set<number>()
  const out: NovelListItem[] = []
  for (const list of lists) {
    for (const n of list) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      out.push(n)
      if (out.length >= limit) return out
    }
  }
  return out
}

/* ==================== 区块标题（左 4px 蓝竖条，源站 .section-title 2rem/主色 #0f172a） ==================== */

export function SectionTitle({
  title,
  small,
  action,
}: {
  title: ReactNode
  small?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-3">
      <h2 className="border-l-4 border-[#2563eb] pl-4 text-[20px] leading-7 font-semibold text-[#0f172a]">
        {title}
        {small ? <span className="ml-3 text-[13px] font-normal text-[#94a3b8]">{small}</span> : null}
      </h2>
      {action}
    </div>
  )
}

/* ==================== 胶囊徽章（分类实心 / 状态浅底 / 字数描边） ==================== */

export function CatBadge({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="cursor-pointer rounded-full bg-[#2563eb] px-2.5 py-[3px] text-[12px] leading-4 text-white transition-colors duration-200 hover:bg-[#1d4ed8]"
    >
      {children}
    </button>
  )
}

export function SoftBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#dbe4f0] bg-[#e8f1ff] px-2.5 py-[3px] text-[12px] leading-4 text-[#2563eb]">
      {children}
    </span>
  )
}

export function GhostBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-[#dbe4f0] bg-transparent px-2.5 py-[3px] text-[12px] leading-4 text-[#64748b]">
      {children}
    </span>
  )
}

/* ==================== 渐变封面（无外链图片） ==================== */

export function Cover({
  token,
  title,
  className,
  charClassName,
}: {
  token: string
  title: string
  className?: string
  charClassName?: string
}) {
  return (
    <div
      className={cn(
        'relative flex shrink-0 select-none items-center justify-center overflow-hidden bg-gradient-to-br',
        coverBgClass(token),
        className,
      )}
    >
      <NovelCoverImg novel={{ title, cover: token }} />
      {!isLocalCover(token) && (
        <span className={cn('font-bold text-white/90', charClassName ?? 'text-[40px]')}>
          {title.slice(0, 1)}
        </span>
      )}
    </div>
  )
}

/* ==================== 文字书卡（首页 / 分类页共用） ==================== */

export function BookTextCard({
  novel,
  navigate,
}: {
  novel: NovelListItem
  navigate: (v: ThemeView) => void
}) {
  return (
    <article className="group cursor-pointer rounded-[10px] border border-[#e6edf7] bg-white p-5 shadow-[0_1px_3px_rgba(37,99,235,0.06)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_18px_rgba(37,99,235,0.12)]">
      <h3
        onClick={() => navigate({ name: 'book', novelId: novel.id })}
        className="truncate text-[16px] font-semibold text-[#1e293b] transition-colors duration-200 group-hover:text-[#2563eb]"
      >
        {novel.title}
      </h3>
      <p className="mt-1 truncate text-[13px] text-[#64748b]">作者：{novel.author}</p>
      <p
        onClick={() => navigate({ name: 'book', novelId: novel.id })}
        className="mt-2 line-clamp-2 min-h-[40px] text-[14px] leading-5 text-[#64748b]"
      >
        {novel.description || '暂无简介'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <CatBadge onClick={() => navigate({ name: 'category', categoryId: novel.categoryId })}>
          {novel.categoryName}
        </CatBadge>
        <SoftBadge>{statusLabel(novel.status)}</SoftBadge>
        <GhostBadge>{fmtWords(novel.wordCount)}</GhostBadge>
      </div>
    </article>
  )
}

/* ==================== 排行榜行（源站 .ranking-item：编号徽章 + 书名 + 右浮作者） ==================== */

export function RankRow({
  novel,
  index,
  navigate,
}: {
  novel: NovelListItem
  index: number
  navigate: (v: ThemeView) => void
}) {
  /* 源站编号徽章 18×18 圆角 10px，前三名蓝系渐深，其余浅蓝灰底 */
  const badge =
    index === 0
      ? 'bg-[#2563eb] text-white'
      : index === 1
        ? 'bg-[#6692f1] text-white'
        : index === 2
          ? 'bg-[#acc7f4] text-white'
          : 'bg-[#e8f1ff] text-[#64748b]'
  return (
    <li className="flex items-center gap-3 border-b border-[#dbe4f0] px-4 py-2 transition-colors duration-200 last:border-b-0 hover:bg-[#e8f1ff]">
      <span className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[10px] text-[12px] font-bold ${badge}`}>
        {index + 1}
      </span>
      <button
        onClick={() => navigate({ name: 'book', novelId: novel.id })}
        className="min-w-0 flex-1 cursor-pointer truncate text-left text-[16px] font-medium text-[#1e293b] transition-colors duration-200 hover:text-[#2563eb]"
      >
        {novel.title}
      </button>
      <span className="max-w-[100px] shrink-0 truncate text-right text-[14px] text-[#64748b]">{novel.author}</span>
    </li>
  )
}

/* ==================== 面包屑 ==================== */

export function Crumb({
  items,
  navigate,
}: {
  items: { label: string; view?: ThemeView }[]
  navigate: (v: ThemeView) => void
}) {
  return (
    <nav className="flex flex-wrap items-center gap-1.5 text-[15px]">
      {/* 源站 breadcrumb 1.5rem */}
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-[#cbd5e1]">/</span>}
          {it.view ? (
            <button
              onClick={() => navigate(it.view!)}
              className="cursor-pointer text-[#64748b] transition-colors duration-200 hover:text-[#2563eb]"
            >
              {it.label}
            </button>
          ) : (
            <span className="max-w-[240px] truncate text-[#94a3b8]">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

/* ==================== 骨架屏 ==================== */

export function Skel({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-[#dbe4f0]/70', className)} />
}

export function CardSkeleton() {
  return (
    <div className="rounded-[10px] border border-[#e6edf7] bg-white p-5">
      <Skel className="h-4 w-1/2" />
      <Skel className="mt-2 h-3 w-1/4" />
      <Skel className="mt-3 h-3 w-full" />
      <Skel className="mt-2 h-3 w-5/6" />
      <div className="mt-4 flex gap-2">
        <Skel className="h-5 w-16 rounded-full" />
        <Skel className="h-5 w-14 rounded-full" />
        <Skel className="h-5 w-14 rounded-full" />
      </div>
    </div>
  )
}

export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  )
}

export function RankSkeleton() {
  return (
    <div className="overflow-hidden rounded-[10px] border border-[#e6edf7] bg-white">
      <div className="border-b border-[#dbe4f0] bg-[#f0f4fb] px-4 py-3">
        <Skel className="h-4 w-1/3" />
      </div>
      <div className="p-2">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="flex items-center justify-between px-2 py-2">
            <Skel className="h-3 w-2/5" />
            <Skel className="h-3 w-1/5" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function PillSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
      {Array.from({ length: count }, (_, i) => (
        <Skel key={i} className="h-11 rounded-full" />
      ))}
    </div>
  )
}

/* ==================== 错误态（重试） ==================== */

export function ErrorBox({ msg, onRetry }: { msg?: string; onRetry: () => void }) {
  return (
    <div className="rounded-[10px] border border-[#dbe4f0] bg-white p-12 text-center shadow-sm">
      <p className="text-[15px] text-[#64748b]">数据加载失败{msg ? `（${msg}）` : ''}，请检查网络后重试</p>
      <button
        onClick={onRetry}
        className="mt-5 cursor-pointer rounded-[10px] bg-[#2563eb] px-10 py-2.5 text-[14px] text-white transition-colors duration-200 hover:bg-[#1d4ed8]"
      >
        重试
      </button>
    </div>
  )
}

/* ==================== 空状态 ==================== */

export function EmptyBox({ text }: { text: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-[#dbe4f0] bg-white/70 p-12 text-center text-[14px] text-[#94a3b8]">
      {text}
    </div>
  )
}
