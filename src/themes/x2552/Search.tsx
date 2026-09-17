'use client'

import { useState, type FormEvent } from 'react'
import { useNovels } from '@/hooks/use-novel-data'
import type { ThemeView, ViewProps } from '../types'
import { Block, ErrorBox, NovelTable, Pager, SqIcon, TableSkeleton, XLink, type Nav } from './parts'
import Sidebar from './Sidebar'

/**
 * 搜索页（Layout 完整页头 + 导航 + .footer）：左 190 侧栏 + 右 760
 * 站内搜索表单 → 空 query 提示 / 结果 6 列表 + 翻页条
 */
export default function Search({ navigate, query }: ViewProps & { query: string }) {
  // key=query：关键词变化时重挂载，重置输入框与页码
  return <SearchPanel key={query} query={query} navigate={navigate} />
}

function SearchPanel({ query, navigate }: { query: string; navigate: Nav }) {
  const [input, setInput] = useState(query)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const kw = input.trim()
    if (kw) navigate({ name: 'search', query: kw })
  }

  return (
    <div className="mt-2 flex items-start justify-between">
      <Sidebar navigate={navigate} />

      <div className="min-w-0 flex-1 lg:w-[760px] lg:max-w-[760px] lg:flex-none">
        <Block title="站内搜索" titleH={30}>
          <form onSubmit={submit} className="flex flex-wrap items-center gap-1 p-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入书名或作者关键词"
              className="h-[28px] w-[420px] max-w-full flex-1 border border-[#CCCCCC] px-1 text-[12px] text-[#333] outline-none placeholder:text-[#BBB] focus:border-[#FF6600]"
            />
            <button
              type="submit"
              className="h-[30px] w-[70px] cursor-pointer border border-[#E88B00] bg-gradient-to-b from-[#FFB34D] to-[#FF6F08] text-[12px] font-bold text-white transition hover:brightness-105"
            >
              搜 索
            </button>
          </form>
        </Block>

        {query ? <ResultPanel query={query} navigate={navigate} /> : <EmptyHint navigate={navigate} />}
      </div>
    </div>
  )
}

/* ==================== 结果区（query 非空才挂载，避免空词请求） ==================== */

function ResultPanel({ query, navigate }: { query: string; navigate: Nav }) {
  const [page, setPage] = useState(1)
  const { data, isLoading, isError, refetch } = useNovels({ q: query, page, pageSize: 20 })

  return (
    <div className="mt-2">
      <h2 className="flex h-[30px] items-center gap-1.5 border border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] px-2 text-[14px] font-bold text-[#333]">
        <SqIcon />
        <span className="min-w-0 truncate">“{query}” 的搜索结果</span>
        {data && <span className="ml-1 shrink-0 text-[11px] font-normal text-[#999]">共 {data.total} 条</span>}
      </h2>

      {isError ? (
        <div className="mt-1">
          <ErrorBox onRetry={() => refetch()} />
        </div>
      ) : isLoading ? (
        <div className="mt-1">
          <TableSkeleton rows={10} />
        </div>
      ) : (
        <>
          <div className="mt-1">
            <NovelTable
              novels={data?.list ?? []}
              navigate={navigate}
              emptyText={`没有找到与“${query}”相关的小说，换个关键词试试`}
            />
          </div>
          <div className="mt-1">
            <Pager page={data?.page ?? page} totalPages={data?.totalPages ?? 0} onGo={(p) => setPage(p)} />
          </div>
        </>
      )}
    </div>
  )
}

/* ==================== 空 query 提示 ==================== */

function EmptyHint({ navigate }: { navigate: (v: ThemeView) => void }) {
  return (
    <div className="mt-2 border border-[#E4E4E4] bg-white py-10 text-center text-[12px] leading-[22px] text-[#999]">
      <p>请输入书名或作者关键词开始搜索。</p>
      <p className="mt-2">
        <XLink onClick={() => navigate({ name: 'home' })} className="mr-3">
          返回首页
        </XLink>
        <XLink onClick={() => navigate({ name: 'category' })}>浏览全部分类</XLink>
      </p>
    </div>
  )
}
