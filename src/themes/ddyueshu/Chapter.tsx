'use client'

import { useEffect, useState } from 'react'
import { useChapter, useNovel, useNovels } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { ErrBlock, Sk, fmtWords, getMarks, toggleMark } from './parts'

/* ==================== 章节正文页（specs：19pt 大字 / 0.2em 字距 / 150% 行高 / 85% 居中 / 章首章尾双导航） ==================== */

export default function Chapter({ navigate, siteName, chapterId }: ViewProps & { chapterId: number }) {
  const q = useChapter(chapterId)
  const novel = useNovel(q.data?.novelId)
  const hot = useNovels({ sort: 'clicks', pageSize: 10 })

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [chapterId])

  if (q.isPending) return <ChapterSkeleton />
  if (q.isError || !q.data) {
    return <ErrBlock msg={q.error instanceof Error ? q.error.message : ''} onRetry={() => q.refetch()} />
  }

  const ch = q.data
  const nv = novel.data
  const paragraphs = ch.content
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  /* 章首 / 章尾共用导航行（深绿链接，specs .bottem1/.bottem2） */
  const navBar = (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 py-2 text-[14px]">
      <button
        className="dd-greenlink"
        disabled={!ch.prevId}
        onClick={() => ch.prevId && navigate({ name: 'chapter', chapterId: ch.prevId })}
      >
        上一章 ←
      </button>
      <button className="dd-greenlink" onClick={() => navigate({ name: 'toc', novelId: ch.novelId })}>
        章节目录
      </button>
      <button
        className="dd-greenlink"
        disabled={!ch.nextId}
        onClick={() => ch.nextId && navigate({ name: 'chapter', chapterId: ch.nextId })}
      >
        → 下一章
      </button>
      <MarkButton key={`${ch.novelId}-${ch.id}`} novelId={ch.novelId} chapterId={ch.id} />
    </div>
  )

  return (
    <div>
      {/* 面包屑：首页 > 分类 > 书名 > 章节名 */}
      <div className="mt-1 flex h-[36px] items-center gap-1 overflow-hidden border-b border-[#a6d3e8] bg-[#e1eced] px-2 text-[13px]">
        <button className="dd-link flex-none" onClick={() => navigate({ name: 'home' })}>
          首页
        </button>
        <span className="flex-none text-[#b3b3b3]">&gt;</span>
        {nv && (
          <>
            <button
              className="dd-link flex-none"
              onClick={() => navigate({ name: 'category', categoryId: nv.categoryId, page: 1 })}
            >
              {nv.categoryName}
            </button>
            <span className="flex-none text-[#b3b3b3]">&gt;</span>
          </>
        )}
        <button className="dd-link flex-none" onClick={() => navigate({ name: 'book', novelId: ch.novelId })}>
          {ch.novelTitle}
        </button>
        <span className="flex-none text-[#b3b3b3]">&gt;</span>
        <span className="truncate text-[#667788]">{ch.title}</span>
      </div>

      {/* 正文盒（米黄底 + 3px 天蓝描边） */}
      <article className="dd-box dd-box-strong mt-2">
        {/* 章名区（下 1px 蓝虚线）：h1 25px 黑体居中 + 章首导航 + 热门推荐行 */}
        <header className="mx-3 border-b border-dashed border-[#a6d3e8]">
          <h1 className="dd-hei pt-3 text-center text-[25px] font-bold leading-[34px] text-[#333]">{ch.title}</h1>
          <p className="pt-1 text-center text-[12px] text-[#b3b3b3]">
            第 {ch.idx} 章 · 约 {fmtWords(ch.wordCount)}
          </p>
          {navBar}
          {(hot.data?.list.length ?? 0) > 0 && (
            <p className="truncate pb-1.5 text-center text-[12px] text-[#999]">
              <span className="mr-1">热门推荐：</span>
              {(hot.data?.list ?? []).slice(0, 10).map((n) => (
                <button key={n.id} className="dd-link mr-1" onClick={() => navigate({ name: 'book', novelId: n.id })}>
                  《{n.title}》
                </button>
              ))}
            </p>
          )}
        </header>

        {/* 正文：19px 衬线 + 字距 0.2em + 行高 150% + 85% 宽居中，\n 分段缩进 2em */}
        <div className="dd-reader-content mx-auto w-[92%] py-5 text-[19px] leading-[150%] tracking-[0.2em] text-[#444] sm:w-[85%]">
          {paragraphs.length === 0 ? (
            <p className="dd-hottext text-center">本章内容为空，请返回目录选择其他章节。</p>
          ) : (
            paragraphs.map((p, i) => <p key={i}>{p}</p>)
          )}
        </div>

        {/* 章尾导航（上 1px 蓝虚线） */}
        <footer className="mx-3 border-t border-dashed border-[#a6d3e8]">
          {navBar}
          <p className="pb-2 text-center text-[12px] leading-[20px] text-[#b2b2b2]">
            <span className="dd-hottext mr-2">发现章节错误？演示站点暂未开放反馈。</span>
            请记住本站地址：{siteName}
          </p>
        </footer>
      </article>
    </div>
  )
}

/* ==================== 书签按钮（localStorage，按章重挂载） ==================== */

function MarkButton({ novelId, chapterId }: { novelId: number; chapterId: number }) {
  const [marked, setMarked] = useState(false)
  return (
    <button
      className={marked ? 'dd-hottext cursor-pointer' : 'dd-greenlink'}
      onClick={() => setMarked(toggleMark(String(novelId), chapterId))}
    >
      {marked ? '已在书签' : '加入书签'}
    </button>
  )
}

/* ==================== 骨架屏 ==================== */

function ChapterSkeleton() {
  return (
    <div>
      <Sk className="mt-1 h-[36px] w-full" />
      <div className="dd-box dd-box-strong mt-2 px-4 py-6">
        <Sk className="mx-auto h-[30px] w-1/2" />
        <Sk className="mx-auto mt-3 h-[16px] w-40" />
        <div className="mx-auto mt-6 w-[85%] space-y-3">
          {Array.from({ length: 10 }, (_, i) => (
            <Sk key={i} className="h-[28px]" style={{ width: `${100 - (i % 3) * 9}%` }} />
          ))}
        </div>
        <Sk className="mx-auto mt-8 h-[20px] w-64" />
      </div>
    </div>
  )
}
