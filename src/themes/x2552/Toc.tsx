'use client'

import { useEffect, useMemo } from 'react'
import { useChapters, useNovel } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { BtnGray, BtnMain, ErrorBox, RowsSkeleton, XLink, fmtWords, statusText } from './parts'

/**
 * 目录页（Layout 紧凑顶栏 + #a_footer，白底）：
 * 当前位置面包屑 → 书籍信息头（书名/作者/分类/状态/字数/点击/开始阅读）
 * → 全量章节目录（useChapters 按 idx 升序，多列响应式网格）
 */
export default function Toc({ navigate, novelId }: ViewProps & { novelId: number }) {
  const nq = useNovel(novelId)
  const cq = useChapters(novelId)

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [novelId])

  const sorted = useMemo(() => [...(cq.data ?? [])].sort((a, b) => a.idx - b.idx), [cq.data])

  if (nq.isError || cq.isError) {
    return (
      <div className="mt-2">
        <ErrorBox
          onRetry={() => {
            if (nq.isError) nq.refetch()
            if (cq.isError) cq.refetch()
          }}
        />
      </div>
    )
  }

  if (nq.isPending || cq.isPending || !nq.data) {
    return (
      <div className="mt-2">
        <div className="h-[30px] w-full animate-pulse border border-[#E4E4E4] bg-[#F2F2F2]" />
        <div className="mt-2 border border-[#E4E4E4] bg-white p-4">
          <div className="mx-auto h-[22px] w-1/3 animate-pulse bg-[#EFEFEF]" />
          <div className="mx-auto mt-3 h-[12px] w-2/3 animate-pulse bg-[#F2F2F2]" />
          <div className="mx-auto mt-3 h-[30px] w-64 animate-pulse bg-[#F2F2F2]" />
        </div>
        <div className="mt-2 border border-[#E4E4E4] bg-white">
          <div className="h-[26px] w-full animate-pulse bg-[#F2F2F2]" />
          <RowsSkeleton rows={10} />
        </div>
      </div>
    )
  }

  const novel = nq.data
  const firstId = novel.firstChapterId ?? (sorted.length ? sorted[0].id : null)
  const lastId = novel.lastChapterId ?? (sorted.length ? sorted[sorted.length - 1].id : null)

  return (
    <div className="mt-2">
      {/* 当前位置面包屑 */}
      <div className="flex h-[30px] items-center gap-1 overflow-hidden border border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] px-2 text-[12px]">
        <span className="shrink-0 font-bold text-[#333]">当前位置：</span>
        <XLink onClick={() => navigate({ name: 'home' })} className="shrink-0">
          首页
        </XLink>
        <span className="shrink-0 text-[#CCC]">&gt;</span>
        <XLink onClick={() => navigate({ name: 'category', categoryId: novel.categoryId })} className="shrink-0">
          {novel.categoryName}
        </XLink>
        <span className="shrink-0 text-[#CCC]">&gt;</span>
        <XLink onClick={() => navigate({ name: 'book', novelId: novel.id })} className="min-w-0 max-w-[360px] truncate">
          {novel.title}
        </XLink>
        <span className="shrink-0 text-[#CCC]">&gt;</span>
        <span className="shrink-0 text-[#999]">目录</span>
      </div>

      {/* 书籍信息头 */}
      <div className="mt-2 border border-[#E4E4E4] bg-white">
        <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />
        <h1 className="text-center text-[20px] leading-[48px] text-[#333]">《{novel.title}》目录</h1>
        <div className="border-t border-dotted border-[#E4E4E4] px-3 py-2 text-center text-[12px] leading-[22px] text-[#666]">
          作者：{novel.author}
          <span className="mx-1.5 text-[#DDD]">|</span>
          分类：
          <XLink onClick={() => navigate({ name: 'category', categoryId: novel.categoryId })}>
            {novel.categoryName}
          </XLink>
          <span className="mx-1.5 text-[#DDD]">|</span>
          状态：{statusText(novel.status)}
          <span className="mx-1.5 text-[#DDD]">|</span>
          字数：{fmtWords(novel.wordCount)}字
          <span className="mx-1.5 text-[#DDD]">|</span>
          点击：{fmtWords(novel.clicks)}
          <span className="mx-1.5 text-[#DDD]">|</span>
          共 {sorted.length} 章
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 border-t border-dotted border-[#E4E4E4] px-3 py-2">
          <BtnMain
            onClick={() => {
              if (firstId != null) navigate({ name: 'chapter', chapterId: firstId })
            }}
          >
            开始阅读
          </BtnMain>
          <BtnGray onClick={() => navigate({ name: 'book', novelId: novel.id })}>返回书页</BtnGray>
          {lastId != null && (
            <BtnGray onClick={() => navigate({ name: 'chapter', chapterId: lastId })}>最新章节</BtnGray>
          )}
        </div>
      </div>

      {/* 最新章节（全书倒数 12 章，新→旧，置顶快达） */}
      {sorted.length > 0 && (
        <div className="mt-2 border border-[#E4E4E4] bg-white">
          <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />
          <div className="flex h-[26px] items-center justify-between border-b border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] pl-2 pr-2 text-[12px] font-bold text-[#333]">
            <span>最新章节</span>
            <span className="text-[11px] font-normal text-[#999]">最近更新 12 章 · 新→旧</span>
          </div>
          <ul className="grid grid-cols-1 gap-x-6 px-3 py-1 sm:grid-cols-2 lg:grid-cols-4">
            {[...sorted].slice(-12).reverse().map((c) => (
              <li
                key={`latest-${c.id}`}
                className="flex h-[26px] items-center border-b border-dotted border-[#F2F2F2] text-[12px]"
              >
                <span className="w-[42px] shrink-0 text-right text-[#999]">{c.idx}.</span>
                <XLink
                  onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                  className="ml-1 min-w-0 flex-1 truncate"
                  title={c.title}
                >
                  {c.title}
                </XLink>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 全量章节目录 */}
      <div className="mt-2 border border-[#E4E4E4] bg-white">
        <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />
        <div className="flex h-[26px] items-center justify-between border-b border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] pl-2 pr-2 text-[12px] font-bold text-[#333]">
          <span>正文目录（按章节序号排列）</span>
          <span className="text-[11px] font-normal text-[#999]">{sorted.length} 章</span>
        </div>
        {sorted.length === 0 ? (
          <p className="py-10 text-center text-[12px] text-[#999]">本书暂无章节记录</p>
        ) : (
          <ul className="grid grid-cols-1 gap-x-6 px-3 py-1 sm:grid-cols-2 lg:grid-cols-4">
            {sorted.map((c) => (
              <li
                key={c.id}
                className="flex h-[26px] items-center border-b border-dotted border-[#F2F2F2] text-[12px]"
              >
                <span className="w-[42px] shrink-0 text-right text-[#999]">{c.idx}.</span>
                <XLink
                  onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                  className="ml-1 min-w-0 flex-1 truncate"
                  title={c.title}
                >
                  {c.title}
                </XLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
