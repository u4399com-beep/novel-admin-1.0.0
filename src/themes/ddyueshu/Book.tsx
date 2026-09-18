'use client'

import { useChapters, useNovel } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { Cover, ErrBlock, Sk, SkRows, fmtDate, fmtNum, fmtWords } from './parts'

/* ==================== 书籍详情页（specs：面包屑 + 封面信息区 + 最新章节 dl） ==================== */

export default function Book({ navigate, novelId }: ViewProps & { novelId: number }) {
  const q = useNovel(novelId)
  /* 最新章节需从全量章节取末 6 条（详情接口的 chapters 是最早 12 章，不能直接用） */
  const chaptersQ = useChapters(novelId)
  const latest6 = chaptersQ.data ? [...chaptersQ.data].slice(-6).reverse() : null

  if (q.isPending) return <BookSkeleton />
  if (q.isError || !q.data) {
    return <ErrBlock msg={q.error instanceof Error ? q.error.message : ''} onRetry={() => q.refetch()} />
  }
  const n = q.data

  return (
    <div>
      {/* 面包屑条（#E1ECED 底 + 下 1px 蓝线） */}
      <div className="mt-1 flex h-[36px] items-center justify-between gap-2 border-b border-[#a6d3e8] bg-[#e1eced] px-2 text-[13px]">
        <div className="flex min-w-0 items-center gap-1">
          <button className="dd-link flex-none" onClick={() => navigate({ name: 'home' })}>
            首页
          </button>
          <span className="flex-none text-[#b3b3b3]">&gt;</span>
          <button
            className="dd-link flex-none"
            onClick={() => navigate({ name: 'category', categoryId: n.categoryId, page: 1 })}
          >
            {n.categoryName}
          </button>
          <span className="flex-none text-[#b3b3b3]">&gt;</span>
          <span className="truncate text-[#667788]">{n.title}最新章节列表</span>
        </div>
        <span className="hidden flex-none text-[12px] text-[#999] sm:block">
          字数 {fmtWords(n.wordCount)} · 点击 {fmtNum(n.clicks)}
        </span>
      </div>

      {/* 信息区：左封面盒（#E1ECED 内衬 + 角标） + 右书名/作者/动作 */}
      <section className="dd-box dd-box-strong mt-2">
        <div className="flex flex-col gap-3 p-[12px] sm:flex-row">
          <div className="relative w-fit flex-none self-start border border-[#a6d3e8] bg-[#e1eced] p-[10px]">
            <Cover novel={n} className="h-[195px] w-[152px]" charClass="text-[40px]" />
            {n.isFeatured && (
              <span className="absolute right-0 top-0 bg-[#88c6e5] px-1.5 text-[12px] leading-[20px] text-white">
                强推
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="dd-hei text-[24px] font-bold leading-[34px] text-[#333] sm:text-[28px]">{n.title}</h1>
            <div className="mt-1 space-y-0.5 text-[13px] leading-[22px]">
              <p>
                <span className="text-[#999]">作者：</span>
                <button className="dd-link" onClick={() => navigate({ name: 'search', query: n.author })}>
                  {n.author}
                </button>
                <span className="ml-3 text-[#999]">分类：</span>
                <button
                  className="dd-link"
                  onClick={() => navigate({ name: 'category', categoryId: n.categoryId, page: 1 })}
                >
                  {n.categoryName}
                </button>
              </p>
              <p>
                <span className="text-[#999]">状态：</span>
                {n.status === 'finished' ? (
                  <span className="text-[#085308]">已完本</span>
                ) : (
                  <span className="dd-hottext">连载中</span>
                )}
                <span className="ml-3 text-[#999]">字数：</span>
                {fmtWords(n.wordCount)}
                <span className="ml-3 text-[#999]">点击：</span>
                {fmtNum(n.clicks)}
                <span className="ml-3 text-[#999]">章节：</span>共 {n.totalChapters} 章
              </p>
              <p className="min-w-0">
                <span className="text-[#999]">最后更新：</span>
                {fmtDate(n.updatedAt)}
                {n.lastChapterId ? (
                  <>
                    <span className="ml-2 text-[#999]">〔</span>
                    <button
                      className="dd-link"
                      onClick={() => navigate({ name: 'chapter', chapterId: n.lastChapterId! })}
                    >
                      {n.lastChapterTitle ?? '阅读最新章节'}
                    </button>
                    <span className="text-[#999]">〕</span>
                  </>
                ) : null}
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="h-[30px] cursor-pointer bg-[#88c6e5] px-5 text-[14px] font-bold text-white transition-colors hover:bg-[#459df5] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!n.firstChapterId}
                onClick={() => n.firstChapterId && navigate({ name: 'chapter', chapterId: n.firstChapterId })}
              >
                开始阅读
              </button>
              <button
                className="h-[30px] cursor-pointer border-2 border-[#88c6e5] bg-white px-5 text-[14px] text-[#2f6f9f] transition-colors hover:bg-[#e1eced]"
                onClick={() => navigate({ name: 'toc', novelId: n.id })}
              >
                进入目录
              </button>
            </div>
          </div>
        </div>
        {/* 简介（上 1px 蓝虚线 + 缩进 2em） */}
        <p className="mx-3 border-t border-dashed border-[#a6d3e8] py-2 text-[13px] leading-[22px] text-[#555] [text-indent:2em]">
          {n.description || '暂无简介'}
        </p>
      </section>

      {/* 最新章节：dl 卷头 + dd 三栏（33%） */}
      <section className="dd-box dd-box-mid mt-2">
        <div className="dd-box-title flex items-center justify-between bg-[#f6f8fe]">
          <span>最新章节</span>
          <button className="dd-greenlink text-[12px]" onClick={() => navigate({ name: 'toc', novelId: n.id })}>
            完整目录 &gt;&gt;
          </button>
        </div>
        {chaptersQ.isPending ? (
          <div className="px-2 pb-2 pt-1">
            <SkRows rows={6} />
          </div>
        ) : chaptersQ.isError ? (
          <p className="px-3 py-3 text-center text-[12px]">
            <span className="dd-hottext">章节加载失败</span>
            <button className="dd-greenlink ml-2" onClick={() => chaptersQ.refetch()}>
              点击重试
            </button>
          </p>
        ) : !latest6 || latest6.length === 0 ? (
          <p className="dd-hottext px-3 py-3 text-[12px]">本书暂无章节，先去书库看看别的吧。</p>
        ) : (
          <dl className="dd-dd-grid px-2 pb-2 pt-1">
            <dt className="dd-hei col-span-full bg-[#c3dfea] text-center text-[14px] font-bold leading-[28px] text-[#333]">
              《{n.title}》最新章节
            </dt>
            {latest6.map((c) => (
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

function BookSkeleton() {
  return (
    <div>
      <Sk className="mt-1 h-[36px] w-full" />
      <div className="dd-box dd-box-strong mt-2 p-[12px]">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Sk className="h-[217px] w-[174px] flex-none" />
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            <Sk className="h-[30px] w-1/2" />
            <Sk className="h-[16px] w-2/3" />
            <Sk className="h-[16px] w-1/3" />
            <Sk className="h-[16px] w-1/2" />
            <Sk className="h-[30px] w-44" />
          </div>
        </div>
        <Sk className="mt-3 h-[80px] w-full" />
      </div>
      <div className="dd-box dd-box-mid mt-2">
        <div className="dd-box-title bg-[#f6f8fe]">最新章节</div>
        <div className="p-2">
          <SkRows rows={6} />
        </div>
      </div>
    </div>
  )
}
