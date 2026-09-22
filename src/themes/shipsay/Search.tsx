'use client'

import { useState } from 'react'
import { Search as SearchIcon } from 'lucide-react'
import { useNovels } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { BookCard, CardListSkeleton, Empty, ErrorBox, SectionTitle } from './parts'

/** 搜索页：本地输入 state + useNovels({ q })，结果为双列图书卡 */
export default function Search({ navigate, query }: ViewProps & { query: string }) {
  const [kw, setKw] = useState(query)
  const [lastQuery, setLastQuery] = useState(query)

  /* query 变化时在渲染期重置（React 官方推荐模式，替代 effect） */
  if (lastQuery !== query) {
    setLastQuery(query)
    setKw(query)
  }

  /* 只按已提交的 query 拉数据，避免边输边查（一次拉全，无分页） */
  const { data, isLoading, isError, refetch } = useNovels({ q: query || undefined, pageSize: 500 })

  const submit = () => {
    const next = kw.trim()
    if (next && next !== query) navigate({ name: 'search', query: next })
  }

  return (
    <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
      <section className="bg-white">
        <SectionTitle
          icon={<SearchIcon size={16} />}
          title={query ? `“${query}” 的搜索结果` : '站内搜索'}
          extra={
            query && data ? (
              <span className="text-[12px] font-normal text-[#969BA3]">共 {data.total} 条</span>
            ) : undefined
          }
        />

        <div className="flex gap-2 px-4 pt-4">
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="输入书名 / 作者关键词"
            className="h-[36px] min-w-0 flex-1 rounded-[3px] border border-[#E6E6E6] px-3 text-[13px] text-[#333] outline-none placeholder:text-[#C0C4CC] focus:border-[#BF2C24]"
          />
          <button
            onClick={submit}
            className="h-[36px] cursor-pointer rounded-[3px] bg-[#BF2C24] px-5 text-[13px] text-white transition-colors hover:bg-[#ED4259]"
          >
            搜索
          </button>
        </div>

        {!query ? (
          <p className="px-4 py-10 text-center text-[13px] text-[#969BA3]">输入关键词开始搜索，支持书名与作者</p>
        ) : isLoading ? (
          <CardListSkeleton count={4} />
        ) : isError ? (
          <ErrorBox onRetry={() => refetch()} />
        ) : data && data.list.length > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-4 py-4 max-[639px]:grid-cols-1">
              {data.list.map((n) => (
                <BookCard key={n.id} novel={n} navigate={navigate} />
              ))}
            </div>
          </>
        ) : (
          <Empty text={`未找到与“${query}”相关的小说，换个关键词试试`} />
        )}
      </section>
    </div>
  )
}
