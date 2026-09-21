'use client'

import { useHomeData, useNovels } from '@/hooks/use-novel-data'
import { cn } from '@/lib/utils'
import type { CategoryDto } from '@/lib/types'
import type { ThemeView, ViewProps } from '../types'
import {
  Cover,
  CoverItem,
  ErrBlock,
  SimpleRow,
  Sk,
  SkRows,
  TableHead,
  UpdateRow,
  catLabel,
} from './parts'

export default function Home({ navigate, siteName }: ViewProps) {
  const home = useHomeData()

  if (home.isPending) return <HomeSkeleton />
  if (home.isError || !home.data) {
    return <ErrBlock msg={home.error instanceof Error ? home.error.message : ''} onRetry={() => home.refetch()} />
  }

  const d = home.data

  return (
    <div>
      {/* ① 强推区：左 2×2 封面卡 + 右「上期强推」列表 */}
      <section className="mt-1 flex flex-col gap-2 lg:flex-row">
        <div className="dd-box lg:w-[695px]">
          <div className="dd-box-title bg-[#e1eced]">本周强推</div>
          <div className="grid gap-3 p-[10px] sm:grid-cols-2">
            {d.featured.slice(0, 4).map((n) => (
              <CoverItem key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
        </div>
        <div className="dd-box min-w-0 flex-1">
          <div className="dd-box-title bg-[#e1eced]">上期强推</div>
          <div className="px-2 py-1">
            {d.hot.slice(0, 8).map((n) => (
              <SimpleRow key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
        </div>
      </section>

      {/* ② 分类导流区：每行 3 列分类专栏 */}
      <CategoryBlocks categories={d.categories} navigate={navigate} />

      {/* ③ 最近更新区：左表格式更新列表 + 右最新入库 */}
      <section className="mt-2 flex flex-col gap-2 lg:flex-row">
        <div className="dd-box dd-box-strong min-w-0 lg:w-[695px]">
          <div className="dd-box-title bg-[#a6d3e8]">最近更新小说列表</div>
          <div className="bg-[#e1eced] px-2 py-1.5">
            <TableHead />
            {d.rankings.updates.slice(0, 25).map((n) => (
              <UpdateRow key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
        </div>
        <div className="dd-box dd-box-strong min-w-0 flex-1">
          <div className="dd-box-title bg-[#a6d3e8]">最新入库小说</div>
          <div className="bg-[#e1eced] px-2 py-1.5">
            {d.latest.slice(0, 30).map((n) => (
              <SimpleRow key={n.id} novel={n} navigate={navigate} showDate />
            ))}
          </div>
        </div>
      </section>

      {/* ④ 友情链接 */}
      <section className="mt-2 border border-[#ddd] bg-white px-3 py-2 text-[13px]">
        <span className="mr-2 font-bold text-[#333]">友情链接：</span>
        <button className="mr-3 text-[#548161] hover:underline" onClick={() => navigate({ name: 'home' })}>
          {siteName}
        </button>
        {(d.categories ?? []).slice(0, 8).map((c) => (
          <button
            key={c.id}
            className="mr-3 text-[#548161] hover:underline"
            onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
          >
            {catLabel(c.name)}
          </button>
        ))}
      </section>
    </div>
  )
}

/* ==================== 分类导流块 ==================== */

function CategoryBlocks({
  categories,
  navigate,
}: {
  categories: CategoryDto[]
  navigate: (v: ThemeView) => void
}) {
  const groups: CategoryDto[][] = []
  for (let i = 0; i < categories.length; i += 3) groups.push(categories.slice(i, i + 3))
  return (
    <>
      {groups.map((g, gi) => (
        <section key={gi} className="dd-box dd-box-mid mt-2">
          <div className="flex flex-col lg:flex-row">
            {g.map((c, ci) => (
              <div
                key={c.id}
                className={cn('min-w-0 flex-1', ci > 0 && 'lg:border-l lg:border-dotted lg:border-[#9db4c0]')}
              >
                <CategoryColumn cat={c} navigate={navigate} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function CategoryColumn({ cat, navigate }: { cat: CategoryDto; navigate: (v: ThemeView) => void }) {
  const q = useNovels({ categoryId: cat.id, pageSize: 13, sort: 'latest' })
  const list = q.data?.list ?? []
  const lead = list[0]
  const rest = list.slice(1, 13)
  return (
    <div className="flex h-full flex-col">
      <div className="dd-box-title flex items-center justify-between bg-[#f6f8fe]">
        <button
          className="dd-link truncate text-[14px] font-bold"
          onClick={() => navigate({ name: 'category', categoryId: cat.id, page: 1 })}
        >
          {catLabel(cat.name)}
        </button>
        <button
          className="dd-greenlink flex-none text-[12px]"
          onClick={() => navigate({ name: 'category', categoryId: cat.id, page: 1 })}
        >
          更多&gt;&gt;
        </button>
      </div>
      <div className="p-2">
        {q.isPending ? (
          <SkRows rows={7} />
        ) : q.isError ? (
          <p className="dd-hottext py-3 text-center text-[12px]">该分类数据加载失败</p>
        ) : (
          <>
            {lead && (
              <div
                className="flex cursor-pointer gap-2 border-b border-dashed border-[#ccc] pb-2"
                onClick={() => navigate({ name: 'book', novelId: lead.id })}
              >
                <Cover novel={lead} className="h-[82px] w-[67px]" charClass="text-[18px]" />
                <div className="min-w-0 flex-1">
                  <p className="dd-link truncate text-[13px] font-bold text-[#333]">{lead.title}</p>
                  <p className="mt-0.5 line-clamp-3 overflow-hidden text-[12px] leading-[19px] text-[#777]">
                    {lead.description}
                  </p>
                </div>
              </div>
            )}
            <div className="mt-1 grid grid-cols-2 gap-x-2">
              {rest.map((n) => (
                <div
                  key={n.id}
                  className="dd-row25 flex cursor-pointer items-center gap-1 px-0.5 transition-colors hover:bg-white"
                  onClick={() => navigate({ name: 'book', novelId: n.id })}
                >
                  <span className="dd-link min-w-0 flex-1 truncate">{n.title}</span>
                  <span className="w-[42px] flex-none truncate text-right text-[#b3b3b3]">{n.author}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ==================== 骨架屏 ==================== */

function HomeSkeleton() {
  return (
    <div>
      <div className="mt-1 flex flex-col gap-2 lg:flex-row">
        <div className="dd-box lg:w-[695px]">
          <div className="dd-box-title bg-[#e1eced]">本周强推</div>
          <div className="p-[10px]">
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex gap-2.5">
                  <Sk className="h-[150px] w-[120px] flex-none" />
                  <div className="min-w-0 flex-1 space-y-2 pt-1">
                    <Sk className="h-[18px] w-3/4" />
                    <Sk className="h-[14px] w-1/2" />
                    <Sk className="h-[80px] w-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="dd-box min-w-0 flex-1">
          <div className="dd-box-title bg-[#e1eced]">上期强推</div>
          <div className="p-2">
            <SkRows rows={8} />
          </div>
        </div>
      </div>
      <div className="dd-box dd-box-mid mt-2">
        <div className="dd-box-title bg-[#f6f8fe]">分类书库</div>
        <div className="p-2">
          <SkRows rows={8} />
        </div>
      </div>
      <div className="dd-box dd-box-strong mt-2">
        <div className="dd-box-title bg-[#a6d3e8]">最近更新小说列表</div>
        <div className="p-2">
          <SkRows rows={12} />
        </div>
      </div>
    </div>
  )
}
