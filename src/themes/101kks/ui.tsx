'use client'

// ==================== 101kks 主题共享 UI 件 ====================
// 设计事实来源：/home/z/site-analysis/specs/101kks.md
// 蓝白扁平工具风：宝蓝 #1f6cb2 单一主色 + 浅灰底白色 3px 小圆角轻投影卡片

import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { coverBgClass } from '@/lib/covers'
import type { NovelListItem } from '@/lib/types'

// ---------- 常量 ----------

export const PRIMARY = '#1f6cb2'
export const PRIMARY_HOVER = '#06c'
export const ACCENT_RED = '#e84118'

// ---------- 格式化 ----------

export function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 萬字`
  return `${n} 字`
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

// ---------- 分类意图（首页快捷按钮 → 分类页初始筛选） ----------

export interface CategoryIntent {
  sort?: 'latest' | 'clicks' | 'words'
  status?: 'serial' | 'finished'
}

let pendingIntent: CategoryIntent | null = null

export function setCategoryIntent(intent: CategoryIntent | null): void {
  pendingIntent = intent
}

export function takeCategoryIntent(): CategoryIntent | null {
  const it = pendingIntent
  pendingIntent = null
  return it
}

// ---------- 书架 / 书签（localStorage） ----------

const SHELF_KEY = '101kks.shelf'
const BOOKMARK_KEY = '101kks.bookmarks'

export interface BookmarkRec {
  chapterId: number
  title: string
}

export function loadShelf(): number[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(window.localStorage.getItem(SHELF_KEY) ?? '[]') as number[]
  } catch {
    return []
  }
}

export function toggleShelf(id: number): boolean {
  if (typeof window === 'undefined') return false
  const arr = loadShelf()
  const has = arr.includes(id)
  const next = has ? arr.filter((x) => x !== id) : [...arr, id]
  window.localStorage.setItem(SHELF_KEY, JSON.stringify(next))
  return !has
}

export function loadBookmarks(): Record<string, BookmarkRec> {
  if (typeof window === 'undefined') return {}
  try {
    return JSON.parse(window.localStorage.getItem(BOOKMARK_KEY) ?? '{}') as Record<string, BookmarkRec>
  } catch {
    return {}
  }
}

export function saveBookmark(novelId: number, rec: BookmarkRec): void {
  if (typeof window === 'undefined') return
  try {
    const all = loadBookmarks()
    all[String(novelId)] = rec
    window.localStorage.setItem(BOOKMARK_KEY, JSON.stringify(all))
  } catch {
    /* 存储不可用时静默降级 */
  }
}

// ---------- 基础件 ----------

/** 窄栏容器：1112px 居中 */
export function Container({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-[1112px] px-3 sm:px-4', className)}>{children}</div>
}

/** 卡片基类（.mybox 同构）：白底 / radius 3px / 双值轻投影 */
export function MyBox({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section className={cn('rounded-[3px] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,.12),0_1px_2px_rgba(0,0,0,.24)] sm:p-5', className)}>
      {children}
    </section>
  )
}

/** 节标题基类（.mytitle 同构）：16px + 底部浅分隔线 */
export function SectionTitle({
  children,
  right,
  className,
}: {
  children: React.ReactNode
  right?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3 border-b border-black/10 pb-2', className)}>
      <h2 className="text-base font-bold text-[#333]">{children}</h2>
      {right}
    </div>
  )
}

/** 浅蓝标签胶囊 */
export function BlueTag({
  children,
  onClick,
  active,
  className,
}: {
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-[26px] cursor-pointer items-center whitespace-nowrap rounded-[10px] border px-2.5 text-[12.8px] transition-colors',
        active
          ? 'border-[#1f6cb2] bg-[#dcecfa] font-bold text-[#1f6cb2]'
          : 'border-[#56a6c3] bg-[rgb(232,244,255)] text-[#1f6cb2] hover:bg-[#dcecfa]',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** 蓝底白字主按钮（radius 4~5px，hover 加深 + 投影） */
export function BlueBtn({
  children,
  onClick,
  disabled,
  small,
  className,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  small?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[5px] bg-[#1f6cb2] text-white transition-all hover:bg-[#06c] hover:shadow-[0_2px_6px_rgba(0,0,0,.2)]',
        small ? 'h-8 px-3 text-[13px]' : 'h-9 px-4 text-sm',
        disabled && 'cursor-not-allowed opacity-45 hover:shadow-none',
        className,
      )}
    >
      {children}
    </button>
  )
}

// ---------- 封面（渐变 + 书名首字，禁止外链图片） ----------

/** 封面渐变面 */
export function CoverFace({
  title,
  cover,
  className,
  charClass = 'text-3xl',
}: {
  title: string
  cover: string
  className?: string
  charClass?: string
}) {
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden', coverBgClass(cover), className)}>
      <span className={cn('font-bold text-white/90 drop-shadow', charClass)}>{title.slice(0, 1)}</span>
    </div>
  )
}

/** 封面卡（分类/搜索网格用）：封面 + 单行书名 + 作者 */
export function CoverCard({ novel, onClick }: { novel: NovelListItem; onClick: () => void }) {
  return (
    <div
      className="group min-w-0 cursor-pointer select-none"
      onClick={onClick}
    >
      <CoverFace
        title={novel.title}
        cover={novel.cover}
        className="aspect-[3/4] w-full rounded-[3px] shadow-[0_1px_3px_rgba(0,0,0,.2)] transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-[0_4px_10px_rgba(0,0,0,.25)]"
        charClass="text-3xl sm:text-4xl"
      />
      <p className="mt-1.5 truncate text-[13px] text-[#333] transition-colors group-hover:text-[#06c]">{novel.title}</p>
      <p className="truncate text-xs text-[#888]">{novel.author}</p>
    </div>
  )
}

// ---------- 状态件 ----------

/** 错误态 + 重试 */
export function ErrorRetry({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-sm text-[#888]">{message ?? '數據載入失敗，請重試'}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[5px] bg-[#1f6cb2] px-6 text-sm text-white transition-colors hover:bg-[#06c]"
      >
        <RotateCcw className="h-4 w-4" />
        重新載入
      </button>
    </div>
  )
}

const bone = 'animate-pulse rounded-[3px] bg-[#e9ecef]'

/** 封面网格骨架 */
export function GridSkeleton({ count = 12, cols = 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6' }: { count?: number; cols?: string }) {
  return (
    <div className={cn('grid gap-3', cols)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <div className={cn(bone, 'aspect-[3/4] w-full')} />
          <div className={cn(bone, 'mt-1.5 h-3.5 w-3/4')} />
          <div className={cn(bone, 'mt-1 h-3 w-1/2')} />
        </div>
      ))}
    </div>
  )
}

/** 详情页骨架 */
export function BookSkeleton() {
  return (
    <div className="space-y-4">
      <MyBox>
        <div className="flex flex-col gap-5 sm:flex-row">
          <div className={cn(bone, 'h-[240px] w-[180px] shrink-0 self-center sm:self-start')} />
          <div className="min-w-0 flex-1 space-y-3">
            <div className={cn(bone, 'h-7 w-2/3')} />
            <div className={cn(bone, 'h-4 w-1/2')} />
            <div className={cn(bone, 'h-4 w-3/5')} />
            <div className="flex gap-2 pt-2">
              <div className={cn(bone, 'h-9 w-24')} />
              <div className={cn(bone, 'h-9 w-24')} />
              <div className={cn(bone, 'h-9 w-24')} />
            </div>
          </div>
        </div>
      </MyBox>
      <MyBox>
        <div className={cn(bone, 'h-5 w-32')} />
        <div className="mt-4 space-y-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={cn(bone, 'h-5 w-full')} />
          ))}
        </div>
      </MyBox>
    </div>
  )
}

/** 正文页骨架 */
export function ChapterSkeleton() {
  return (
    <div>
      <div className={cn(bone, 'mx-auto h-5 w-40')} />
      <div className={cn(bone, 'mx-auto mt-3 h-4 w-56')} />
      <div className="mt-8 space-y-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className={cn(bone, 'h-4')} style={{ width: `${90 + ((i * 5) % 10)}%` }} />
        ))}
      </div>
    </div>
  )
}

// ---------- 分页（.page1 同构药丸条） ----------

export function Pager({ page, totalPages, onGo }: { page: number; totalPages: number; onGo: (p: number) => void }) {
  if (totalPages <= 1) return null
  const nums: (number | '…')[] = []
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) {
      if (nums[nums.length - 1] !== p) nums.push(p)
    } else if (nums[nums.length - 1] !== '…') {
      nums.push('…')
    }
  }
  const base =
    'inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-[3px] border px-2 text-sm transition-colors'
  return (
    <nav className="flex flex-wrap items-center justify-center gap-1.5 py-2">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onGo(page - 1)}
        className={cn(base, 'border-[#cfd8e0] bg-[#fafbfc] text-[#333] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40')}
      >
        <ChevronLeft className="h-4 w-4" />
        上一頁
      </button>
      {nums.map((n, i) =>
        n === '…' ? (
          <span key={`e${i}`} className="px-1 text-[#888]">
            …
          </span>
        ) : (
          <button
            key={n}
            type="button"
            onClick={() => onGo(n)}
            className={cn(
              base,
              n === page
                ? 'border-[#1f6cb2] bg-[#1f6cb2] font-bold text-white'
                : 'border-[#cfd8e0] bg-[#fafbfc] text-[#333] hover:bg-white hover:text-[#06c]',
            )}
          >
            {n}
          </button>
        ),
      )}
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onGo(page + 1)}
        className={cn(base, 'border-[#cfd8e0] bg-[#fafbfc] text-[#333] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40')}
      >
        下一頁
        <ChevronRight className="h-4 w-4" />
      </button>
    </nav>
  )
}
