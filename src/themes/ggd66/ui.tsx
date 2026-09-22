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
  return s === 'finished' ? '已完本' : '连载中'
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

/** 深青绿链接：hover 橙 */
export const linkCls =
  'cursor-pointer text-[#00886d] transition-colors duration-200 hover:text-[#f50]'

/* ==================== h2 区块标题（18px #333 下实线边框） ==================== */

export function GH2({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        'mb-2 border-b border-[#ccc] pb-[6px] text-[18px] font-medium text-[#333]',
        className,
      )}
    >
      {children}
    </h2>
  )
}

/* ==================== 标签胶囊（红系 / 蓝系） ==================== */

export function RedTag({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="cursor-pointer rounded-[3px] border border-[#ffb0b4] px-2 py-[1px] text-[12px] leading-[18px] text-[#bf2c24] transition-colors duration-200 hover:border-[#f50] hover:text-[#f50]"
    >
      {children}
    </button>
  )
}

export function BlueTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-[3px] border border-[#89d4ff] px-2 py-[1px] text-[12px] leading-[18px] text-[#3f5a93]">
      {children}
    </span>
  )
}

/* ==================== 渐变封面（无外链图片） ==================== */

export function GCover({
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
        <span className={cn('font-bold text-white/90', charClassName ?? 'text-[28px]')}>
          {title.slice(0, 1)}
        </span>
      )}
    </div>
  )
}

/* ==================== 面包屑（浅绿底 » 分隔） ==================== */

export function GBreadcrumb({
  items,
  navigate,
}: {
  items: { label: string; view?: ThemeView }[]
  navigate: (v: ThemeView) => void
}) {
  return (
    <ol className="mb-3 flex flex-wrap items-center gap-1 rounded-[4px] border border-[#ccc] bg-[#cdf3eb] px-3 py-2 text-[13px] text-[#666]">
      {items.map((it, i) => (
        <li key={`${it.label}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="px-0.5 text-[#666]">»</span>}
          {it.view ? (
            <button onClick={() => navigate(it.view!)} className={linkCls}>
              {it.label}
            </button>
          ) : (
            <span className="max-w-[260px] truncate">{it.label}</span>
          )}
        </li>
      ))}
    </ol>
  )
}

/* ==================== 骨架屏 ==================== */

export function GSkel({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-[3px] bg-[#eee]', className)} />
}

export function GRowSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex h-[28px] items-center gap-3 border-b border-dashed border-[#ccc]">
          <GSkel className="h-3 w-[50px]" />
          <GSkel className="h-3 flex-1" />
          <GSkel className="h-3 w-[70px]" />
        </div>
      ))}
    </div>
  )
}

export function GBoxSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="relative rounded-[4px] border border-dashed border-[#ccc] p-[10px]">
          <GSkel className="absolute -top-2 -left-2 h-[22px] w-[22px] rounded-[4px]" />
          <GSkel className="h-4 w-2/3" />
          <GSkel className="mt-2 h-3 w-1/2" />
          <GSkel className="mt-2 h-3 w-full" />
          <GSkel className="mt-1 h-3 w-5/6" />
        </div>
      ))}
    </div>
  )
}

export function GCoverSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex gap-3">
          <GSkel className="h-[150px] w-[120px]" />
          <div className="flex-1 space-y-2 pt-1">
            <GSkel className="h-4 w-2/3" />
            <GSkel className="h-3 w-1/3" />
            <GSkel className="h-3 w-full" />
            <GSkel className="h-3 w-full" />
            <GSkel className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ==================== 错误态 / 空状态 ==================== */

export function GErrorBox({ msg, onRetry }: { msg?: string; onRetry: () => void }) {
  return (
    <div className="rounded-[4px] border border-[#ccc] bg-white p-10 text-center text-[14px] text-[#888]">
      <p>数据加载失败{msg ? `（${msg}）` : ''}，请稍后重试</p>
      <button
        onClick={onRetry}
        className="mt-4 cursor-pointer rounded-[4px] bg-[#56ccb5] px-8 py-2 text-[14px] text-white transition-colors duration-200 hover:bg-[#48b9a2]"
      >
        重 试
      </button>
    </div>
  )
}

export function GEmptyBox({ text }: { text: string }) {
  return (
    <div className="rounded-[4px] border border-dashed border-[#ccc] bg-white p-10 text-center text-[14px] text-[#999]">
      {text}
    </div>
  )
}
