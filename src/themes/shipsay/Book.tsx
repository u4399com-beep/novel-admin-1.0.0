'use client'

import { useState } from 'react'
import { NovelTagsRow } from '@/components/novel-tags'
import { useChapters, useNovel } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { ChapterGrid, Cover, Empty, ErrorBox, RowsSkeleton, Tag, fmtDate, fmtWords, statusText } from './parts'

type Tab = 'info' | 'catalog'

/** 书籍详情页：信息头（120×160 封面 + 徽章 + 按钮） + Tab 卡片（作品信息 / 完整目录 3 列） */
export default function Book({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isLoading, isError, refetch } = useNovel(novelId)
  const [tab, setTab] = useState<Tab>('info')
  const { data: allChapters, isLoading: chLoading, isError: chError, refetch: chRefetch } = useChapters(novelId)
  /* 最新 12 章新→旧（全量章节末 12 条倒序）；详情接口的 chapters 是最早 12 章，不可直接用 */
  const latestChapters = allChapters ? [...allChapters].slice(-12).reverse() : null

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
        <div className="space-y-[10px]">
          <div className="flex gap-4 bg-white p-4">
            <div className="h-[160px] w-[120px] shrink-0 animate-pulse rounded bg-[#ECECEC]" />
            <div className="flex flex-1 flex-col gap-3 py-2">
              <div className="h-[20px] w-1/2 animate-pulse rounded bg-[#ECECEC]" />
              <div className="h-[12px] w-1/3 animate-pulse rounded bg-[#F1F1F1]" />
              <div className="h-[12px] w-2/3 animate-pulse rounded bg-[#F1F1F1]" />
              <div className="mt-auto h-[35px] w-[220px] animate-pulse rounded bg-[#F1F1F1]" />
            </div>
          </div>
          <div className="bg-white p-4">
            <RowsSkeleton rows={5} rowH={38} />
          </div>
        </div>
      </div>
    )
  }

  if (isError || !novel) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  const lastId = novel.lastChapterId

  return (
    <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
      <div className="space-y-[10px]">
        {/* 信息头 */}
        <section className="bg-white p-4">
          <div className="flex gap-4 max-[639px]:flex-col">
            <Cover
              novel={novel}
              overlay
              charClass="text-4xl"
              className="h-[160px] w-[120px] shadow-md shadow-black/20"
            />
            <div className="min-w-0 flex-1">
              <h1 className="text-[24px] font-bold leading-tight text-[#555]">{novel.title}</h1>
              <div className="mt-1 text-[13px] text-[#969BA3]">
                作者：{novel.author} · {novel.categoryName}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Tag>{novel.categoryName}</Tag>
                <Tag>{fmtWords(novel.wordCount)}</Tag>
                <Tag>{statusText(novel.status)}</Tag>
                <Tag>{novel.totalChapters} 章</Tag>
              </div>
              <div className="mt-2 text-[13px] text-[#666]">
                最新章节：
                {lastId != null ? (
                  <span
                    className="cursor-pointer text-[#BF2C24] transition-colors hover:text-[#ED4259]"
                    onClick={() => navigate({ name: 'chapter', chapterId: lastId })}
                  >
                    {novel.lastChapterTitle ?? '暂无'}
                  </span>
                ) : (
                  <span>{novel.lastChapterTitle ?? '暂无'}</span>
                )}
                <span className="ml-2 text-[#969BA3]">{fmtDate(novel.updatedAt)}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {novel.firstChapterId != null && (
                  <button
                    onClick={() => navigate({ name: 'chapter', chapterId: novel.firstChapterId! })}
                    className="h-[35px] w-[108px] cursor-pointer rounded-[3px] bg-[#BF2C24] text-[14px] text-white transition-colors hover:bg-[#ED4259]"
                  >
                    开始阅读
                  </button>
                )}
                <button
                  onClick={() => navigate({ name: 'toc', novelId })}
                  className="h-[35px] w-[108px] cursor-pointer rounded-[3px] border border-[#BF2C24] bg-white text-[14px] text-[#BF2C24] transition-colors hover:border-[#ED4259] hover:bg-[#ED4259] hover:text-white"
                >
                  查看目录
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Tab 卡片栏：40px 高，当前 Tab 底部 2px 主题红线 */}
        <div className="flex border-b border-[#EEE] bg-white px-4">
          {(
            [
              ['info', `作品信息`],
              ['catalog', `目录（${novel.totalChapters} 章）`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cnTab(key === tab)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'info' ? (
          <>
            {/* 作品简介 */}
            <section className="bg-white p-4">
              <p className="indent-[2em] text-[14px] leading-[1.8] text-[#666]">
                {novel.description || '（暂无简介）'}
              </p>
              <NovelTagsRow tags={novel.tags ?? []} navigate={navigate} className="mt-3" />
            </section>
            {/* 最新章节卡片：居中标题 + 3 列章节（最新 12 条，新→旧） */}
            <section className="bg-white">
              <div className="border-b border-[#DDD] py-2.5 text-center text-[15px] font-bold text-[#3E3D43]">
                最新章节
              </div>
              {chLoading ? (
                <RowsSkeleton rows={6} rowH={50} />
              ) : chError ? (
                <ErrorBox onRetry={chRefetch} />
              ) : !latestChapters || latestChapters.length === 0 ? (
                <Empty text="暂无章节" />
              ) : (
                <div className="px-2 py-2">
                  <ChapterGrid chapters={latestChapters} navigate={navigate} />
                </div>
              )}
            </section>
          </>
        ) : (
          /* 完整目录：升序 3 列 */
          <section className="bg-white">
            <div className="border-b border-[#DDD] py-2.5 text-center text-[15px] font-bold text-[#3E3D43]">
              完整目录（升序）
            </div>
            {chLoading ? (
              <RowsSkeleton rows={9} rowH={50} />
            ) : chError ? (
              <ErrorBox onRetry={() => chRefetch()} />
            ) : allChapters && allChapters.length > 0 ? (
              <div className="px-2 py-2">
                <ChapterGrid chapters={allChapters} navigate={navigate} />
              </div>
            ) : (
              <Empty text="暂无章节" />
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function cnTab(active: boolean): string {
  return [
    'h-[40px] cursor-pointer border-b-2 px-4 text-[18px] transition-colors',
    active
      ? 'border-[#BF2C24] font-medium text-[#BF2C24]'
      : 'border-transparent text-[#666] hover:text-[#ED4259]',
  ].join(' ')
}
