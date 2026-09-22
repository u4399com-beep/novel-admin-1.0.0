'use client'

import { useState } from 'react'
import { useCategories, useNovels } from '@/hooks/use-novel-data'
import type { NovelListParams } from '@/hooks/use-novel-data'
import { cn } from '@/lib/utils'
import type { NovelListItem } from '@/lib/types'
import { CategoryFeaturedBlock, CategoryHotBlock } from '@/components/theme-extras'
import type { ThemeView, ViewProps } from '../types'
import {
  AuthorCloud,
  collectAuthors,
  Cover,
  ErrBlock,
  fmtDate,
  fmtWords,
  Panel,
  RankList,
  Sk,
  SkRows,
} from './parts'

type SortKey = NonNullable<NovelListParams['sort']>
type StatusKey = 'all' | 'serial' | 'finished'

const SORTS: { k: SortKey; label: string }[] = [
  { k: 'latest', label: '最新上传' },
  { k: 'clicks', label: '人气最高' },
  { k: 'words', label: '字数最多' },
  { k: 'featured', label: '只看推荐' },
]
const STATUS: { k: StatusKey; label: string }[] = [
  { k: 'all', label: '不限' },
  { k: 'serial', label: '连载中' },
  { k: 'finished', label: '已完结' },
]

export default function Category({ navigate, categoryId }: ViewProps & { categoryId?: number }) {
  const cats = useCategories()
  const [sort, setSort] = useState<SortKey>('latest')
  const [status, setStatus] = useState<StatusKey>('all')
  const list = useNovels({
    categoryId,
    pageSize: 500,
    sort,
    status: status === 'all' ? undefined : status,
  })
  const side = useNovels({ categoryId, sort: 'clicks', pageSize: 10 })

  const catName = cats.data?.find((c) => c.id === categoryId)?.name
  const pickSort = (s: SortKey) => setSort(s)
  const pickStatus = (k: StatusKey) => setStatus(k)

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
      {/* 左主栏：整体卡片 cenMain */}
      <div className="min-w-0">
        <section className="aj-card overflow-hidden">
          <h1 className="border-b border-[#e5dccd] py-5 text-center text-[20px] font-bold text-[#134e4a]">
            {catName ?? '全站'}小说电子书下载
          </h1>
          {/* 筛选条：胶囊按钮组 */}
          <div className="space-y-2.5 border-b border-dashed border-[#e5dccd] px-4 py-3.5 sm:px-5">
            <FilterRow label="排序" options={SORTS} active={sort} onPick={pickSort} />
            <FilterRow label="状态" options={STATUS} active={status} onPick={pickStatus} />
          </div>
          {/* 图文推荐 / 热门书籍区块（无数据时自渲染 null） */}
          <CategoryFeaturedBlock navigate={navigate} categoryId={categoryId} />
          <CategoryHotBlock navigate={navigate} categoryId={categoryId} />
          {/* 列表 */}
          <div className="space-y-3 p-3 sm:p-4">
            {list.isPending ? (
              <ListSkeleton />
            ) : list.isError ? (
              <ErrBlock msg={list.error instanceof Error ? list.error.message : ''} onRetry={() => list.refetch()} />
            ) : list.data.list.length === 0 ? (
              <p className="py-10 text-center text-[14px] text-[#6b7280]">该条件下暂无小说，换个筛选试试。</p>
            ) : (
              list.data.list.map((n) => <ListCard key={n.id} novel={n} navigate={navigate} />)
            )}
          </div>
        </section>
      </div>

      {/* 右侧栏 */}
      <aside className="min-w-0 space-y-4 self-start lg:sticky lg:top-[70px]">
        <Panel title={`${catName ?? '全站'}·热门排行`} bodyClassName="p-3">
          {side.isPending ? (
            <SkRows rows={8} />
          ) : side.isError ? (
            <ErrBlock onRetry={() => side.refetch()} />
          ) : (
            <RankList novels={side.data?.list ?? []} navigate={navigate} />
          )}
        </Panel>
        <Panel title="相关分类" bodyClassName="p-3">
          <div className="grid grid-cols-2 gap-x-4">
            {(cats.data ?? []).map((c) => (
              <button
                key={c.id}
                onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
                className={cn('aj-row justify-between', c.id === categoryId && 'font-bold text-[#0f766e]')}
              >
                <span className="min-w-0 truncate text-[13px]">{c.name}</span>
                <span className="flex-none text-xs text-[#9ca3af]">{c.novelCount}本</span>
              </button>
            ))}
          </div>
        </Panel>
        <Panel title="热门作者" bodyClassName="p-3">
          <AuthorCloud authors={collectAuthors([side.data?.list ?? []], 14)} navigate={navigate} />
        </Panel>
      </aside>
    </div>
  )
}

/* ==================== 筛选行 ==================== */

function FilterRow<T extends string>({
  label,
  options,
  active,
  onPick,
}: {
  label: string
  options: { k: T; label: string }[]
  active: T
  onPick: (k: T) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 flex-none text-xs text-[#9ca3af]">{label}</span>
      {options.map((o) => (
        <button
          key={o.k}
          onClick={() => onPick(o.k)}
          className={cn(
            'cursor-pointer rounded-full px-3 py-1.5 text-[13px] transition-colors',
            active === o.k
              ? 'bg-[#0f766e] text-white shadow-sm'
              : 'border border-[#e5dccd] bg-white text-[#6b7280] hover:border-[#0f766e] hover:text-[#0f766e]'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ==================== 横条卡（左封面 92×128 + 简介 + meta） ==================== */

function ListCard({ novel, navigate }: { novel: NovelListItem; navigate: (v: ThemeView) => void }) {
  return (
    <article
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
      className="group flex cursor-pointer gap-4 rounded-[14px] border border-[#e5dccd] bg-gradient-to-b from-[#fffdf8] to-[#f8f2e4] p-3.5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg sm:p-4"
    >
      <Cover novel={novel} className="h-[128px] w-[92px]" rounded="rounded-[6px]" charClass="text-[26px]" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 truncate text-[17px] font-bold text-[#155e4b] transition-colors group-hover:text-[#0f766e] sm:text-[18px]">
            {novel.title}
          </h3>
          {novel.isFeatured && <span className="aj-badge">荐</span>}
          <span className="ml-auto hidden flex-none text-xs text-[#9ca3af] sm:block">
            上传 {fmtDate(novel.updatedAt)}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-[13px] leading-[1.65] text-[#6b7280]">{novel.description}</p>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-[#8a7a5c]">
          <span>作者：{novel.author}</span>
          <span>{fmtWords(novel.wordCount)}</span>
          {novel.status === 'finished' ? (
            <span className="aj-pill aj-pill-done">已完结</span>
          ) : (
            <span className="aj-pill aj-pill-serial">连载中</span>
          )}
          <span className="rounded-full bg-[#f3ecdd] px-2 py-0.5">在线阅读</span>
          <span className="rounded-full bg-[#f3ecdd] px-2 py-0.5">TXT下载</span>
        </div>
      </div>
    </article>
  )
}

/* ==================== 骨架屏 ==================== */

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-4 rounded-[14px] border border-[#e5dccd] p-3.5">
          <Sk className="h-[128px] w-[92px] flex-none" />
          <div className="min-w-0 flex-1 space-y-2.5 pt-1">
            <Sk className="h-5 w-1/2" />
            <Sk className="h-4 w-full" />
            <Sk className="h-4 w-3/4" />
            <Sk className="h-4 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}
