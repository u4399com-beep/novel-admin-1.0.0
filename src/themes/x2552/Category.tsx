'use client'

import { useCategories, useNovels } from '@/hooks/use-novel-data'
import { CategoryFeaturedBlock, CategoryHotBlock } from '@/components/theme-extras'
import type { ViewProps } from '../types'
import { ErrorBox, NovelTable, SqIcon, TableSkeleton } from './parts'
import Sidebar from './Sidebar'

/** 分类页：左 190 侧栏（会员推荐+排行榜） + 右 760 数据表（6 列） */
export default function Category({ navigate, categoryId }: ViewProps & { categoryId?: number }) {
  const { data: categories } = useCategories()
  const { data, isLoading, isError, refetch } = useNovels({ categoryId, pageSize: 500 })

  const categoryName = categories?.find((c) => c.id === categoryId)?.name

  return (
    <div className="mt-2 flex items-start justify-between">
      <Sidebar navigate={navigate} />

      <div className="min-w-0 flex-1 lg:w-[760px] lg:max-w-[760px] lg:flex-none">
        <h2 className="flex h-[30px] items-center gap-1.5 border border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] px-2 text-[14px] font-bold text-[#333]">
          <SqIcon />
          {categoryName ?? '全部分类'} - 文章列表
        </h2>

        {/* 图文推荐 / 热门书籍区块（无数据时自渲染 null） */}
        <div className="mt-1">
          <CategoryFeaturedBlock navigate={navigate} categoryId={categoryId} />
          <CategoryHotBlock navigate={navigate} categoryId={categoryId} />
        </div>

        {isError ? (
          <div className="mt-1">
            <ErrorBox onRetry={() => refetch()} />
          </div>
        ) : isLoading ? (
          <div className="mt-1">
            <TableSkeleton rows={10} />
          </div>
        ) : (
          <div className="mt-1">
            <NovelTable novels={data?.list ?? []} navigate={navigate} />
          </div>
        )}
      </div>
    </div>
  )
}
