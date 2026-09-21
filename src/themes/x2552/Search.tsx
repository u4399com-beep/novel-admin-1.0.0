'use client'

import { useMemo, useState, type FormEvent } from 'react'
import { useNovels } from '@/hooks/use-novel-data'
import type { ThemeView, ViewProps } from '../types'
import { Block, ErrorBox, NovelTable, Pager, SqIcon, TableSkeleton, XLink, type Nav } from './parts'
import Sidebar from './Sidebar'
import { useSearchField, type SearchField } from './search-field'

/**
 * 搜索页（Layout 完整页头 + 导航 + .footer）：左 190 侧栏 + 右 760
 * 源站搜索为 searchtype 双按钮（articlename/author）——搜书名/搜作者分别按
 * 书名字段/作者字段检索（本地二次过滤），回车 = 书名/作者/简介综合检索
 */
export default function Search({ navigate, query }: ViewProps & { query: string }) {
  const field = useSearchField((s) => s.field)
  // key=query|field：关键词或检索字段变化时重挂载，重置输入框与页码
  return <SearchPanel key={`${query}|${field}`} query={query} navigate={navigate} field={field} />
}

function SearchPanel({ query, navigate, field }: { query: string; navigate: Nav; field: SearchField }) {
  const [input, setInput] = useState(query)
  const setField = useSearchField((s) => s.setField)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const kw = input.trim()
    if (!kw) return
    setField('all')
    if (kw !== query) navigate({ name: 'search', query: kw })
  }
  const submitBy = (f: 'title' | 'author') => {
    const kw = input.trim()
    if (!kw) return
    setField(f)
    if (kw !== query) navigate({ name: 'search', query: kw })
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
              className="h-[28px] w-[280px] max-w-full min-w-0 flex-1 border border-[#CCCCCC] px-1 text-[12px] text-[#333] outline-none placeholder:text-[#BBB] focus:border-[#FF6600]"
            />
            <button
              type="button"
              onClick={() => submitBy('title')}
              title="按书名字段检索"
              className="h-[30px] w-[70px] cursor-pointer border border-[#E88B00] bg-gradient-to-b from-[#FFB34D] to-[#FF6F08] text-[12px] font-bold text-white transition hover:brightness-105"
            >
              搜书名
            </button>
            <button
              type="button"
              onClick={() => submitBy('author')}
              title="按作者字段检索"
              className="h-[30px] w-[70px] cursor-pointer border border-[#0578BB] bg-gradient-to-b from-[#73B7EE] to-[#0578BB] text-[12px] font-bold text-white transition hover:brightness-105"
            >
              搜作者
            </button>
            <button
              type="submit"
              title="书名/作者/简介综合检索"
              className="h-[30px] w-[70px] cursor-pointer border border-[#CCCCCC] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] text-[12px] text-[#333] transition hover:border-[#FF6600] hover:text-[#FF6600]"
            >
              综合
            </button>
          </form>
        </Block>

        {query ? <ResultPanel query={query} navigate={navigate} field={field} /> : <EmptyHint navigate={navigate} />}
      </div>
    </div>
  )
}

/* ==================== 结果区（query 非空才挂载，避免空词请求） ==================== */

function ResultPanel({ query, navigate, field }: { query: string; navigate: Nav; field: SearchField }) {
  const [page, setPage] = useState(1)

  /* all → 服务端分页检索；title/author → 一次拉取 60 条（API 上限）后按字段本地过滤 + 本地分页 */
  const serverQ = useNovels({ q: query, page: 1, pageSize: 20, enabled: field === 'all' })
  const poolQ = useNovels({ q: query, page: 1, pageSize: 60, enabled: field !== 'all' })

  const FILTERED_PAGE_SIZE = 20
  const filtered = useMemo(() => {
    if (field === 'all' || !poolQ.data) return null
    const rows = poolQ.data.list.filter((n) => (field === 'title' ? n.title : n.author).includes(query))
    return {
      rows,
      total: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / FILTERED_PAGE_SIZE)),
    }
  }, [field, poolQ.data, query])

  const isLoading = field === 'all' ? serverQ.isPending : poolQ.isPending
  const isError = field === 'all' ? serverQ.isError : poolQ.isError
  const refetch = () => (field === 'all' ? serverQ.refetch() : poolQ.refetch())
  const rows =
    field === 'all'
      ? (serverQ.data?.list ?? [])
      : (filtered?.rows.slice((page - 1) * FILTERED_PAGE_SIZE, page * FILTERED_PAGE_SIZE) ?? [])
  const total = field === 'all' ? (serverQ.data?.total ?? 0) : (filtered?.total ?? 0)
  const totalPages = field === 'all' ? (serverQ.data?.totalPages ?? 0) : (filtered?.totalPages ?? 0)
  const fieldLabel = field === 'title' ? '按书名' : field === 'author' ? '按作者' : '综合检索'

  return (
    <div className="mt-2">
      <h2 className="flex h-[30px] items-center gap-1.5 border border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] px-2 text-[14px] font-bold text-[#333]">
        <SqIcon />
        <span className="min-w-0 truncate">
          {fieldLabel}“{query}” 的搜索结果
        </span>
        {query && total > 0 && <span className="ml-1 shrink-0 text-[11px] font-normal text-[#999]">共 {total} 条</span>}
      </h2>

      {isError ? (
        <div className="mt-1">
          <ErrorBox onRetry={refetch} />
        </div>
      ) : isLoading ? (
        <div className="mt-1">
          <TableSkeleton rows={10} />
        </div>
      ) : (
        <>
          <div className="mt-1">
            <NovelTable
              novels={rows}
              navigate={navigate}
              emptyText={`没有找到与“${query}”相关的小说，换个关键词试试`}
            />
          </div>
          <div className="mt-1">
            <Pager page={page} totalPages={totalPages} onGo={setPage} />
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
      <p>输入关键词后点击「搜书名 / 搜作者」按字段检索，回车综合检索。</p>
      <p className="mt-2">
        <XLink onClick={() => navigate({ name: 'home' })} className="mr-3">
          返回首页
        </XLink>
        <XLink onClick={() => navigate({ name: 'category' })}>浏览全部分类</XLink>
      </p>
    </div>
  )
}
