'use client'

import { useState } from 'react'
import { Compass, Menu } from 'lucide-react'
import { useCategories, useNovels } from '@/hooks/use-novel-data'
import { cn } from '@/lib/utils'
import type { ViewProps } from '../types'
import { BookCard, CardListSkeleton, Empty, ErrorBox, Pagination, SectionTitle } from './parts'

/* 书库筛选侧栏（190px）：全部分类入口 + 分类导航（当前项深红底白字）+ 只看全本 */
function FilterPanel({
  categories,
  current,
  navigate,
  onlyFinished,
  onToggleFinished,
}: {
  categories: { id: number; name: string }[]
  current?: number
  navigate: ViewProps['navigate']
  onlyFinished: boolean
  onToggleFinished: (v: boolean) => void
}) {
  const item = 'block h-[50px] w-full cursor-pointer text-center text-[15px] transition-colors'
  return (
    <div className="space-y-[10px]">
      <div className="border border-[#E6E6E6] bg-white">
        <button
          onClick={() => navigate({ name: 'category' })}
          className={cn(item, current == null ? 'bg-[#BF2C24] font-bold text-white' : 'text-[#555] hover:text-[#ED4259]')}
        >
          全部分类
        </button>
      </div>
      <div className="border border-[#E6E6E6] bg-white py-1">
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
            className={cn(item, current === c.id ? 'bg-[#BF2C24] font-bold text-white' : 'text-[#555] hover:text-[#ED4259]')}
          >
            {c.name}
          </button>
        ))}
      </div>
      <label className="flex h-[50px] cursor-pointer items-center justify-center gap-2 border border-[#E6E6E6] bg-white text-[14px] text-[#555]">
        <input
          type="checkbox"
          className="size-4 accent-[#BF2C24]"
          checked={onlyFinished}
          onChange={(e) => onToggleFinished(e.target.checked)}
        />
        只看全本
      </label>
    </div>
  )
}

/** 书库页：左 760 内容（2 列图书卡 + 分页） + 右 190 筛选侧栏 */
export default function Category({
  navigate,
  categoryId,
  page = 1,
}: ViewProps & { categoryId?: number; page?: number }) {
  const { data: categories } = useCategories()
  const [onlyFinished, setOnlyFinished] = useState(false)
  const [mobileFilter, setMobileFilter] = useState(false)
  const curPage = page ?? 1

  const { data, isLoading, isError, refetch } = useNovels({
    categoryId,
    page: curPage,
    pageSize: 20,
    status: onlyFinished ? 'finished' : undefined,
  })

  const categoryName = categories?.find((c) => c.id === categoryId)?.name
  const go = (p: number) => navigate({ name: 'category', categoryId, page: p })
  const toggleFinished = (v: boolean) => {
    setOnlyFinished(v)
    if (curPage !== 1) go(1)
  }

  return (
    <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
      <div className="flex items-start gap-[10px]">
        {/* 左：图书卡列表 */}
        <div className="min-w-0 flex-1 space-y-[10px]">
          <section className="bg-white">
            <SectionTitle
              icon={<Compass size={16} />}
              title={categoryName ?? '全部小说'}
              extra={
                data ? (
                  <span className="text-[12px] font-normal text-[#969BA3]">
                    共 {data.total} 本 · 第 {data.page}/{data.totalPages} 页
                  </span>
                ) : undefined
              }
            />
            {isLoading ? (
              <CardListSkeleton count={6} />
            ) : isError ? (
              <ErrorBox onRetry={() => refetch()} />
            ) : data && data.list.length > 0 ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-4 py-4 max-[639px]:grid-cols-1">
                {data.list.map((n) => (
                  <BookCard key={n.id} novel={n} navigate={navigate} />
                ))}
              </div>
            ) : (
              <Empty text={onlyFinished ? '该分类暂无完本小说' : '该分类暂无小说'} />
            )}
          </section>
          {data && data.totalPages > 1 && (
            <div className="bg-white">
              <Pagination page={data.page} totalPages={data.totalPages} onGo={go} />
            </div>
          )}
        </div>

        {/* 右：筛选侧栏（767px 以下隐藏） */}
        <aside className="w-[190px] shrink-0 max-[767px]:hidden">
          <FilterPanel
            categories={categories ?? []}
            current={categoryId}
            navigate={navigate}
            onlyFinished={onlyFinished}
            onToggleFinished={toggleFinished}
          />
        </aside>
      </div>

      {/* 移动端筛选：汉堡按钮展开 #after_menu 式筛选菜单 */}
      <button
        onClick={() => setMobileFilter((v) => !v)}
        className="mt-[10px] hidden h-[40px] w-full cursor-pointer items-center justify-center gap-2 bg-[#BF2C24] text-[14px] text-white transition-colors hover:bg-[#ED4259] max-[767px]:flex"
      >
        <Menu size={16} />
        {mobileFilter ? '收起筛选' : '筛选分类 / 只看全本'}
      </button>
      {mobileFilter && (
        <div className="mt-[10px] max-[767px]:block hidden">
          <FilterPanel
            categories={categories ?? []}
            current={categoryId}
            navigate={navigate}
            onlyFinished={onlyFinished}
            onToggleFinished={toggleFinished}
          />
        </div>
      )}
    </div>
  )
}
