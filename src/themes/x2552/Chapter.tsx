'use client'

import { useEffect, useState } from 'react'
import { useChapter, useNovel } from '@/hooks/use-novel-data'
import type { ChapterDetail } from '@/lib/types'
import type { ViewProps } from '../types'
import { ErrorBox, XLink, fmtWords } from './parts'

const DEFAULT_SIZE = 16
const MIN_SIZE = 14
const MAX_SIZE = 24

/** 章首/章尾共用导航行：上一章 | 目录 | 下一章（无前后章时置灰） */
function NavRow({ ch, navigate }: { ch: ChapterDetail; navigate: ViewProps['navigate'] }) {
  const prevId = ch.prevId
  const nextId = ch.nextId
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 py-2 text-[13px]">
      {prevId != null ? (
        <XLink onClick={() => navigate({ name: 'chapter', chapterId: prevId })}>上一章</XLink>
      ) : (
        <span className="text-[#BBB]">上一章</span>
      )}
      <XLink onClick={() => navigate({ name: 'toc', novelId: ch.novelId })}>目 录</XLink>
      {nextId != null ? (
        <XLink onClick={() => navigate({ name: 'chapter', chapterId: nextId })}>下一章</XLink>
      ) : (
        <span className="text-[#BBB]">下一章</span>
      )}
    </div>
  )
}

/** 简洁阅读设置：字号 A- / A / A+（14–24px，步进 2） */
function SizeRow({ size, onChange }: { size: number; onChange: (s: number) => void }) {
  const btn =
    'flex h-[20px] w-[24px] cursor-pointer items-center justify-center border border-[#CCCCCC] bg-white text-[11px] text-[#666] transition-colors hover:border-[#FF6600] hover:text-[#FF6600]'
  return (
    <div className="flex items-center justify-end gap-1 border-b border-dotted border-[#E4E4E4] px-3 py-1.5 text-[11px] text-[#999]">
      字号
      <button className={btn} title="减小字号" onClick={() => onChange(Math.max(MIN_SIZE, size - 2))}>
        A-
      </button>
      <button className={btn} title={`默认字号 ${DEFAULT_SIZE}px`} onClick={() => onChange(DEFAULT_SIZE)}>
        A
      </button>
      <button className={btn} title="增大字号" onClick={() => onChange(Math.min(MAX_SIZE, size + 2))}>
        A+
      </button>
      <span className="ml-1 w-[40px] text-right">当前 {size}px</span>
    </div>
  )
}

/**
 * 正文页（Layout 紧凑顶栏 + #a_footer，页面底色淡蓝 #E6F3FF）：
 * 面包屑 → 白色正文盒（章名 + 章首/章尾双份导航 + 字号设置 + \n 分段缩进 2em 正文）
 */
export default function Chapter({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const q = useChapter(chapterId)
  const novel = useNovel(q.data?.novelId)
  const [fontSize, setFontSize] = useState(DEFAULT_SIZE)

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [chapterId])

  if (q.isPending) return <ChapterSkeleton />

  if (q.isError || !q.data) {
    return (
      <div className="mt-2">
        <ErrorBox onRetry={() => q.refetch()} />
      </div>
    )
  }

  const ch = q.data
  const nv = novel.data
  const paragraphs = ch.content
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  return (
    <div className="mt-2">
      {/* 面包屑：首页 > 分类 > 书名 > 章节名 */}
      <div className="flex h-[30px] items-center gap-1 overflow-hidden border border-[#E4E4E4] bg-white px-2 text-[12px]">
        <span className="shrink-0 font-bold text-[#333]">当前位置：</span>
        <XLink onClick={() => navigate({ name: 'home' })} className="shrink-0">
          首页
        </XLink>
        <span className="shrink-0 text-[#CCC]">&gt;</span>
        {nv && (
          <>
            <XLink onClick={() => navigate({ name: 'category', categoryId: nv.categoryId })} className="shrink-0">
              {nv.categoryName}
            </XLink>
            <span className="shrink-0 text-[#CCC]">&gt;</span>
          </>
        )}
        <XLink onClick={() => navigate({ name: 'book', novelId: ch.novelId })} className="min-w-0 max-w-[240px] truncate">
          {ch.novelTitle}
        </XLink>
        <span className="shrink-0 text-[#CCC]">&gt;</span>
        <span className="min-w-0 truncate text-[#999]">{ch.title}</span>
      </div>

      {/* 正文盒 */}
      <article className="mt-2 border border-[#E4E4E4] bg-white">
        <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />

        {/* 章名区：h1 + 章首导航 + 字号设置 */}
        <header className="px-3 pt-1">
          <h1 className="text-center text-[20px] font-bold leading-[44px] text-[#333]">{ch.title}</h1>
          <p className="pb-1 text-center text-[11px] text-[#999]">
            第 {ch.idx} 章 · 约 {fmtWords(ch.wordCount)}字
          </p>
          <div className="border-t border-dotted border-[#E4E4E4]">
            <NavRow ch={ch} navigate={navigate} />
          </div>
          <SizeRow size={fontSize} onChange={setFontSize} />
        </header>

        {/* 正文：\n 分段、缩进 2em，字号可调 */}
        <div className="mx-auto w-[92%] py-4 sm:w-[85%]" style={{ fontSize, lineHeight: 1.9 }}>
          {paragraphs.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-[#999]">本章暂无内容，请返回目录选择其他章节。</p>
          ) : (
            paragraphs.map((p, i) => (
              <p key={i} className="indent-[2em] text-[#333]">
                {p}
              </p>
            ))
          )}
        </div>

        {/* 章尾导航 */}
        <footer className="mx-3 border-t border-dotted border-[#E4E4E4] pb-1">
          <NavRow ch={ch} navigate={navigate} />
        </footer>
      </article>
    </div>
  )
}

/* ==================== 骨架屏（同风格灰条） ==================== */

function ChapterSkeleton() {
  return (
    <div className="mt-2">
      <div className="h-[30px] w-full animate-pulse border border-[#E4E4E4] bg-[#F2F2F2]" />
      <div className="mt-2 border border-[#E4E4E4] bg-white">
        <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />
        <div className="mx-auto mt-3 h-[22px] w-1/2 animate-pulse bg-[#EFEFEF]" />
        <div className="mx-auto mt-2 h-[10px] w-32 animate-pulse bg-[#F2F2F2]" />
        <div className="mx-auto mt-3 h-[24px] w-1/2 animate-pulse bg-[#F2F2F2]" />
        <div className="mx-auto w-[85%] space-y-2 py-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="h-[14px] animate-pulse bg-[#F2F2F2]"
              style={{ width: `${100 - (i % 3) * 8}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
