'use client'

import { useEffect, useState } from 'react'
import { useChapters, useNovel } from '@/hooks/use-novel-data'
import { TocChapters } from '@/components/toc-chapters'
import { cn } from '@/lib/utils'
import type { ViewProps } from '../types'
import { ErrBlock, fmtDate, fmtWords, readMarkGet, SkRows } from './parts'

export default function Toc({ navigate, novelId }: ViewProps & { novelId: number }) {
  const novel = useNovel(novelId)
  const chapters = useChapters(novelId)
  const [asc, setAsc] = useState(true)
  const [read, setRead] = useState<number[]>(() => readMarkGet('aj-read'))

  if (novel.isPending || chapters.isPending) return <TocSkeleton />
  if (novel.isError || !novel.data) {
    return <ErrBlock msg={novel.error instanceof Error ? novel.error.message : ''} onRetry={() => novel.refetch()} />
  }
  if (chapters.isError) {
    return (
      <ErrBlock
        msg={chapters.error instanceof Error ? chapters.error.message : ''}
        onRetry={() => chapters.refetch()}
      />
    )
  }

  const n = novel.data
  const raw = chapters.data ?? []
  const readSet = new Set(read)
  const list = [...raw]
  if (!asc) list.reverse()

  return (
    <div className="mx-auto w-full max-w-[1200px] rounded-[12px] border border-[#dfe6ec] bg-white p-4 shadow-sm sm:p-6">
      {/* 标题行 */}
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[#e5e9ee] pb-3">
        <h1 className="text-[24px] font-bold leading-tight text-[#1f2d3d] sm:text-[28px]">{n.title} · 全文阅读</h1>
        <div className="flex items-center gap-3 text-[13px]">
          <button onClick={() => setAsc((v) => !v)} className="cursor-pointer text-[#1f8b4c] hover:underline">
            {asc ? '倒序排列 ↓' : '正序排列 ↑'}
          </button>
          <button
            onClick={() => navigate({ name: 'book', novelId: n.id })}
            className="cursor-pointer text-[#1f8b4c] hover:underline"
          >
            书籍详情
          </button>
        </div>
      </div>

      {/* meta 行 */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[#5c6b7a]">
        <span>
          作者：
          <button
            onClick={() => navigate({ name: 'search', query: n.author })}
            className="cursor-pointer text-[#1f8b4c] hover:underline"
          >
            {n.author}
          </button>
        </span>
        <span>分类：{n.categoryName}</span>
        <span>共 {raw.length} 章</span>
        <span>{fmtWords(n.wordCount)}</span>
        <span>更新：{fmtDate(n.updatedAt)}</span>
      </div>

      {/* 简介框（米灰） */}
      <div className="mt-3 rounded-[8px] bg-[#f4f6f8] p-3 text-[13px] leading-[1.8] text-[#4a5a68]">
        <p className="line-clamp-3">{n.description || '暂无简介'}</p>
      </div>

      {/* 最新章节（全书倒数 12 章，新→旧，置顶快达） */}
      {raw.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[14px] font-bold text-[#1f2d3d]">
            最新章节
            <span className="ml-2 text-[12px] font-normal text-[#8b98a4]">最近更新 12 章 · 新→旧</span>
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[...raw].slice(-12).reverse().map((c) => (
              <button
                key={`latest-${c.id}`}
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                className="cursor-pointer truncate rounded-[8px] border border-[#d9dfe5] bg-[#f8faf7] px-3 py-2 text-left text-[13px] text-[#1f2d3d] transition-colors hover:border-[#1f8b4c] hover:text-[#1f8b4c]"
                title={c.title}
              >
                {c.idx}. {c.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 章节 3 列流式分栏（columns 列优先：阅读顺序自上而下；≤640px 1 列 / ≥1024px 3 列） */}
      {raw.length === 0 ? (
        <p className="py-10 text-center text-[14px] text-[#8b98a4]">暂无章节，稍后再来看看。</p>
      ) : (
        <div className="mt-4">
          <TocChapters
            chapters={list}
            navigate={navigate}
            columnsClassName="columns-1 gap-x-2 sm:columns-2 lg:columns-3"
            itemClassName={(c) =>
              cn(
                'mb-2 rounded-[8px] border border-[#d9dfe5] bg-white px-3 py-2 text-[13px] transition-colors hover:border-[#1f8b4c] hover:text-[#1f8b4c]',
                readSet.has(c.id) ? 'text-[#9aa4ad]' : 'text-[#1f2d3d]',
              )
            }
            renderItem={(c) => `${c.idx}. ${c.title}`}
            volumeClassName="mb-2 rounded-[8px] bg-[#eef7f0] px-3 py-2 text-[14px] font-bold text-[#1f8b4c]"
            countClassName="text-[12px] text-[#8b98a4]"
          />
        </div>
      )}

      <p className="mt-4 border-t border-[#e5e9ee] pt-3 text-center text-xs text-[#98a4ae]">
        共 {raw.length} 章 · 点击章节进入暖纸阅读器 · 已读章节显示为灰色
      </p>
    </div>
  )
}

/* ==================== 骨架屏 ==================== */

function TocSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1200px] rounded-[12px] border border-[#dfe6ec] bg-white p-4 shadow-sm sm:p-6">
      <SkRows rows={2} className="mb-4" />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-[38px] animate-pulse rounded-[8px] bg-[#1f2d3d]/[0.07]" />
        ))}
      </div>
    </div>
  )
}
