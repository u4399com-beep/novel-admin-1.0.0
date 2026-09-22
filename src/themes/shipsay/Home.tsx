'use client'

import { Clock3, Flame, LayoutGrid, Link2 } from 'lucide-react'
import { useHomeData, useNovels } from '@/hooks/use-novel-data'
import { HomeCustomBlocks } from '@/components/theme-extras'
import type { CategoryDto, NovelListItem } from '@/lib/types'
import type { ViewProps } from '../types'
import {
  Bar,
  BookCard,
  CardListSkeleton,
  Cover,
  Empty,
  ErrorBox,
  MoreLink,
  RowsSkeleton,
  SectionTitle,
  TextRankAside,
  fmtDateShort,
} from './parts'

function NoticeBar({ notice }: { notice: string }) {
  return (
    <div className="flex items-center gap-2 bg-white px-4 py-2.5 text-[13px] text-[#666]">
      <span className="shrink-0 rounded-sm bg-[#BF2C24] px-1.5 py-0.5 text-[11px] leading-none text-white">
        公告
      </span>
      <span className="min-w-0 truncate">{notice}</span>
    </div>
  )
}

/* 分类小版块：加粗分类名 → 60×80 头条 → 两列虚线文字清单 */
function CategorySection({
  category,
  navigate,
}: {
  category: CategoryDto
  navigate: ViewProps['navigate']
}) {
  const { data, isLoading } = useNovels({ categoryId: category.id, page: 1, pageSize: 13 })
  const list = data?.list ?? []
  const head: NovelListItem | undefined = list[0]
  const rest = list.slice(1, 13)

  return (
    <section className="bg-white">
      <button
        onClick={() => navigate({ name: 'category', categoryId: category.id })}
        className="flex w-full cursor-pointer items-center justify-between border-b border-[#E6E6E6] px-3 py-2.5 text-left transition-colors hover:bg-[#FAFAFA]"
      >
        <span className="text-[15px] font-bold text-[#3E3D43] transition-colors hover:text-[#ED4259]">
          {category.name}
        </span>
        <span className="text-[12px] text-[#969BA3]">更多 ›</span>
      </button>

      {isLoading ? (
        <div className="flex gap-2 px-3 py-3">
          <Bar className="h-[80px] w-[60px] shrink-0" />
          <div className="flex flex-1 flex-col gap-2 py-1">
            <Bar className="h-[12px] w-2/3" />
            <Bar className="h-[10px] w-full" />
            <Bar className="h-[10px] w-4/5" />
          </div>
        </div>
      ) : head ? (
        <>
          <div
            className="group flex cursor-pointer gap-2 px-3 py-3"
            onClick={() => navigate({ name: 'book', novelId: head.id })}
          >
            <Cover novel={head} charClass="text-xl" className="h-[80px] w-[60px]" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-bold text-[#1A1A1A] transition-colors group-hover:text-[#ED4259]">
                {head.title}
              </div>
              <div className="mt-0.5 text-[12px] text-[#969BA3]">{head.author}</div>
              <p className="mt-1 line-clamp-3 text-[12px] leading-[1.5] text-[#999]">
                {head.description || '（暂无简介）'}
              </p>
            </div>
          </div>
          <ul className="grid grid-cols-2 px-3 pb-2">
            {rest.map((n) => (
              <li
                key={n.id}
                className="group flex h-[38px] cursor-pointer items-center justify-between gap-1 border-b border-dashed border-[#CCC] pr-2"
                onClick={() => navigate({ name: 'book', novelId: n.id })}
              >
                <span className="min-w-0 truncate text-[13px] text-[#1A1A1A] transition-colors group-hover:text-[#ED4259]">
                  {n.title}
                </span>
                <span className="shrink-0 text-[11px] text-[#969BA3]">{n.author}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="px-3 py-6 text-center text-[12px] text-[#969BA3]">本分类暂无小说</p>
      )}
    </section>
  )
}

function FriendLinks({
  categories,
  navigate,
  siteName,
}: {
  categories: CategoryDto[]
  navigate: ViewProps['navigate']
  siteName: string
}) {
  const link =
    'cursor-pointer text-[13px] text-[#1A1A1A] transition-colors hover:text-[#ED4259]'
  return (
    <>
      <button onClick={() => navigate({ name: 'category' })} className={link}>
        全部分类
      </button>
      {categories.map((c) => (
        <button key={c.id} onClick={() => navigate({ name: 'category', categoryId: c.id })} className={link}>
          {c.name}小说
        </button>
      ))}
      <button
        onClick={() => navigate({ name: 'category' })}
        title="进入书库勾选「只看全本」"
        className={link}
      >
        完本小说大全
      </button>
      <button onClick={() => navigate({ name: 'home' })} className={link}>
        {siteName}
      </button>
    </>
  )
}

/**
 * 首页：精选双列卡(700) + 热门 aside(250)
 * → 6 个 3 列分类版块 → 最新章节长列表(700) + 最近更新 aside(250) → 友情链接
 */
export default function Home({ navigate, siteName, notice }: ViewProps) {
  const { data, isLoading, isError, refetch } = useHomeData()

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  const featured = data?.featured?.length ? data.featured.slice(0, 8) : (data?.hot ?? []).slice(0, 8)
  const hotSide = data?.hot?.length ? data.hot.slice(0, 12) : (data?.rankings?.clicks ?? []).slice(0, 12)
  const latest = data?.latest ?? []
  const updatesSide = data?.rankings?.updates ?? []
  const cats = (data?.categories ?? []).slice(0, 6)

  return (
    <div className="mx-auto w-full max-w-[960px] px-2 pb-6 pt-[10px]">
      <div className="space-y-[10px]">
        {notice && <NoticeBar notice={notice} />}

        {/* 区块一：精选推荐 700 + 右侧热门 250 */}
        <div className="flex items-start gap-[10px]">
          <section className="min-w-0 flex-1 bg-white">
            <SectionTitle
              icon={<Flame size={16} />}
              title="精选推荐"
              extra={<MoreLink onClick={() => navigate({ name: 'category' })} />}
            />
            {isLoading ? (
              <CardListSkeleton count={4} />
            ) : featured.length === 0 ? (
              <Empty text="暂无精选小说" />
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-5 px-4 py-4 max-[639px]:grid-cols-1">
                {featured.map((n) => (
                  <BookCard key={n.id} novel={n} navigate={navigate} />
                ))}
              </div>
            )}
          </section>
          <aside className="w-[250px] shrink-0 max-[767px]:hidden">
            <div className="bg-white">
              <SectionTitle icon={<Flame size={14} />} title="热门小说" />
              {isLoading ? <RowsSkeleton rows={6} /> : <TextRankAside novels={hotSide} navigate={navigate} />}
            </div>
          </aside>
        </div>

        {/* 区块二：6 个分类小版块，一行 3 块 */}
        <div className="grid grid-cols-3 gap-[10px] max-[959px]:grid-cols-2 max-[639px]:grid-cols-1">
          {cats.map((c) => (
            <CategorySection key={c.id} category={c} navigate={navigate} />
          ))}
          {isLoading &&
            Array.from({ length: Math.max(0, 6 - cats.length) }).map((_, i) => (
              <div key={`sk-${i}`} className="bg-white p-3">
                <Bar className="h-[16px] w-1/3" />
                <Bar className="mt-3 h-[80px]" />
                <Bar className="mt-2 h-[120px]" />
              </div>
            ))}
        </div>

        {/* 区块三：最新章节长列表 700 + 右侧最近更新 250 */}
        <div className="flex items-start gap-[10px]">
          <section className="min-w-0 flex-1 bg-white">
            <SectionTitle
              icon={<Clock3 size={16} />}
              title="最新章节"
              extra={<MoreLink onClick={() => navigate({ name: 'home' })} />}
            />
            {isLoading ? (
              <RowsSkeleton rows={10} />
            ) : latest.length === 0 ? (
              <Empty text="暂无更新" />
            ) : (
              latest.slice(0, 30).map((n) => (
                <div
                  key={n.id}
                  className="group flex h-[41px] cursor-pointer items-center gap-2 border-b border-dotted border-[#E6E6E6] px-3 text-[13px] last:border-b-0"
                  onClick={() => navigate({ name: 'book', novelId: n.id })}
                >
                  <span className="w-[9%] min-w-[44px] shrink-0 truncate text-[12px] text-[#BF2C24]">
                    {n.categoryName}
                  </span>
                  <span className="w-[25%] shrink-0 truncate font-medium text-[#1A1A1A] transition-colors group-hover:text-[#ED4259]">
                    {n.title}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[#666] transition-colors group-hover:text-[#ED4259]">
                    {n.lastChapterTitle ?? '暂无章节'}
                  </span>
                  <span className="w-[25%] shrink-0 truncate text-right text-[12px] text-[#969BA3] max-[639px]:hidden">
                    {n.author} · {fmtDateShort(n.updatedAt)}
                  </span>
                </div>
              ))
            )}
          </section>
          <aside className="w-[250px] shrink-0 max-[767px]:hidden">
            <div className="bg-white">
              <SectionTitle icon={<Clock3 size={14} />} title="最近更新" />
              {isLoading ? (
                <RowsSkeleton rows={6} />
              ) : (
                <TextRankAside novels={updatesSide.slice(0, 30)} navigate={navigate} />
              )}
            </div>
          </aside>
        </div>

        {/* 区块三.5：后台可配置的首页自定义图文区块（无配置时渲染 null） */}
        <HomeCustomBlocks navigate={navigate} />

        {/* 区块四：友情链接 */}
        <section className="bg-white">
          <SectionTitle icon={<LayoutGrid size={16} />} title="友情链接" />
          <div className="flex flex-wrap gap-x-5 gap-y-2 px-4 pb-4 pt-1">
            <FriendLinks categories={cats} navigate={navigate} siteName={siteName} />
          </div>
          <div className="flex items-center gap-1.5 border-t border-[#F0F0F0] px-4 py-2 text-[11px] text-[#C0C4CC]">
            <Link2 size={11} />
            本站为结构级主题演示模板，友链区展示分类导航
          </div>
        </section>
      </div>
    </div>
  )
}
