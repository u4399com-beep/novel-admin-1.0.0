'use client'

import { useState } from 'react'
import { useHomeData, useNovels } from '@/hooks/use-novel-data'
import { HomeCustomBlocks } from '@/components/theme-extras'
import { gradientClass } from '@/lib/covers'
import { cn } from '@/lib/utils'
import type { CategoryDto, HomeData, NovelListItem } from '@/lib/types'
import type { ThemeView, ViewProps } from '../types'
import {
  AuthorCloud,
  collectAuthors,
  Cover,
  CoverCard,
  ErrBlock,
  fmtNum,
  fmtWords,
  NovelTextRow,
  Panel,
  RankList,
  Sk,
  SkRows,
  avatarGradient,
} from './parts'

export default function Home({ navigate }: ViewProps) {
  const home = useHomeData()

  if (home.isPending) return <HomeSkeleton />
  if (home.isError || !home.data) {
    return <ErrBlock msg={home.error instanceof Error ? home.error.message : ''} onRetry={() => home.refetch()} />
  }

  const d = home.data
  const authors = collectAuthors([d.hot, d.rankings.clicks, d.latest], 24)

  return (
    <div>
      {/* 左主栏 + 右 330px sticky 侧栏 */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0 space-y-4">
          <LatestPanel novels={d.latest} navigate={navigate} />
          <FeaturedPanel novels={d.featured} navigate={navigate} />
          {/* 后台可配置的首页自定义图文区块：置于「小说分类」板块上方（无配置时渲染 null） */}
          <HomeCustomBlocks navigate={navigate} />
          <CategoryGroupsPanel categories={d.categories} navigate={navigate} />
          <TopicPanel novels={d.rankings.finished} navigate={navigate} />
        </div>
        <aside className="min-w-0 space-y-4 self-start lg:sticky lg:top-[70px]">
          <AuthorCard authors={authors.slice(0, 5)} navigate={navigate} />
          <Panel title="24小时热榜" cream bodyClassName="p-3">
            <HotTop novel={d.hot[0]} navigate={navigate} />
            <RankList novels={d.hot} navigate={navigate} limit={10} />
          </Panel>
          <Panel title="一周热榜" bodyClassName="p-3">
            {/* 源站两个热榜均带封面首卡（榜单第 1 名展示封面+简介） */}
            <HotTop novel={d.rankings.clicks[0]} navigate={navigate} />
            <RankList novels={d.rankings.clicks} navigate={navigate} limit={10} />
          </Panel>
          <Panel title="热门作者" bodyClassName="p-3">
            <AuthorCloud authors={authors} navigate={navigate} />
          </Panel>
        </aside>
      </div>
      <StatsHero stats={d.stats} />
    </div>
  )
}

/* ==================== 最新上传（两列文字行 + 展示更多） ==================== */

function LatestPanel({ novels, navigate }: { novels: NovelListItem[]; navigate: (v: ThemeView) => void }) {
  const [shown, setShown] = useState(16)
  const visible = novels.slice(0, shown)
  return (
    <Panel title="最新上传" extra={<span className="text-xs text-[#9ca3af]">每日实时更新</span>}>
      <div className="grid gap-x-8 sm:grid-cols-2">
        {visible.map((n) => (
          <NovelTextRow key={n.id} novel={n} navigate={navigate} />
        ))}
      </div>
      {shown < novels.length && (
        <div className="mt-3 text-center">
          <button onClick={() => setShown((s) => s + 10)} className="aj-pager-btn">
            展示更多 ↓
          </button>
        </div>
      )}
    </Panel>
  )
}

/* ==================== 封面推荐（grid2 封面卡） ==================== */

function FeaturedPanel({ novels, navigate }: { novels: NovelListItem[]; navigate: (v: ThemeView) => void }) {
  const list = novels.slice(0, 6)
  if (list.length === 0) return null
  return (
    <Panel title="封面推荐" extra={<span className="text-xs text-[#b45309]">编推精选</span>}>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {list.map((n) => (
          <CoverCard key={n.id} novel={n} navigate={navigate} />
        ))}
      </div>
    </Panel>
  )
}

/* ==================== 小说分类（每列 = 浅青渐变标题 + 更多胶囊 + 10 行） ==================== */

function CategoryGroupsPanel({
  categories,
  navigate,
}: {
  categories: CategoryDto[]
  navigate: (v: ThemeView) => void
}) {
  const groups: CategoryDto[][] = []
  for (let i = 0; i < categories.length; i += 2) groups.push(categories.slice(i, i + 2))
  return (
    <Panel title="小说分类" bodyClassName="p-3 sm:p-4">
      <div className="space-y-6">
        {groups.map((g, gi) => (
          <div key={gi} className="grid gap-x-8 sm:grid-cols-2">
            {g.map((c) => (
              <CategoryColumn key={c.id} cat={c} navigate={navigate} />
            ))}
          </div>
        ))}
      </div>
    </Panel>
  )
}

function CategoryColumn({ cat, navigate }: { cat: CategoryDto; navigate: (v: ThemeView) => void }) {
  const q = useNovels({ categoryId: cat.id, pageSize: 10, sort: 'latest' })
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between border-b border-[#e5dccd] pb-2">
        <button
          onClick={() => navigate({ name: 'category', categoryId: cat.id, page: 1 })}
          className="flex min-w-0 items-center gap-2 text-[15px] font-bold text-[#0f766e] transition-colors hover:text-[#115e59] hover:underline"
        >
          <span className="h-[14px] w-[4px] flex-none rounded bg-gradient-to-b from-[#0f766e] to-[#b45309]" aria-hidden />
          <span className="truncate">{cat.name}</span>
        </button>
        <button
          onClick={() => navigate({ name: 'category', categoryId: cat.id, page: 1 })}
          className="flex-none rounded-full border border-[#0f766e]/40 px-2.5 py-1 text-xs text-[#0f766e] transition-colors hover:bg-[#0f766e] hover:text-white"
        >
          更多&gt;&gt;
        </button>
      </div>
      {q.isPending ? (
        <SkRows rows={5} className="mt-2" />
      ) : q.isError ? (
        <p className="py-3 text-center text-xs text-[#9ca3af]">分类数据加载失败</p>
      ) : (
        (q.data?.list ?? []).map((n) => (
          <NovelTextRow key={n.id} novel={n} navigate={navigate} showChip={false} showDate={false} />
        ))
      )}
    </div>
  )
}

/* ==================== 专题书单（grid3 纯文字简介卡） ==================== */

function TopicPanel({ novels, navigate }: { novels: NovelListItem[]; navigate: (v: ThemeView) => void }) {
  const picks = novels.slice(0, 6)
  if (picks.length === 0) return null
  return (
    <Panel title="专题书单 · 完结精选" extra={<span className="text-xs text-[#b45309]">全部已完结</span>}>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
        {picks.map((n) => (
          <article
            key={n.id}
            className="cursor-pointer rounded-[10px] border border-[#e5dccd] bg-[#fbf7ee] p-3 transition-all hover:-translate-y-0.5 hover:border-[#b45309]/50 hover:shadow-md"
            onClick={() => navigate({ name: 'book', novelId: n.id })}
          >
            <h3 className="flex items-center gap-1.5 text-[14px] font-bold text-[#1f3f3a]">
              <span className="aj-badge">荐</span>
              <span className="min-w-0 truncate">{n.title}</span>
            </h3>
            <p className="mt-1 truncate text-xs text-[#9ca3af]">
              {n.author} · {fmtWords(n.wordCount)}
            </p>
            <p className="mt-1.5 line-clamp-2 text-[13px] leading-[1.65] text-[#6b7280]">{n.description}</p>
          </article>
        ))}
      </div>
    </Panel>
  )
}

/* ==================== 侧栏：人气作者头像卡 ==================== */

function AuthorCard({ authors, navigate }: { authors: string[]; navigate: (v: ThemeView) => void }) {
  if (authors.length === 0) return null
  return (
    <Panel title="人气作者" extra={<span className="aj-chip">今日已签到</span>} bodyClassName="p-4">
      <div className="grid grid-cols-5 gap-2">
        {authors.map((a, i) => (
          <button key={a} onClick={() => navigate({ name: 'search', query: a })} className="group flex flex-col items-center gap-1.5">
            <span
              className={cn(
                'flex h-[46px] w-[46px] items-center justify-center rounded-full bg-gradient-to-br text-[16px] font-bold text-white shadow-sm transition-transform group-hover:scale-110',
                avatarGradient(i)
              )}
            >
              {a.slice(0, 1)}
            </span>
            <span className="w-full truncate text-center text-[11px] text-[#6b7280] group-hover:text-[#0f766e]">{a}</span>
          </button>
        ))}
      </div>
    </Panel>
  )
}

/* ==================== 侧栏：热榜首卡（带封面） ==================== */

function HotTop({ novel, navigate }: { novel?: NovelListItem; navigate: (v: ThemeView) => void }) {
  if (!novel) return null
  return (
    <div
      className="mb-2 flex cursor-pointer gap-3 rounded-[10px] bg-white/70 p-2 transition-shadow hover:shadow-md"
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
    >
      <Cover novel={novel} className="h-[86px] w-[64px]" rounded="rounded-[6px]" charClass="text-[20px]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-bold text-[#9a3412]">{novel.title}</p>
        <p className="mt-0.5 truncate text-xs text-[#6b7280]">
          {novel.author} · {fmtWords(novel.wordCount)}
        </p>
        <p className="mt-1 line-clamp-2 text-xs leading-[1.6] text-[#8a7a63]">{novel.description}</p>
      </div>
    </div>
  )
}

/* ==================== 数据统计 hero（青绿+琥珀渐变横幅 + 4 KPI 白卡） ==================== */

function StatsHero({ stats }: { stats: HomeData['stats'] }) {
  const items = [
    { label: '收录作品', value: `${fmtNum(stats.novelCount)} 部` },
    { label: '收录章节', value: `${fmtNum(stats.chapterCount)} 章` },
    { label: '总字数', value: fmtWords(stats.totalWordCount) },
    { label: '今日更新', value: `${fmtNum(stats.todayUpdates)} 章` },
  ]
  return (
    <section className="mt-4 overflow-hidden rounded-[14px] border border-[#e5dccd] bg-gradient-to-r from-[#0f766e]/10 via-[#fffdf8] to-[#b45309]/10 px-4 py-5 sm:px-6">
      <h2 className="text-[18px] font-bold text-[#1f3f3a]">
        <span className="border-b-4 border-[#b45309]/70 pb-1">站点数据一览</span>
      </h2>
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {items.map((it) => (
          <div key={it.label} className="rounded-[12px] border border-[#e5dccd] bg-white/90 px-4 py-3.5 text-center shadow-sm">
            <p className="text-[20px] font-bold tabular-nums text-[#0f766e] sm:text-[22px]">{it.value}</p>
            <p className="mt-1 text-xs text-[#6b7280]">{it.label}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ==================== 骨架屏 ==================== */

function HomeSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
      <div className="min-w-0 space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="aj-card p-4">
            <Sk className="mb-4 h-5 w-32" />
            <SkRows rows={i === 2 ? 4 : 6} />
          </div>
        ))}
      </div>
      <div className="min-w-0 space-y-4">
        <div className="aj-card p-4">
          <Sk className="mb-4 h-5 w-24" />
          <SkRows rows={8} />
        </div>
        <div className="aj-card p-4">
          <Sk className="mb-4 h-5 w-28" />
          <SkRows rows={6} />
        </div>
      </div>
    </div>
  )
}
