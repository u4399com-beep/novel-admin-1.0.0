'use client'

import { useNovels } from '@/hooks/use-novel-data'
import type { ViewProps } from '../types'
import { Block, RankList, RowsSkeleton, XLink } from './parts'

const RANK_ENTRIES = [
  '总排行',
  '月排行',
  '周排行',
  '总推荐',
  '月推荐',
  '周推荐',
  '最新入库',
  '最近更新',
  '收藏榜',
  '字数排行',
  '完本列表',
  '连载列表',
]

/** 列表/详情页左侧 190px 侧栏：会员推荐（点击榜） + 排行榜入口（2 列链接格） */
export default function Sidebar({ navigate }: { navigate: ViewProps['navigate'] }) {
  const { data, isLoading } = useNovels({ sort: 'clicks', page: 1, pageSize: 15 })

  return (
    <div className="w-[190px] shrink-0 space-y-2">
      <Block title="会员推荐" titleH={26}>
        {isLoading ? (
          <RowsSkeleton rows={8} />
        ) : (
          <RankList novels={data?.list ?? []} navigate={navigate} mode="count" rows={15} />
        )}
      </Block>
      <Block title="排行榜" titleH={26}>
        <ul className="grid grid-cols-2 px-2 py-1">
          {RANK_ENTRIES.map((e) => (
            <li
              key={e}
              className="flex h-[25px] items-center justify-center border-b border-dotted border-[#F2F2F2] text-[12px] last:border-b-0"
            >
              <XLink onClick={() => navigate({ name: 'category' })} title="进入全部分类列表">
                {e}
              </XLink>
            </li>
          ))}
        </ul>
      </Block>
    </div>
  )
}
