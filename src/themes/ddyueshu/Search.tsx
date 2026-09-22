'use client'

import { useState } from 'react'
import { useNovels } from '@/hooks/use-novel-data'
import type { ThemeView, ViewProps } from '../types'
import { ErrBlock, SkRows, TableHead, UpdateRow } from './parts'

/* ==================== 搜索页（本地输入 state + useNovels({ q }) 高密度结果列表） ==================== */

export default function Search({ navigate, query }: ViewProps & { query: string }) {
  return (
    <div>
      {/* key=query：关键词变化时重挂载，重置输入框 */}
      <SearchPanel key={query} query={query} navigate={navigate} />
    </div>
  )
}

function SearchPanel({ query, navigate }: { query: string; navigate: (v: ThemeView) => void }) {
  const [input, setInput] = useState(query)
  const list = useNovels({ q: query || undefined, pageSize: 500 })

  const submit = () => {
    const kw = input.trim()
    if (kw) navigate({ name: 'search', query: kw })
  }

  return (
    <div>
      {/* 搜索表单（同 Layout 头部样式：2px 天蓝描边 + 蓝底白字按钮） */}
      <section className="dd-box dd-box-mid mt-1">
        <div className="dd-box-title bg-[#f6f8fe]">站内搜索</div>
        <form
          className="flex flex-wrap items-center gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="搜书名 / 搜作者"
            className="h-[30px] min-w-0 flex-1 border-0 bg-white px-2 text-[13px] text-[#444] outline-none placeholder:text-[#b3b3b3]"
          />
          <button
            type="submit"
            className="h-[30px] flex-none cursor-pointer bg-[#88c6e5] px-5 text-[16px] text-white transition-colors hover:bg-[#459df5]"
          >
            搜 索
          </button>
        </form>
      </section>

      {/* 结果列表：[分类] 书名 最新章节 作者 日期 25px 行 */}
      <section className="dd-box dd-box-strong mt-2">
        <div className="dd-box-title bg-[#a6d3e8]">
          {query
            ? `“${query}” 的搜索结果${list.data ? `（共 ${list.data.total} 条）` : ''}`
            : '全部小说 · 输入关键词可按书名 / 作者查找'}
        </div>
        <div className="bg-[#e1eced] px-2 py-1.5">
          {list.isPending ? (
            <SkRows rows={15} />
          ) : list.isError || !list.data ? (
            <ErrBlock
              msg={list.error instanceof Error ? list.error.message : ''}
              onRetry={() => list.refetch()}
            />
          ) : list.data.list.length === 0 ? (
            <p className="dd-hottext py-6 text-center text-[13px]">
              {query ? `没有找到与“${query}”相关的小说，换个关键词试试。` : '书库暂时为空，请稍后再来。'}
            </p>
          ) : (
            <>
              <TableHead />
              {list.data.list.map((n) => (
                <UpdateRow key={n.id} novel={n} navigate={navigate} />
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
