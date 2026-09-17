'use client'

import { ArrowLeft } from 'lucide-react'
import { useChapters, useNovel } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { ChapterGrid, ErrorBox, RowsSkeleton, fmtWords, statusText } from './parts'

/** 目录页：与详情页同风格的独立白卡，3 列章节升序（959→2 列，639→1 列） */
export default function Toc({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isLoading, isError, refetch } = useNovel(novelId)
  const {
    data: chapters,
    isLoading: chLoading,
    isError: chError,
    refetch: chRefetch,
  } = useChapters(novelId)

  if (isError || (!isLoading && !novel)) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
      <section className="bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#DDD] px-4 py-3">
          <h1 className="flex min-w-0 items-center gap-3 text-[18px] font-bold text-[#3E3D43]">
            <button
              onClick={() => navigate({ name: 'book', novelId })}
              className="flex shrink-0 cursor-pointer items-center gap-1 text-[12px] font-normal text-[#969BA3] transition-colors hover:text-[#ED4259]"
            >
              <ArrowLeft size={14} />
              返回详情
            </button>
            <span className="min-w-0 truncate">《{novel?.title ?? '加载中…'}》完整目录</span>
          </h1>
          <span className="shrink-0 text-[12px] text-[#969BA3]">
            {novel ? `${statusText(novel.status)} · ${fmtWords(novel.wordCount)}` : ''}
            {chapters ? ` · 共 ${chapters.length} 章（升序）` : ''}
          </span>
        </div>

        {/* 最新章节（全书倒数 12 章，新→旧，置顶快达） */}
        {chapters && chapters.length > 0 && (
          <div className="border-b border-[#E6E6E6] px-2 pb-2 pt-3">
            <p className="px-2 pb-1 text-center text-[15px] font-bold text-[#3E3D43]">
              最新章节
              <span className="ml-1 text-[11px] font-normal text-[#969BA3]">最近更新 12 章 · 新→旧</span>
            </p>
            <ChapterGrid chapters={[...chapters].slice(-12).reverse()} navigate={navigate} />
          </div>
        )}

        {chLoading ? (
          <RowsSkeleton rows={10} rowH={50} />
        ) : chError ? (
          <ErrorBox onRetry={() => chRefetch()} />
        ) : chapters && chapters.length > 0 ? (
          <div className="px-2 py-3">
            <ChapterGrid chapters={chapters} navigate={navigate} />
          </div>
        ) : (
          <p className="py-10 text-center text-[13px] text-[#969BA3]">暂无章节</p>
        )}
      </section>
    </div>
  )
}
