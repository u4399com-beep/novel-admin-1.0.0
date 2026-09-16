'use client'

import { useMemo } from 'react'
import { useChapters, useNovel } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { ErrBlock, Sk, SkRows, fmtWords } from './parts'

/* ==================== 目录页（specs：dl 卷/章三栏 33%，正序排列，最新章节置顶一组） ==================== */

export default function Toc({ navigate, novelId }: ViewProps & { novelId: number }) {
  const novel = useNovel(novelId)
  const chapters = useChapters(novelId)

  const sorted = useMemo(() => [...(chapters.data ?? [])].sort((a, b) => a.idx - b.idx), [chapters.data])

  if (chapters.isPending) return <TocSkeleton />
  if (chapters.isError) {
    return (
      <ErrBlock
        msg={chapters.error instanceof Error ? chapters.error.message : ''}
        onRetry={() => chapters.refetch()}
      />
    )
  }

  const n = novel.data

  return (
    <div>
      {/* 面包屑条 */}
      <div className="mt-1 flex h-[36px] items-center justify-between gap-2 border-b border-[#a6d3e8] bg-[#e1eced] px-2 text-[13px]">
        <div className="flex min-w-0 items-center gap-1">
          <button className="dd-link flex-none" onClick={() => navigate({ name: 'home' })}>
            首页
          </button>
          <span className="flex-none text-[#b3b3b3]">&gt;</span>
          {n && (
            <>
              <button className="dd-link flex-none" onClick={() => navigate({ name: 'book', novelId })}>
                {n.title}
              </button>
              <span className="flex-none text-[#b3b3b3]">&gt;</span>
            </>
          )}
          <span className="truncate text-[#667788]">章节目录</span>
        </div>
        <span className="hidden flex-none text-[12px] text-[#999] sm:block">共 {sorted.length} 章 · 正序排列</span>
      </div>

      {/* 书籍信息头 */}
      <section className="dd-box dd-box-mid mt-2 flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <h1 className="dd-hei truncate text-[22px] font-bold leading-[30px] text-[#333]">
            《{n?.title ?? '……'}》章节目录
          </h1>
          {n && (
            <p className="mt-0.5 truncate text-[12px] text-[#999]">
              作者：{n.author} · {n.categoryName} · {n.status === 'finished' ? '已完本' : '连载中'} ·{' '}
              {fmtWords(n.wordCount)}
            </p>
          )}
        </div>
        <div className="flex flex-none items-center gap-3 text-[13px]">
          <button className="dd-greenlink" onClick={() => navigate({ name: 'book', novelId })}>
            返回书页
          </button>
          <button
            className="h-[26px] cursor-pointer bg-[#88c6e5] px-3 font-bold text-white transition-colors hover:bg-[#459df5] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!n?.firstChapterId}
            onClick={() => n?.firstChapterId && navigate({ name: 'chapter', chapterId: n.firstChapterId })}
          >
            开始阅读
          </button>
        </div>
      </section>

      {/* dl 式目录：最新章节（置顶 6 条）+ 正文全量（升序三栏） */}
      <section className="dd-box dd-box-strong mt-2">
        {sorted.length === 0 ? (
          <p className="dd-hottext px-3 py-4 text-[13px]">本书暂无章节，先去书库看看别的吧。</p>
        ) : (
          <dl className="dd-dd-grid px-2 py-2">
            <dt className="dd-hei col-span-full bg-[#c3dfea] text-center text-[14px] font-bold leading-[28px] text-[#333]">
              最新章节
            </dt>
            {[...sorted].slice(-6).reverse().map((c) => (
              <dd key={`latest-${c.id}`} className="dd-dd-item">
                <button onClick={() => navigate({ name: 'chapter', chapterId: c.id })}>{c.title}</button>
              </dd>
            ))}
            <dt className="dd-hei col-span-full mt-2 bg-[#c3dfea] text-center text-[14px] font-bold leading-[28px] text-[#333]">
              《{n?.title ?? '本书'}》正文
            </dt>
            {sorted.map((c) => (
              <dd key={c.id} className="dd-dd-item">
                <button onClick={() => navigate({ name: 'chapter', chapterId: c.id })}>{c.title}</button>
              </dd>
            ))}
          </dl>
        )}
      </section>
    </div>
  )
}

/* ==================== 骨架屏 ==================== */

function TocSkeleton() {
  return (
    <div>
      <Sk className="mt-1 h-[36px] w-full" />
      <div className="dd-box dd-box-mid mt-2 flex items-center justify-between px-3 py-2">
        <Sk className="h-[26px] w-1/3" />
        <Sk className="h-[26px] w-28" />
      </div>
      <div className="dd-box dd-box-strong mt-2 p-2">
        <Sk className="mb-2 h-[28px] w-full" />
        <SkRows rows={15} />
      </div>
    </div>
  )
}
