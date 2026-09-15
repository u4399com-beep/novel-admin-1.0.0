'use client'

import { useHomeData } from '@/hooks/use-novel-data'
import type { CategoryDto, NovelListItem } from '@/lib/types'
import type { ViewProps } from '../types'
import { Block, Cover, ErrorBox, RankList, RowsSkeleton, XLink } from './parts'

/* 排行榜封面横条：每格 135px（120×150 封面 5px 内衬 + 居中书名），横向滚动 */
function Board({
  novels,
  navigate,
  isLoading,
}: {
  novels: NovelListItem[]
  navigate: ViewProps['navigate']
  isLoading: boolean
}) {
  return (
    <Block
      title="排行榜"
      titleH={30}
      right={
        <span className="flex items-center gap-1 pr-2">
          <span className="size-[10px] border border-[#FF3300] bg-[#FFC993]" />
          <span className="size-[10px] border border-[#CCC] bg-[#EEE]" />
          <span className="size-[10px] border border-[#CCC] bg-[#EEE]" />
        </span>
      }
    >
      {isLoading ? (
        <div className="flex gap-2 overflow-hidden p-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-[190px] w-[132px] shrink-0 animate-pulse bg-[#EFEFEF]" />
          ))}
        </div>
      ) : novels.length === 0 ? (
        <p className="py-10 text-center text-[12px] text-[#999]">暂无上榜小说</p>
      ) : (
        <div className="flex h-[231px] overflow-x-auto px-1 pt-2">
          {novels.map((n) => (
            <div
              key={n.id}
              className="w-[135px] shrink-0 cursor-pointer text-center"
              onClick={() => navigate({ name: 'book', novelId: n.id })}
            >
              <div className="mx-auto w-[132px] border border-[#E4E4E4] p-[5px]">
                <Cover novel={n} charClass="text-3xl" className="h-[150px] w-[120px]" />
              </div>
              <div className="mt-1 w-[120px] truncate px-0 mx-auto">
                <XLink onClick={() => navigate({ name: 'book', novelId: n.id })}>{n.title}</XLink>
              </div>
            </div>
          ))}
        </div>
      )}
    </Block>
  )
}

/* 友情链接：左竖排标签 70px + inline 链接行流 */
function Links({
  categories,
  navigate,
}: {
  categories: CategoryDto[]
  navigate: ViewProps['navigate']
}) {
  return (
    <div className="mt-2 flex border border-[#E4E4E4] bg-white">
      <div
        className="flex w-[70px] shrink-0 items-center justify-center border-r border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] text-[12px] font-bold text-[#333]"
        style={{ writingMode: 'vertical-rl', letterSpacing: 6 }}
      >
        友情链接
      </div>
      <div className="flex-1 px-3 py-2 leading-[22px]">
        {categories.map((c) => (
          <XLink
            key={c.id}
            onClick={() => navigate({ name: 'category', categoryId: c.id })}
            className="mr-3"
          >
            {c.name}小说
          </XLink>
        ))}
        <XLink onClick={() => navigate({ name: 'category' })} className="mr-3">
          全部分类
        </XLink>
        <XLink onClick={() => navigate({ name: 'category' })} title="进入全部分类列表">
          完本列表
        </XLink>
      </div>
    </div>
  )
}

/**
 * 首页：公告条（Layout 内）→ 封面排行榜横条 263px
 * → 内容 760（最近更新长列表）+ 右榜 190（总推荐榜 / 最新小说）→ 友情链接
 */
export default function Home({ navigate }: ViewProps) {
  const { data, isLoading, isError, refetch } = useHomeData()

  if (isError) {
    return (
      <div className="mt-2">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  const board = data?.hot?.length ? data.hot : (data?.rankings?.clicks ?? [])
  const latest = data?.latest ?? []
  const recRank = data?.rankings?.clicks ?? []
  const newRank = data?.rankings?.updates ?? []
  const cats = data?.categories ?? []

  return (
    <div className="pb-1">
      <div className="mt-2">
        <Board novels={board} navigate={navigate} isLoading={isLoading} />
      </div>

      <div className="mt-2 flex items-start justify-between">
        {/* 左：最近更新 760 长列表 */}
        <div className="w-[760px] shrink-0">
          <Block
            title="最近更新"
            titleH={40}
            right={
              <XLink onClick={() => navigate({ name: 'category' })} className="mr-2 text-[11px]">
                更多…
              </XLink>
            }
          >
            {isLoading ? (
              <RowsSkeleton rows={12} />
            ) : latest.length === 0 ? (
              <p className="py-10 text-center text-[12px] text-[#999]">暂无更新</p>
            ) : (
              <ul className="px-1 py-1">
                {latest.slice(0, 35).map((n) => (
                  <li
                    key={n.id}
                    className="flex h-[30px] items-center border-b border-dotted border-[#F2F2F2] text-[12px] last:border-b-0"
                  >
                    <span className="w-[250px] shrink-0 truncate pl-1">
                      <span className="text-[#999]">[{n.categoryName}]</span>{' '}
                      <XLink onClick={() => navigate({ name: 'book', novelId: n.id })}>《{n.title}》</XLink>
                    </span>
                    <span className="w-[340px] shrink-0 truncate">
                      <XLink onClick={() => navigate({ name: 'book', novelId: n.id })}>
                        {n.lastChapterTitle ?? '暂无章节'}
                      </XLink>
                    </span>
                    <span className="min-w-0 flex-1 truncate pr-1 text-right text-[#999]">
                      {n.author}
                      <span className="ml-2">{n.updatedAt?.slice(5, 10) ?? '—'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        </div>

        {/* 右：总推荐榜 + 最新小说 190 */}
        <div className="w-[190px] shrink-0 space-y-2">
          <Block
            title="总推荐榜"
            titleH={26}
            right={
              <XLink onClick={() => navigate({ name: 'category' })} className="mr-1 text-[11px]">
                更多…
              </XLink>
            }
          >
            {isLoading ? (
              <RowsSkeleton rows={8} />
            ) : (
              <RankList novels={recRank} navigate={navigate} mode="count" rows={15} />
            )}
          </Block>
          <Block
            title="最新小说"
            titleH={26}
            right={
              <XLink onClick={() => navigate({ name: 'category' })} className="mr-1 text-[11px]">
                更多…
              </XLink>
            }
          >
            {isLoading ? (
              <RowsSkeleton rows={8} />
            ) : (
              <RankList novels={newRank} navigate={navigate} mode="date" rows={20} />
            )}
          </Block>
        </div>
      </div>

      <Links categories={cats} navigate={navigate} />
    </div>
  )
}
