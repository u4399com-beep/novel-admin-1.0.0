'use client'

import { useCategories, useNovels } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { ErrorBox, NovelTable, Pager, SqIcon, TableSkeleton } from './parts'
import Sidebar from './Sidebar'

/** 分类页：左 190 侧栏（会员推荐+排行榜） + 右 760 数据表（6 列） + 翻页条 */
export default function Category({
  navigate,
  categoryId,
  page = 1,
}: ViewProps & { categoryId?: number; page?: number }) {
  const { data: categories } = useCategories()
  const curPage = page ?? 1
  const { data, isLoading, isError, refetch } = useNovels({ categoryId, page: curPage, pageSize: 20 })

  const categoryName = categories?.find((c) => c.id === categoryId)?.name
  const go = (p: number) => navigate({ name: 'category', categoryId, page: p })

  return (
    <div className="mt-2 flex items-start justify-between">
      <Sidebar navigate={navigate} />

      <div className="w-[760px] shrink-0">
        <h2 className="flex h-[30px] items-center gap-1.5 border border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] px-2 text-[14px] font-bold text-[#333]">
          <SqIcon />
          {categoryName ?? '全部分类'} - 文章列表
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
            <NovelTable novels={data?.list ?? []} navigate={navigate} />
            <div className="mt-1">
              <Pager page={data?.page ?? curPage} totalPages={data?.totalPages ?? 0} onGo={go} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
