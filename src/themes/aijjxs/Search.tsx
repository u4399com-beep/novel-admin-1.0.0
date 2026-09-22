'use client'

import { useState } from 'react'
import { useNovels } from '@/hooks/use-novel-data'
import type { ThemeView, ViewProps } from '../types'
import { CoverCard, ErrBlock, Panel, SkRows } from './parts'

export default function Search({ navigate, query }: ViewProps & { query: string }) {
  /* key=query：关键词变化时重挂载，重置输入框 */
  return <SearchPanel key={query} query={query} navigate={navigate} />
}

function SearchPanel({ navigate, query }: { query: string; navigate: (v: ThemeView) => void }) {
  const [kw, setKw] = useState(query)

  /* 有关键词走搜索（一次拉全），无关键词展示热门榜 */
  const res = useNovels(query ? { q: query, pageSize: 500 } : { sort: 'clicks', pageSize: 12 })

  return (
    <div className="mx-auto w-full max-w-[860px]">
      {/* 搜索框卡片 */}
      <section className="aj-card p-4 sm:p-5">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            navigate({ name: 'search', query: kw.trim() })
          }}
        >
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="输入书名或作者名…"
            className="h-[44px] min-w-0 flex-1 rounded-[10px] border border-[#e5dccd] bg-white px-4 text-[14px] outline-none transition-colors placeholder:text-[#b7ac97] focus:border-[#0f766e]"
          />
          <button type="submit" className="aj-btn aj-btn-teal flex-none px-6">
            搜索全站
          </button>
        </form>
        {query ? (
          <p className="mt-3 text-[13px] text-[#6b7280]">
            关键词「<span className="font-semibold text-[#b45309]">{query}</span>」
            {res.isPending ? '，检索中…' : res.data ? `，共找到 ${res.data.total} 条结果` : ''}
          </p>
        ) : (
          <p className="mt-3 text-[13px] text-[#9ca3af]">支持书名 / 作者模糊搜索，回车或点击按钮提交。</p>
        )}
      </section>

      {/* 结果区 */}
      <div className="mt-4">
        {res.isPending ? (
          <div className="aj-card p-4">
            <SkRows rows={6} />
          </div>
        ) : res.isError ? (
          <ErrBlock msg={res.error instanceof Error ? res.error.message : ''} onRetry={() => res.refetch()} />
        ) : (res.data?.list ?? []).length === 0 ? (
          <div className="aj-card p-10 text-center text-[14px] text-[#6b7280]">
            没有找到与「{query}」相关的小说，换个关键词试试？
          </div>
        ) : (
          <Panel
            title={query ? '搜索结果' : '大家都在看'}
            extra={<span className="text-xs text-[#9ca3af]">{res.data?.total ?? 0} 条</span>}
          >
            <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
              {(res.data?.list ?? []).map((n) => (
                <CoverCard key={n.id} novel={n} navigate={navigate} />
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  )
}
