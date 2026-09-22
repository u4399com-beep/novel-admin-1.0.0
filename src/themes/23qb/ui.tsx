'use client'

// ==================== 23qb 主题共享 UI 件 ====================
// 设计事实来源：/home/z/site-analysis/specs/23qb.md
// 浅灰底 #f8f9f9 + 白色 18px 大圆角卡片 + 红橙渐变强调 + 大扩散投影

import { useState } from 'react'
import { FileText, Flame, RotateCcw, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { coverBgClass } from '@/lib/covers'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'
import type { ChapterListItem, NovelListItem } from '@/lib/types'
import type { ThemeView } from '../types'

// ---------- 常量 ----------

/** 主强调：橙→红渐变（按钮 / 选中态） */
export const GRADIENT_ACCENT = 'linear-gradient(90deg, #ff9800, #ff2a14)'
/** 次强调：绿渐变（推荐类） */
export const GRADIENT_GREEN = 'linear-gradient(90deg, #7ec53d, #34a853)'

/** 封面榜角标色（1/2/3 名 + 其余） */
const RANK_COVER_COLORS = ['#e50914', '#ff7733', '#ffa82e']
/** 文字榜前三名颜色 */
const RANK_TEXT_COLORS = ['#fc4274', '#ff8155', '#fcb80a']

// ---------- 格式化 ----------

export function fmtWords(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`
  return `${n} 字`
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

// ---------- 阅读进度（书签） ----------

interface BookmarkRec {
  chapterId: number
  title: string
}

const BOOKMARK_KEY = '23qb.bookmarks'

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

/** 内容容器：1740px 起阶梯收缩 */
export function Container({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1150px] px-4 md:max-w-[1240px] md:px-6 lg:max-w-[1520px] xl:max-w-[1740px]', className)}>
      {children}
    </div>
  )
}

/** 白色大圆角卡片（radius 18px + 大投影） */
export function Card({
  className,
  children,
  style,
}: {
  className?: string
  children: React.ReactNode
  style?: React.CSSProperties
}) {
  return (
    <section className={cn('rounded-[18px] bg-white shadow-[0_7px_21px_rgba(149,157,165,.22)]', className)} style={style}>
      {children}
    </section>
  )
}

/** 药丸筛选钮（35px 高 / radius 10px / 选中加粗） */
export function Pill({
  active,
  onClick,
  children,
}: {
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-[35px] cursor-pointer items-center rounded-[10px] px-4 text-sm transition-colors',
        active ? 'bg-[#f3f5f7] font-bold text-[#282828]' : 'bg-[#f3f5f7] text-black/55 hover:text-[#ff2a14]',
      )}
    >
      {children}
    </button>
  )
}

/** 大胶囊按钮（40px 高）：accent=红橙渐变 / green=绿渐变 / ghost=描边 */
export function BigBtn({
  tone = 'accent',
  onClick,
  children,
  disabled,
}: {
  tone?: 'accent' | 'green' | 'ghost'
  onClick?: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[50px] px-6 text-sm font-medium transition-all',
        disabled && 'cursor-not-allowed opacity-45',
        tone === 'accent' && 'text-white shadow-[0_4px_12px_rgba(255,42,20,.3)] hover:shadow-[0_6px_16px_rgba(255,42,20,.42)]',
        tone === 'green' && 'text-white shadow-[0_4px_12px_rgba(52,168,83,.28)] hover:shadow-[0_6px_16px_rgba(52,168,83,.4)]',
        tone === 'ghost' && 'border border-black/15 bg-white text-[#282828] hover:border-[#ff2a14] hover:text-[#ff2a14]',
      )}
      style={tone === 'accent' ? { backgroundImage: GRADIENT_ACCENT } : tone === 'green' ? { backgroundImage: GRADIENT_GREEN } : undefined}
    >
      {children}
    </button>
  )
}

// ---------- 封面件（一律渐变 + 书名首字，禁止外链图） ----------

function CoverFace({ novel, rounded }: { novel: NovelListItem; rounded: string }) {
  return (
    <div className={cn('relative overflow-hidden', rounded, coverBgClass(novel.cover))}>
      <NovelCoverImg novel={novel} />
      {!isLocalCover(novel.cover) && (
        <div className="flex aspect-[5/7] items-center justify-center">
          <span className="text-5xl font-bold text-white/90 drop-shadow-md">{novel.title.slice(0, 1)}</span>
        </div>
      )}
      {/* 封面底部黑色渐变字幕条 */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-6">
        <p className="truncate text-[11px] text-white/85">
          {novel.categoryName} · {fmtWords(novel.wordCount)}
        </p>
      </div>
    </div>
  )
}

/** 普通封面卡（分类页 / 相关作品 / 搜索结果） */
export function CoverCard({
  novel,
  onClick,
  className,
}: {
  novel: NovelListItem
  onClick: () => void
  className?: string
}) {
  return (
    <div className={cn('group cursor-pointer select-none', className)} onClick={onClick}>
      <div className="transition-all duration-300 group-hover:-translate-y-1 group-hover:drop-shadow-[0_10px_18px_rgba(149,157,165,.45)]">
        <CoverFace novel={novel} rounded="rounded-[5px]" />
      </div>
      <p className="mt-2 truncate text-center text-[15px] font-semibold text-[#282828] transition-colors group-hover:text-[#ff2a14]">
        {novel.title}
      </p>
      <p className="truncate text-center text-xs text-black/40">{novel.author}</p>
    </div>
  )
}

/** 热门封面卡：左上角 Impact 字体排名数字 + 斜切色块角标 */
export function RankCover({ novel, rank, onClick }: { novel: NovelListItem; rank: number; onClick: () => void }) {
  const color = RANK_COVER_COLORS[rank - 1] ?? '#9e9e9e'
  return (
    <div className="group w-[104px] cursor-pointer select-none sm:w-[128px] md:w-[150px] lg:w-[168px] xl:w-[200px]" onClick={onClick}>
      <div className="relative transition-all duration-300 group-hover:-translate-y-1 group-hover:drop-shadow-[0_12px_22px_rgba(149,157,165,.5)]">
        <CoverFace novel={novel} rounded="rounded-[5px]" />
        {/* 斜切色块角标 + Impact 排名数字 */}
        <div
          className="absolute left-0 top-0 h-9 w-9"
          style={{ background: color, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}
        />
        <span
          className="absolute left-[3px] top-[1px] text-xl italic leading-none text-white"
          style={{ fontFamily: 'Impact, "Arial Black", sans-serif' }}
        >
          {rank}
        </span>
      </div>
      <p className="mt-2 truncate text-center text-[15px] font-semibold text-[#282828] transition-colors group-hover:text-[#ff2a14]">
        {novel.title}
      </p>
      <p className="truncate text-center text-xs text-black/40">{novel.author}</p>
    </div>
  )
}

// ---------- 排行件 ----------

/** 分类热度文字榜单卡：60px 标题栏 + 10 行纯文字排行（前三名彩色） */
export function TextRankCard({
  title,
  items,
  onPick,
}: {
  title: string
  items: NovelListItem[]
  onPick: (n: NovelListItem) => void
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex h-[60px] items-center gap-2 border-b border-[#eaedf1] bg-[#ECEEF1] px-5">
        <Flame className="h-5 w-5 text-[#ff2a14]" />
        <h3 className="truncate text-[19px] font-bold text-[#282828] md:text-[22px]">{title}</h3>
      </div>
      <ol className="px-2 py-1.5">
        {items.slice(0, 10).map((n, i) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onPick(n)}
              className="flex h-[46px] w-full cursor-pointer items-center gap-3 rounded-[10px] px-3 text-left transition-colors hover:bg-white hover:text-[#ff2a14] hover:shadow-[0_2px_10px_rgba(149,157,165,.18)]"
            >
              <span
                className="w-7 shrink-0 text-sm font-bold"
                style={i < 3 ? { color: RANK_TEXT_COLORS[i] } : { color: 'rgba(0,0,0,.4)' }}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="flex-1 truncate text-[15px]">{n.title}</span>
              <span className="hidden shrink-0 text-xs text-black/35 sm:block">{n.categoryName}</span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  )
}

/** 章节行（斑马纹 flex 行：偶数行灰底 + 绿色文件 icon） */
export function ChapterRow({
  chapter,
  onClick,
  active,
}: {
  chapter: ChapterListItem
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-10 w-full cursor-pointer items-center gap-2 rounded-[10px] px-3 text-left text-sm transition-colors even:bg-[#f7f8f9] hover:text-[#ff2a14]',
        active ? 'bg-[#ecf9f0] text-[#34a853] hover:text-[#34a853]' : 'text-[#282828]',
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-[#34a853]" />
      <span className="flex-1 truncate">{chapter.title}</span>
      <span className="shrink-0 text-xs text-black/35">{fmtWords(chapter.wordCount)}</span>
    </button>
  )
}

// ---------- 搜索框 ----------

/** 首页/正文同款大搜索框：56px 高、radius 10px、右侧「书库」+ 红色放大镜 */
export function HeroSearch({
  navigate,
  hotItems,
  initialQuery = '',
  size = 'lg',
}: {
  navigate: (view: ThemeView) => void
  hotItems?: NovelListItem[]
  initialQuery?: string
  size?: 'lg' | 'sm'
}) {
  const [q, setQ] = useState(initialQuery)
  const [open, setOpen] = useState(false)
  const submit = () => {
    setOpen(false)
    navigate({ name: 'search', query: q.trim() })
  }
  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <div
        className={cn(
          'flex items-center rounded-[10px] bg-white shadow-[0_7px_21px_rgba(149,157,165,.28)]',
          size === 'lg' ? 'h-14' : 'h-12',
        )}
      >
        <Search className="ml-4 h-5 w-5 shrink-0 text-black/30" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="搜索书名 / 作者 / 简介"
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-base text-[#282828] outline-none placeholder:text-black/30"
        />
        {/* 竖分隔线 + 书库入口 */}
        <button
          type="button"
          onClick={() => navigate({ name: 'category' })}
          className="hidden h-full cursor-pointer items-center gap-1 border-l border-[#eaedf1] px-4 text-sm text-black/55 transition-colors hover:text-[#ff2a14] sm:flex"
        >
          书库
        </button>
        <button
          type="button"
          onClick={submit}
          aria-label="搜索"
          className="flex h-full w-14 cursor-pointer items-center justify-center rounded-r-[10px] text-white transition-opacity hover:opacity-90"
          style={{ backgroundImage: GRADIENT_ACCENT }}
        >
          <Search className="h-5 w-5" />
        </button>
      </div>
      {/* 今日热门毛玻璃下拉 */}
      {open && hotItems && hotItems.length > 0 && (
        <div className="absolute inset-x-0 top-[calc(100%+8px)] z-40 rounded-[14px] bg-white/90 p-2 shadow-[0_10px_30px_rgba(149,157,165,.35)] backdrop-blur-[10px]">
          <p className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-black/45">
            <Flame className="h-3.5 w-3.5 text-[#ff2a14]" />
            今日热门
          </p>
          {hotItems.slice(0, 8).map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                setOpen(false)
                navigate({ name: 'book', novelId: n.id })
              }}
              className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-[10px] px-3 text-left text-sm text-[#282828] transition-colors hover:bg-white hover:text-[#ff2a14]"
            >
              <Flame className="h-3.5 w-3.5 shrink-0 text-[#ff9800]" />
              <span className="flex-1 truncate">{n.title}</span>
              <span className="shrink-0 text-xs text-black/35">{n.author}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- 状态件 ----------

/** 错误态 + 重试 */
export function ErrorRetry({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-[15px] text-black/45">{message ?? '数据加载失败，请检查网络后重试'}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 inline-flex h-10 cursor-pointer items-center gap-2 rounded-[50px] px-8 text-sm font-medium text-white transition-opacity hover:opacity-90"
        style={{ backgroundImage: GRADIENT_ACCENT }}
      >
        <RotateCcw className="h-4 w-4" />
        重新加载
      </button>
    </div>
  )
}

const bone = 'animate-pulse rounded-[10px] bg-[#f0f1f3]'

/** 首页骨架 */
export function HomeSkeleton() {
  return (
    <div>
      <div className="mx-auto max-w-[680px] px-4 pb-10 pt-16">
        <div className={cn(bone, 'mx-auto mb-8 h-[150px] w-[230px]')} />
        <div className={cn(bone, 'h-14 w-full')} />
      </div>
      <Container>
        <Card className="p-6">
          <div className="flex flex-wrap justify-center gap-5">
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={i} className="w-[104px] sm:w-[128px] md:w-[150px] lg:w-[168px] xl:w-[200px]">
                <div className={cn(bone, 'aspect-[5/7] w-full rounded-[5px]')} />
                <div className={cn(bone, 'mx-auto mt-2 h-4 w-3/4')} />
                <div className={cn(bone, 'mx-auto mt-1.5 h-3 w-1/2')} />
              </div>
            ))}
          </div>
        </Card>
        <div className="mt-7 grid gap-7 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <div className={cn(bone, 'h-[60px] rounded-none')} />
              <div className="space-y-2 p-3">
                {Array.from({ length: 8 }).map((_, j) => (
                  <div key={j} className={cn(bone, 'h-8 w-full')} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      </Container>
    </div>
  )
}

/** 封面网格骨架 */
export function GridSkeleton({ count = 14 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <div className={cn(bone, 'aspect-[5/7] w-full rounded-[5px]')} />
          <div className={cn(bone, 'mx-auto mt-2 h-4 w-3/4')} />
          <div className={cn(bone, 'mx-auto mt-1.5 h-3 w-1/2')} />
        </div>
      ))}
    </div>
  )
}

/** 详情页骨架 */
export function BookSkeleton() {
  return (
    <div className="space-y-6">
      <Card className="p-6 md:p-8">
        <div className="flex flex-col-reverse gap-6 md:flex-row md:items-start md:justify-between">
          <div className="flex-1 space-y-4">
            <div className={cn(bone, 'h-10 w-1/2')} />
            <div className={cn(bone, 'h-8 w-full')} />
            <div className={cn(bone, 'h-24 w-full')} />
            <div className={cn(bone, 'h-10 w-64')} />
          </div>
          <div className={cn(bone, 'aspect-[5/7] w-[200px] rounded-[10px]')} />
        </div>
      </Card>
      <Card className="p-6">
        <div className={cn(bone, 'h-8 w-40')} />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={cn(bone, 'h-10 w-full')} />
          ))}
        </div>
      </Card>
    </div>
  )
}

/** 正文页骨架 */
export function ChapterSkeleton() {
  return (
    <Card className="p-6 md:p-10">
      <div className={cn(bone, 'mx-auto h-4 w-40')} />
      <div className={cn(bone, 'mx-auto mt-4 h-10 w-3/4')} />
      <div className={cn(bone, 'mx-auto mt-3 h-4 w-48')} />
      <div className="mt-8 space-y-4">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className={cn(bone, 'h-5 w-full')} style={{ width: `${88 + ((i * 7) % 12)}%` }} />
        ))}
      </div>
    </Card>
  )
}
