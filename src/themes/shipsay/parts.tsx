'use client'

import type { ReactNode } from 'react'
import { coverBgClass } from '@/lib/covers'
import { cn } from '@/lib/utils'
import type { ChapterListItem, NovelListItem } from '@/lib/types'
import type { ThemeView } from '../types'

export type Nav = (view: ThemeView) => void

/* ================= 格式化工具 ================= */

export function fmtDate(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

export function fmtDateShort(iso?: string | null): string {
  return iso ? iso.slice(5, 10) : '—'
}

export function fmtWords(n: number): string {
  if (!n || n <= 0) return '0字'
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万字` : `${n}字`
}

export function firstChar(title: string): string {
  return title.trim().charAt(0) || '书'
}

export function statusText(status: 'serial' | 'finished'): string {
  return status === 'finished' ? '完本' : '连载'
}

/* ================= 渐变封面（coverBgClass + 书名首字，禁止外链图片） ================= */

export function Cover({
  novel,
  className,
  charClass = 'text-3xl',
  overlay = false,
}: {
  novel: NovelListItem
  className?: string
  charClass?: string
  overlay?: boolean
}) {
  return (
    <div className={cn('relative shrink-0 overflow-hidden', className)}>
      <div
        className={cn(
          'flex h-full w-full items-center justify-center transition-transform duration-300 group-hover:scale-110',
          coverBgClass(novel.cover),
        )}
      >
        <span className={cn('select-none font-bold text-white/90 drop-shadow', charClass)}>
          {firstChar(novel.title)}
        </span>
      </div>
      {overlay && (
        <span className="absolute inset-x-0 bottom-0 bg-black/40 py-[3px] text-center text-[11px] leading-none text-white">
          {statusText(novel.status)}
        </span>
      )}
    </div>
  )
}

/* ================= 区块标题栏：图标 + 加粗标题 + 1px #DDD 下边线 ================= */

export function SectionTitle({ icon, title, extra }: { icon: ReactNode; title: string; extra?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-[#DDD] px-4 py-3">
      <div className="flex items-center gap-2 text-[15px] font-bold text-[#3E3D43]">
        <span className="text-[#BF2C24]">{icon}</span>
        {title}
      </div>
      {extra}
    </div>
  )
}

export function MoreLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="cursor-pointer text-[12px] font-normal text-[#969BA3] transition-colors hover:text-[#ED4259]"
    >
      更多 ›
    </button>
  )
}

export function Empty({ text = '暂无内容' }: { text?: string }) {
  return <p className="px-4 py-10 text-center text-[13px] text-[#969BA3]">{text}</p>
}

/* ================= 图书卡片：封面 100×133 + 状态条 + 两行缩进简介 + 字数/日期徽章 ================= */

export function BookCard({ novel, navigate }: { novel: NovelListItem; navigate: Nav }) {
  return (
    <div className="group flex cursor-pointer gap-3" onClick={() => navigate({ name: 'book', novelId: novel.id })}>
      <Cover novel={novel} overlay charClass="text-3xl" className="h-[133px] w-[100px] shadow-sm" />
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-[15px] font-bold text-[#1A1A1A] transition-colors group-hover:text-[#ED4259]">
          {novel.title}
        </h2>
        <p className="mt-1.5 line-clamp-2 flex-1 indent-[2em] text-justify text-[12px] leading-[1.7] text-[#999]">
          {novel.description || '（暂无简介）'}
        </p>
        <div className="mt-auto flex items-center gap-1.5 text-[11px]">
          <span className="min-w-0 truncate text-[#969BA3]">{novel.author}</span>
          <span className="ml-auto shrink-0 rounded-sm border border-[#F0643A]/50 px-1 py-px leading-none text-[#F0643A]">
            {fmtWords(novel.wordCount)}
          </span>
          <span className="shrink-0 rounded-sm border border-[#4284ED]/50 px-1 py-px leading-none text-[#4284ED]">
            {fmtDateShort(novel.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ================= 右侧纯文字榜单（书名左 + 作者灰右，行高 41px 点线分隔） ================= */

export function TextRankAside({ novels, navigate }: { novels: NovelListItem[]; navigate: Nav }) {
  return (
    <div className="bg-white px-4 py-1">
      {novels.map((n) => (
        <div
          key={n.id}
          className="group flex h-[41px] cursor-pointer items-center justify-between gap-2 border-b border-dotted border-[#E6E6E6] last:border-b-0"
          onClick={() => navigate({ name: 'book', novelId: n.id })}
        >
          <span className="min-w-0 truncate text-[13px] text-[#1A1A1A] transition-colors group-hover:text-[#ED4259]">
            {n.title}
          </span>
          <span className="shrink-0 text-[12px] text-[#969BA3]">{n.author}</span>
        </div>
      ))}
    </div>
  )
}

/* ================= 章节三列网格（行高 50px 点线，详情页目录/最新章节共用） ================= */

export function ChapterGrid({
  chapters,
  navigate,
  ascending = true,
}: {
  chapters: ChapterListItem[]
  navigate: Nav
  ascending?: boolean
}) {
  const list = ascending ? chapters : [...chapters].reverse()
  return (
    <div className="grid grid-cols-3 max-[959px]:grid-cols-2 max-[639px]:grid-cols-1">
      {list.map((c) => (
        <div
          key={c.id}
          className="flex h-[50px] cursor-pointer items-center gap-2 border-b border-dotted border-[#E6E6E6] px-2"
          onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
        >
          <span className="w-8 shrink-0 text-right text-[11px] text-[#C0C4CC]">{c.idx}</span>
          <span className="min-w-0 flex-1 truncate text-[14px] text-[#1A1A1A] transition-colors hover:text-[#ED4259]">
            {c.title}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ================= 小标签 ================= */

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-[#CCC] px-1.5 py-0.5 text-[12px] leading-none text-[#666]">
      {children}
    </span>
  )
}

/* ================= 骨架屏（同风格灰块） ================= */

export function Bar({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-[#ECECEC]', className)} />
}

export function CardListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-4 py-4 max-[639px]:grid-cols-1">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <Bar className="h-[133px] w-[100px] shrink-0" />
          <div className="flex flex-1 flex-col gap-2 py-1">
            <Bar className="h-[14px] w-3/4" />
            <Bar className="h-[10px] w-full" />
            <Bar className="h-[10px] w-5/6" />
            <Bar className="mt-auto h-[10px] w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function RowsSkeleton({ rows = 8, rowH = 41 }: { rows?: number; rowH?: number }) {
  return (
    <div className="px-4 py-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{ height: rowH }}
          className="flex items-center gap-4 border-b border-dotted border-[#E6E6E6] last:border-0"
        >
          <Bar className="h-[10px] w-[12%]" />
          <Bar className="h-[10px] w-[28%]" />
          <Bar className="h-[10px] flex-1" />
        </div>
      ))}
    </div>
  )
}

/* ================= 错误态（深红重试按钮） ================= */

export function ErrorBox({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 bg-white py-14">
      <p className="text-[13px] text-[#969BA3]">内容加载失败，请检查网络后重试</p>
      <button
        onClick={onRetry}
        className="h-[35px] cursor-pointer rounded-[3px] bg-[#BF2C24] px-5 text-[14px] text-white transition-colors hover:bg-[#ED4259]"
      >
        重新加载
      </button>
    </div>
  )
}

/* ================= 分页条：35px 方按钮，当前页/hover 深红底白字 ================= */

export function Pagination({
  page,
  totalPages,
  onGo,
}: {
  page: number
  totalPages: number
  onGo: (p: number) => void
}) {
  if (totalPages <= 1) return null
  const start = Math.max(1, Math.min(page - 3, totalPages - 6))
  const end = Math.min(totalPages, start + 6)
  const pages: number[] = []
  for (let p = start; p <= end; p++) pages.push(p)
  const btn =
    'flex h-[35px] min-w-[35px] cursor-pointer items-center justify-center rounded-[3px] border border-[#E6E6E6] bg-white px-2 text-[13px] text-[#555] transition-colors hover:border-[#BF2C24] hover:bg-[#BF2C24] hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#E6E6E6] disabled:hover:bg-white disabled:hover:text-[#555]'
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-4">
      <button className={btn} disabled={page <= 1} onClick={() => onGo(1)}>
        首页
      </button>
      <button className={btn} disabled={page <= 1} onClick={() => onGo(page - 1)}>
        上一页
      </button>
      {pages.map((p) => (
        <button
          key={p}
          className={cn(
            btn,
            p === page && 'border-[#BF2C24] bg-[#BF2C24] text-white hover:border-[#BF2C24] hover:bg-[#BF2C24]',
          )}
          onClick={() => onGo(p)}
        >
          {p}
        </button>
      ))}
      <button className={btn} disabled={page >= totalPages} onClick={() => onGo(page + 1)}>
        下一页
      </button>
      <button className={btn} disabled={page >= totalPages} onClick={() => onGo(totalPages)}>
        末页
      </button>
    </div>
  )
}
