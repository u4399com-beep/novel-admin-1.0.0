'use client'

import { useCategories, useNovels } from '@/hooks/use-novel-data'
import { cn } from '@/lib/utils'
import type { ViewProps } from '../types'
import { CoverItem, DdPager, ErrBlock, SimpleRow, Sk, SkRows, TableHead, UpdateRow } from './parts'

/* ==================== 分类页（specs：全宽强推 + 更新列表/相关推荐两栏） ==================== */

export default function Category({
  navigate,
  categoryId,
  page = 1,
}: ViewProps & { categoryId?: number; page?: number }) {
  const cats = useCategories()
  const list = useNovels({ categoryId, page, pageSize: 20 })
  const hot = useNovels({ categoryId, sort: 'featured', pageSize: 6 })
  const related = useNovels({ categoryId, sort: 'clicks', pageSize: 30 })

  const catName = cats.data?.find((c) => c.id === categoryId)?.name

  return (
    <div>
      {/* ① 分类切换条 */}
      <nav
        aria-label="分类切换"
        className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 border-2 border-[#a6d3e8] bg-white px-2 py-1.5 text-[13px]"
      >
        <span className="mr-1 flex-none font-bold text-[#333]">小说分类：</span>
        <button
          className={cn(
            'cursor-pointer px-2 leading-[22px] transition-colors',
            categoryId == null ? 'bg-[#88c6e5] text-white hover:bg-[#459df5]' : 'dd-greenlink'
          )}
          onClick={() => navigate({ name: 'category', page: 1 })}
        >
          全部
        </button>
        {(cats.data ?? []).map((c) => (
          <button
            key={c.id}
            className={cn(
              'cursor-pointer px-2 leading-[22px] transition-colors',
              categoryId === c.id ? 'bg-[#88c6e5] text-white hover:bg-[#459df5]' : 'dd-greenlink'
            )}
            onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
          >
            {c.name}
          </button>
        ))}
      </nav>

      {/* ② 全宽强推区（#C8D4E1 描边 + 封面卡三列） */}
      <section className="dd-box dd-box-c8 mt-2">
        <div className="dd-box-title bg-[#e1eced]">
          {(catName ?? '全站') + '小说精选强推'}
        </div>
        <div className="grid gap-3 p-[10px] sm:grid-cols-2 lg:grid-cols-3">
          {hot.isPending
            ? [0, 1, 2].map((i) => (
                <div key={i} className="flex gap-2.5">
                  <Sk className="h-[150px] w-[120px] flex-none" />
                  <div className="min-w-0 flex-1 space-y-2 pt-1">
                    <Sk className="h-[18px] w-3/4" />
                    <Sk className="h-[100px] w-full" />
                  </div>
                </div>
              ))
            : hot.isError
              ? (
                <p className="py-3 text-center text-[12px] sm:col-span-2 lg:col-span-3">
                  <span className="dd-hottext">强推数据加载失败</span>
                  <button className="dd-greenlink ml-2" onClick={() => hot.refetch()}>
                    点击重试
                  </button>
                </p>
              )
              : (hot.data?.list ?? []).slice(0, 6).map((n) => (
                  <CoverItem key={n.id} novel={n} navigate={navigate} />
                ))}
        </div>
      </section>

      {/* ③ 两栏区：左更新列表（695px） + 右相关推荐 */}
      <section className="mt-2 flex flex-col gap-2 lg:flex-row">
        <div className="dd-box dd-box-mid min-w-0 lg:w-[695px]">
          <div className="dd-box-title flex items-center justify-between bg-[#f6f8fe]">
            <span className="min-w-0 truncate">好看的{catName ?? ''}小说最近更新列表</span>
            {list.data && (
              <span className="flex-none text-[12px] font-normal text-[#999]">共 {list.data.total} 部</span>
            )}
          </div>
          <div className="px-2 py-1.5">
            {list.isPending ? (
              <SkRows rows={14} />
            ) : list.isError || !list.data ? (
              <ErrBlock
                msg={list.error instanceof Error ? list.error.message : ''}
                onRetry={() => list.refetch()}
              />
            ) : list.data.list.length === 0 ? (
              <p className="dd-hottext py-6 text-center text-[13px]">该分类下暂无收录小说，换个分类逛逛吧。</p>
            ) : (
              <>
                <TableHead />
                {list.data.list.map((n) => (
                  <UpdateRow key={n.id} novel={n} navigate={navigate} />
                ))}
                <DdPager
                  page={list.data.page}
                  totalPages={list.data.totalPages}
                  go={(p) => navigate({ name: 'category', categoryId, page: p })}
                />
              </>
            )}
          </div>
        </div>
        <div className="dd-box dd-box-mid min-w-0 flex-1">
          <div className="dd-box-title flex items-center justify-between bg-[#f6f8fe]">
            <span>小说相关推荐</span>
            <span className="text-[12px] font-normal text-[#999]">热门点击</span>
          </div>
          <div className="px-2 py-1.5">
            {related.isPending ? (
              <SkRows rows={14} />
            ) : related.isError ? (
              <p className="py-3 text-center text-[12px]">
                <span className="dd-hottext">推荐数据加载失败</span>
                <button className="dd-greenlink ml-2" onClick={() => related.refetch()}>
                  点击重试
                </button>
              </p>
            ) : (
              (related.data?.list ?? []).slice(0, 30).map((n) => (
                <SimpleRow key={n.id} novel={n} navigate={navigate} />
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
