'use client'

import type { ReactNode } from 'react'
import { coverBgClass } from '@/lib/covers'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'
import { cn } from '@/lib/utils'
import type { NovelListItem } from '@/lib/types'
import type { ThemeView } from '../types'

export type Nav = (view: ThemeView) => void

/* ================= 格式化工具 ================= */

export function fmtDateShort(iso?: string | null): string {
  return iso ? iso.slice(5, 10) : '—'
}

export function fmtDateFull(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

export function fmtWords(n: number): string {
  if (!n || n <= 0) return '0'
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
}

export function firstChar(title: string): string {
  return title.trim().charAt(0) || '书'
}

export function statusText(status: 'serial' | 'finished'): string {
  return status === 'finished' ? '完本' : '连载'
}

/* ================= 蓝链：#2F468F → hover 橙 #FF6600 + 1px 按压位移 ================= */

export function XLink({
  children,
  onClick,
  className,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      onClick={onClick}
      className={cn(
        'inline-block cursor-pointer text-[#2F468F] hover:translate-x-px hover:translate-y-px hover:text-[#FF6600]',
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ================= 渐变封面（coverBgClass + 书名首字，禁止外链图片） ================= */

export function Cover({
  novel,
  className,
  charClass = 'text-3xl',
}: {
  novel: NovelListItem
  className?: string
  charClass?: string
}) {
  return (
    <div className={cn('relative flex shrink-0 items-center justify-center overflow-hidden', className)}>
      <NovelCoverImg novel={novel} />
      <div className={cn('flex h-full w-full items-center justify-center', coverBgClass(novel.cover))}>
        {!isLocalCover(novel.cover) && (
          <span className={cn('select-none font-bold text-white/90', charClass)}>{firstChar(novel.title)}</span>
        )}
      </div>
    </div>
  )
}

/* 小方块图标（替代雪碧图小图标） */
export function SqIcon() {
  return <span className="inline-block size-[9px] border border-[#E88B00] bg-gradient-to-b from-[#FFB34D] to-[#FF6F08]" />
}

/* ================= 区块盒：1px #E4E4E4 边框 + 2px 浅蓝亮条 + 渐变标题栏 ================= */

export function Block({
  title,
  titleH = 26,
  right,
  children,
  className,
}: {
  title: ReactNode
  titleH?: number
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('border border-[#E4E4E4] bg-white', className)}>
      <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />
      <div
        className="flex items-center justify-between border-b border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] pl-2 pr-1"
        style={{ height: titleH }}
      >
        <div className="flex items-center gap-1.5 text-[12px] font-bold text-[#333]">
          <SqIcon />
          {title}
        </div>
        {right}
      </div>
      <div>{children}</div>
    </div>
  )
}

/* ================= 排行榜通用行：ol 序号 + 右侧统计小字，行高 25px 点线分隔 ================= */

export function RankList({
  novels,
  navigate,
  mode = 'count',
  rows = 15,
}: {
  novels: NovelListItem[]
  navigate: Nav
  mode?: 'count' | 'date'
  rows?: number
}) {
  if (novels.length === 0) {
    return <p className="px-2 py-4 text-center text-[12px] text-[#999]">暂无数据</p>
  }
  return (
    <ol className="px-2 py-1">
      {novels.slice(0, rows).map((n, i) => (
        <li
          key={n.id}
          className="flex h-[25px] items-center border-b border-dotted border-[#F2F2F2] text-[12px] last:border-b-0"
        >
          <span className="w-[20px] shrink-0 text-right text-[#999]">{i + 1}.</span>
          <XLink onClick={() => navigate({ name: 'book', novelId: n.id })} className="ml-1 min-w-0 flex-1 truncate">
            {n.title}
          </XLink>
          {mode === 'count' ? (
            <span className="ml-1 shrink-0 text-[11px] text-[#FF6600]">{fmtWords(n.clicks)}</span>
          ) : (
            <span className="ml-1 shrink-0 text-[11px] text-[#999]">{fmtDateShort(n.updatedAt)}</span>
          )}
        </li>
      ))}
    </ol>
  )
}

/* ================= 6 列数据表（分类/搜索共用）：表头 #F2F2F2，行点线分隔 ================= */

export function NovelTable({
  novels,
  navigate,
  emptyText = '暂无数据',
}: {
  novels: NovelListItem[]
  navigate: Nav
  emptyText?: string
}) {
  const th = 'border-b border-[#E4E4E4] px-1 py-[6px] font-bold text-[#333]'
  return (
    <table className="w-full table-fixed border-collapse border border-[#E4E4E4] bg-white text-[12px]">
      <thead>
        <tr className="bg-[#F2F2F2]">
          <th className={cn(th, 'w-[18%] text-left')}>文章名称</th>
          <th className={cn(th, 'w-[46%] text-left')}>最新章节</th>
          <th className={cn(th, 'w-[13%] text-left')}>作者</th>
          <th className={cn(th, 'w-[8%] text-center')}>字数</th>
          <th className={cn(th, 'w-[9%] text-center')}>更新</th>
          <th className={cn(th, 'w-[6%] text-center')}>状态</th>
        </tr>
      </thead>
      <tbody>
        {novels.length === 0 ? (
          <tr>
            <td colSpan={6} className="px-2 py-6 text-center text-[#999]">
              {emptyText}
            </td>
          </tr>
        ) : (
          novels.map((n) => (
            <tr key={n.id} className="border-b border-dotted border-[#E4E4E4] last:border-b-0">
              <td className="px-1 py-[6px]">
                <XLink onClick={() => navigate({ name: 'book', novelId: n.id })} className="w-full truncate">
                  {n.title}
                </XLink>
              </td>
              <td className="px-1 py-[6px]">
                <XLink onClick={() => navigate({ name: 'book', novelId: n.id })} className="w-full truncate">
                  {n.lastChapterTitle ?? '暂无章节'}
                </XLink>
              </td>
              <td className="truncate px-1 py-[6px] text-[#666]">{n.author}</td>
              <td className="px-1 py-[6px] text-center">{fmtWords(n.wordCount)}</td>
              <td className="px-1 py-[6px] text-center text-[#999]">{fmtDateShort(n.updatedAt)}</td>
              <td
                className={cn(
                  'px-1 py-[6px] text-center',
                  n.status === 'finished' ? 'text-[#FF6600]' : 'text-[#999]',
                )}
              >
                {statusText(n.status)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}

/* ================= 翻页条 .pagelink：#F2F2F2 底，当前页橙字 ================= */

function PgBtn({
  children,
  onClick,
  disabled,
  current,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  current?: boolean
}) {
  if (current) {
    return <span className="px-1 font-bold text-[#FF6600]">{children}</span>
  }
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer px-1 text-[#2F468F] transition-colors hover:text-[#FF6600] disabled:cursor-not-allowed disabled:text-[#BBB] disabled:hover:text-[#BBB]"
    >
      {children}
    </button>
  )
}

export function Pager({
  page,
  totalPages,
  onGo,
}: {
  page: number
  totalPages: number
  onGo: (p: number) => void
}) {
  if (totalPages <= 1) return null
  const start = Math.max(1, Math.min(page - 4, totalPages - 9))
  const end = Math.min(totalPages, start + 9)
  const pages: number[] = []
  for (let p = start; p <= end; p++) pages.push(p)
  return (
    <div className="flex flex-wrap items-center justify-center gap-1 border border-[#E4E4E4] bg-[#F2F2F2] px-1 py-[5px] text-[12px]">
      <PgBtn disabled={page <= 1} onClick={() => onGo(page - 1)}>
        上一页
      </PgBtn>
      {pages.map((p) => (
        <PgBtn key={p} current={p === page} onClick={() => onGo(p)}>
          {p}
        </PgBtn>
      ))}
      <PgBtn disabled={page >= totalPages} onClick={() => onGo(page + 1)}>
        下一页
      </PgBtn>
      <span className="ml-1 text-[#999]">共 {totalPages} 页</span>
    </div>
  )
}

/* ================= 骨架屏（同风格灰条） ================= */

export function RowsSkeleton({ rows = 8, rowH = 28 }: { rows?: number; rowH?: number }) {
  return (
    <div className="p-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{ height: rowH }}
          className="flex items-center gap-3 border-b border-dotted border-[#F2F2F2] last:border-0"
        >
          <div className="h-[10px] w-[35%] animate-pulse bg-[#EFEFEF]" />
          <div className="h-[10px] flex-1 animate-pulse bg-[#F3F3F3]" />
          <div className="h-[10px] w-[18%] animate-pulse bg-[#EFEFEF]" />
        </div>
      ))}
    </div>
  )
}

export function TableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="border border-[#E4E4E4] bg-white p-2">
      <div className="mb-1 h-[26px] w-full animate-pulse bg-[#F2F2F2]" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex h-[27px] items-center gap-3">
          <div className="h-[10px] w-[16%] animate-pulse bg-[#EFEFEF]" />
          <div className="h-[10px] flex-1 animate-pulse bg-[#F3F3F3]" />
          <div className="h-[10px] w-[12%] animate-pulse bg-[#EFEFEF]" />
          <div className="h-[10px] w-[8%] animate-pulse bg-[#F3F3F3]" />
        </div>
      ))}
    </div>
  )
}

/* ================= 错误态（橙渐变重试按钮） ================= */

export function ErrorBox({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="border border-[#E4E4E4] bg-white py-10 text-center">
      <p className="text-[12px] text-[#FF3300]">数据加载失败，请重试</p>
      <button
        onClick={onRetry}
        className="mt-3 h-[30px] cursor-pointer border border-[#FF6600] bg-gradient-to-b from-[#FFEAD3] to-[#FFD8AB] px-6 text-[12px] font-bold text-[#FF6600] transition-colors hover:text-[#333]"
      >
        重新加载
      </button>
    </div>
  )
}

/* ================= 按钮组（替代 100×30 雪碧图按钮） ================= */

export function BtnMain({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="h-[30px] w-[100px] cursor-pointer border border-[#E88B00] bg-gradient-to-b from-[#FFEAD3] to-[#FFD8AB] text-[13px] font-bold text-[#FF6600] transition-colors hover:text-[#333]"
    >
      {children}
    </button>
  )
}

export function BtnGray({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'h-[30px] w-[100px] cursor-pointer border border-[#CCCCCC] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] text-[13px] text-[#333] transition-colors hover:border-[#FF6600] hover:text-[#FF6600]',
        className,
      )}
    >
      {children}
    </button>
  )
}
