'use client'

/**
 * 主题共享图文区块组件（风格中立，适配全部 10 套主题）。
 *
 * - CategoryFeaturedBlock：分类页「图文推荐」区块 —— 精选优先，横向大图卡；
 * - CategoryHotBlock：分类页「热门书籍」图文区块 —— 点击榜网格小卡；
 * - HomeCustomBlocks：首页自定义图文区块 —— 渲染 SiteSetting.home.blocks（后台可配）。
 *
 * 数据全部来自 /api/novels（useNovels），无数据时整块渲染 null（不占版面）。
 * 点击卡片统一走 navigate({name:'book'})，与主题内链接语义一致。
 */
import { LayoutGrid, TrendingUp, Sparkles } from 'lucide-react'
import { useNovels, useSettings } from '@/hooks/use-novel-data'
import type { NovelListItem } from '@/lib/types'
import type { HomeBlockConfig } from '@/lib/types'
import type { ThemeView } from '@/themes/types'
import { coverBgClass } from '@/lib/covers'
import { isLocalCover, NovelCoverImg } from '@/components/novel-cover'
import { cn } from '@/lib/utils'

type Navigate = (view: ThemeView) => void

function formatCount(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
}

/** 区块标题条：图标 + 标题 + 左侧竖向装饰条 */
function BlockHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2 border-l-4 border-neutral-800 pl-2.5">
      <span className="text-neutral-700">{icon}</span>
      <h2 className="text-base font-bold tracking-wide text-neutral-900">{title}</h2>
    </div>
  )
}

/** 封面块：渐变/本地图双形态 + 书名首字兜底（与各主题封面约定一致） */
function CoverBox({ novel, className }: { novel: NovelListItem; className?: string }) {
  return (
    <div className={cn('relative shrink-0 overflow-hidden rounded-lg', coverBgClass(novel.cover), className)}>
      <NovelCoverImg novel={novel} />
      {!isLocalCover(novel.cover) && (
        <span className="absolute inset-0 flex items-center justify-center text-2xl font-bold text-white/90">
          {novel.title.slice(0, 1)}
        </span>
      )}
    </div>
  )
}

/** 横向图文卡：左封面右文字（推荐区块用） */
function NovelFigureCard({ novel, navigate }: { novel: NovelListItem; navigate: Navigate }) {
  return (
    <button
      type="button"
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
      className="group flex gap-3 rounded-xl border border-neutral-200 bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-neutral-400 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
    >
      <CoverBox novel={novel} className="h-28 w-20" />
      <div className="min-w-0 flex-1 py-0.5">
        <h3 className="truncate text-sm font-semibold text-neutral-900 group-hover:underline">{novel.title}</h3>
        <p className="mt-0.5 truncate text-xs text-neutral-500">{novel.author} · {novel.categoryName}</p>
        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-neutral-600">
          {novel.description || '暂无简介'}
        </p>
        <p className="mt-1.5 text-[11px] text-neutral-400">
          {novel.chapterCount}章 · {formatCount(novel.clicks)}点击
        </p>
      </div>
    </button>
  )
}

/** 网格图文卡：上封面下标题（热门区块/自定义区块用） */
function NovelGridCard({ novel, navigate }: { novel: NovelListItem; navigate: Navigate }) {
  return (
    <button
      type="button"
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
      className="group flex flex-col rounded-xl border border-neutral-200 bg-white p-2 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-neutral-400 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
    >
      <CoverBox novel={novel} className="aspect-[3/4] w-full" />
      <h3 className="mt-2 truncate text-xs font-semibold text-neutral-900 group-hover:underline">{novel.title}</h3>
      <p className="truncate text-[11px] text-neutral-500">{novel.author}</p>
    </button>
  )
}

/** 区块数据 hook 的公共入参 → useNovels 参数 */
function sourceToParams(block: HomeBlockConfig) {
  const m = /^cat:(\d+)$/.exec(block.source)
  if (m) return { categoryId: Number(m[1]), sort: 'latest' as const }
  if (block.source === 'hot') return { sort: 'clicks' as const }
  if (block.source === 'featured') return { sort: 'featured' as const }
  return { sort: 'latest' as const }
}

/** 单个自定义区块（独立组件保证 hooks 顺序稳定） */
function HomeCustomBlock({ block, navigate }: { block: HomeBlockConfig; navigate: Navigate }) {
  const { data } = useNovels({ ...sourceToParams(block), pageSize: block.count })
  const list = data?.list ?? []
  if (list.length === 0) return null
  return (
    <section className="mb-8" aria-label={block.title}>
      <BlockHeader icon={<LayoutGrid className="h-4 w-4" />} title={block.title} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {list.slice(0, block.count).map((n) => (
          <NovelGridCard key={n.id} novel={n} navigate={navigate} />
        ))}
      </div>
    </section>
  )
}

/**
 * 首页自定义图文区块：读 SiteSetting.home.blocks 按配置顺序渲染。
 * 未配置任何区块时渲染 null（各主题首页零侵入）。
 */
export function HomeCustomBlocks({ navigate }: { navigate: Navigate }) {
  const { data: settings } = useSettings()
  const blocks = settings?.home?.blocks ?? []
  if (blocks.length === 0) return null
  return (
    <div className="mx-auto w-full max-w-6xl px-4">
      {blocks.map((b) => (
        <HomeCustomBlock key={b.id} block={b} navigate={navigate} />
      ))}
    </div>
  )
}

/**
 * 分类页「图文推荐」区块：精选优先（isFeatured desc → updatedAt desc），无精选书时自然回落为最新。
 * 取 3 本横向大卡；分类无书时渲染 null。
 */
export function CategoryFeaturedBlock({
  navigate,
  categoryId,
}: {
  navigate: Navigate
  categoryId?: number
}) {
  const { data } = useNovels({
    categoryId,
    sort: 'featured',
    pageSize: 3,
    enabled: categoryId != null && categoryId > 0,
  })
  const list = data?.list ?? []
  if (list.length === 0) return null
  return (
    <section className="mb-6" aria-label="图文推荐">
      <BlockHeader icon={<Sparkles className="h-4 w-4" />} title="图文推荐" />
      <div className="grid gap-3 md:grid-cols-3">
        {list.map((n) => (
          <NovelFigureCard key={n.id} novel={n} navigate={navigate} />
        ))}
      </div>
    </section>
  )
}

/**
 * 分类页「热门书籍」图文区块：点击榜 top 8 网格；分类无书时渲染 null。
 */
export function CategoryHotBlock({
  navigate,
  categoryId,
}: {
  navigate: Navigate
  categoryId?: number
}) {
  const { data } = useNovels({
    categoryId,
    sort: 'clicks',
    pageSize: 8,
    enabled: categoryId != null && categoryId > 0,
  })
  const list = data?.list ?? []
  if (list.length === 0) return null
  return (
    <section className="mb-6" aria-label="热门书籍">
      <BlockHeader icon={<TrendingUp className="h-4 w-4" />} title="热门书籍" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {list.slice(0, 8).map((n) => (
          <NovelGridCard key={n.id} novel={n} navigate={navigate} />
        ))}
      </div>
    </section>
  )
}
