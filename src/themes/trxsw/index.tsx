'use client'

/**
 * trxsw（唐人小说网 trxsw.com / 葡萄模板风）—— 结构级主题模版（2026-09 回源实测校准）
 * 规格要点：葡萄系 980px 定宽；页眉工具条（#e1eced 底 #a6d3e8 边）+ Logo/搜索 +
 * 蓝底圆角主导航（.daohang #88c6e5, h40 r10）+ 黄底分类条（.nav1 #fff9d9 边 #fc3）；
 * 首页封面推荐横条 + 内容 760 + 侧栏 190 双栏（五段式更新表 / 总推荐榜·最新入库）
 * + 分类导航·双榜 + 友链；区块为圆角 10px 蓝框（2px #a6d3e8, 底 #f7fbfd）；
 * 分类页左 190 侧栏 + 右 760 六列数据表；目录页 4 列；正文页淡蓝底 #e9faff + 键盘翻章。
 * 链接色 #6f78a7 / 强调 #c42205（源站 .sys）/ 橙 #FF6600。
 */

import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  useCategories,
  useChapter,
  useChapters,
  useHomeData,
  useNovel,
  useNovels,
  useSettings,
} from '@/hooks/use-novel-data'
import { NovelTagsRow } from '@/components/novel-tags'
import { HistoryPanel } from '@/components/theme-tools/HistoryPanel'
import { useFavoriteSite } from '@/components/theme-tools/FavoriteSite'
import { TradToggle } from '@/components/theme-tools/TradToggle'
import {
  READER_INKS,
  READER_LINE_HEIGHTS,
  READER_SCENES,
  readerFontStack,
  readerInk,
  resetReaderPrefs,
  setReaderPrefs,
  stepFontSize,
  useReaderPrefs,
  type ReaderSceneColors,
} from '@/hooks/use-reader-prefs'
import type { ChapterDetail } from '@/lib/types'
import { CategoryFeaturedBlock, CategoryHotBlock, HomeCustomBlocks } from '@/components/theme-extras'
import type { ThemeLayoutProps, ThemeModule, ViewProps } from '../types'
import { useSearchField, type SearchField } from './search-field'
import {
  Block,
  BookRow,
  Cover,
  Crumbs,
  ErrorBox,
  RankRows,
  SkeletonBlock,
  SkeletonLines,
  UpdateRow,
  formatWords,
  fullDate,
  shortDate,
  statusText,
} from './ui'

/* ==================================================================== */
/* Layout：工具行 + Logo/搜索 + 渐变亮条导航 + 公告 + 页脚                */
/* ==================================================================== */

function Layout({ view, children, navigate, siteName, notice }: ThemeLayoutProps) {
  const { data: cats } = useCategories()
  const { data: settings } = useSettings()
  const footerCfg = settings?.footer
  const [kw, setKw] = useState('')
  const [histOpen, setHistOpen] = useState(false)
  const { promptFavorite, shortcut } = useFavoriteSite()

  /* 回车/搜书名/搜作者分别设置检索字段（源站杰奇双按钮语义：articlename / author） */
  const submitSearch = () => {
    const t = kw.trim()
    if (!t) return
    useSearchField.getState().setField('all')
    navigate({ name: 'search', query: t })
  }
  const submitSearchBy = (field: 'title' | 'author') => {
    const t = kw.trim()
    if (!t) return
    useSearchField.getState().setField(field)
    navigate({ name: 'search', query: t })
  }

  const activeCategoryId = view.name === 'category' ? view.categoryId : undefined

  const navLink = (active: boolean) =>
    cn(
      'flex shrink-0 cursor-pointer items-center border-r border-white/25 px-4 text-[13px] text-white transition-colors hover:bg-[#459df5]',
      active ? 'bg-[#459df5] font-bold' : '',
    )

  return (
    <div className="flex min-h-screen flex-col bg-[#e9faff] text-[#333]">
      {/* 右上工具行：源站 .headds（#e1eced 底 + #a6d3e8 底边） */}
      <div className="border-b border-[#a6d3e8] bg-[#e1eced]">
        <div className="mx-auto flex h-7 max-w-[980px] flex-wrap items-center justify-end gap-x-3 gap-y-1 px-3 py-0.5 text-[11px] text-[#999]">
          <button
            type="button"
            onClick={promptFavorite}
            title={`按 ${shortcut} 也可收藏本站`}
            className="cursor-pointer transition-colors hover:text-[#c42205]"
          >
            收藏本站（{shortcut}）
          </button>
          <span className="text-[#DDD]">|</span>
          <button
            type="button"
            onClick={() => setHistOpen(true)}
            title="查看最近阅读过的章节"
            className="cursor-pointer transition-colors hover:text-[#c42205]"
          >
            阅读记录
          </button>
          <span className="text-[#DDD]">|</span>
          <TradToggle className="hover:text-[#c42205]" />
          <span className="hidden text-[#DDD] sm:inline">|</span>
          <span className="hidden sm:inline">简单 · 快速 · 纯净阅读</span>
        </div>
      </div>

      {/* Logo + 双按钮搜索 */}
      <header className="bg-white">
        <div className="mx-auto flex max-w-[980px] flex-wrap items-center gap-x-5 gap-y-3 px-3 py-3.5">
          <button
            type="button"
            onClick={() => navigate({ name: 'home' })}
            className="flex cursor-pointer select-none items-center gap-2 text-left"
          >
            <span className="flex h-11 w-11 items-center justify-center bg-[#c42205] text-xl font-black text-white">
              天
            </span>
            <span>
              <span className="block text-[22px] font-black leading-none tracking-wide text-[#c42205]">
                {siteName}
              </span>
              <span className="mt-1 block text-[10px] tracking-[0.3em] text-[#B0B0B0]">
                TRXSW · 杰奇经典风
              </span>
            </span>
          </button>
          <div className="ml-auto flex w-full items-center sm:w-auto">
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch()
              }}
              placeholder="输入书名或作者"
              className="h-8 w-full min-w-0 border border-[#a6d3e8] bg-[#e9faff] px-2 text-sm text-[#333] outline-none placeholder:text-[#C8C8C8] focus:border-[#459df5] sm:w-[240px]"
            />
            <button
              type="button"
              onClick={() => submitSearchBy('title')}
              title="按书名字段检索"
              className="h-8 shrink-0 cursor-pointer bg-[#c42205] px-3 text-xs text-white transition-colors hover:bg-[#a01c04]"
            >
              搜书名
            </button>
            <button
              type="button"
              onClick={() => submitSearchBy('author')}
              title="按作者字段检索"
              className="h-8 shrink-0 cursor-pointer border border-l-0 border-[#c42205] px-3 text-xs text-[#c42205] transition-colors hover:bg-[#FFF3F0]"
            >
              搜作者
            </button>
          </div>
        </div>
      </header>

      {/* 主导航：源站 .daohang（980 蓝底 #88c6e5 圆角 10px 条） */}
      <nav className="px-2">
        <div className="no-scrollbar mx-auto flex h-10 max-w-[980px] items-stretch overflow-x-auto rounded-[10px] bg-[#88c6e5] px-1">
          <button
            type="button"
            onClick={() => navigate({ name: 'home' })}
            className={cn(navLink(view.name === 'home'))}
          >
            首页
          </button>
          {(cats ?? []).slice(0, 9).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => navigate({ name: 'category', categoryId: c.id })}
              className={navLink(activeCategoryId === c.id)}
            >
              {c.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigate({ name: 'category' })}
            className={navLink(view.name === 'category' && activeCategoryId === undefined)}
          >
            全部小说
          </button>
        </div>
      </nav>

      {/* 次级分类条：源站 .nav1（黄底 #fff9d9 + 边 #fc3 圆角，分类一览） */}
      <div className="px-2">
        <div className="no-scrollbar mx-auto mt-2 flex h-[30px] max-w-[980px] items-center gap-x-4 overflow-x-auto rounded-[10px] border border-[#fc3] bg-[#fff9d9] px-3">
          {(cats ?? []).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => navigate({ name: 'category', categoryId: c.id })}
              className="shrink-0 cursor-pointer text-[12px] text-[#6f78a7] transition-colors hover:text-[#c42205]"
            >
              {c.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigate({ name: 'category' })}
            className="shrink-0 cursor-pointer text-[12px] font-bold text-[#6f78a7] transition-colors hover:text-[#c42205]"
          >
            全部分类
          </button>
        </div>
      </div>

      {/* 公告条 */}
      {notice ? (
        <div className="border-b border-[#F2E3CC] bg-[#FFF8EF]">
          <div className="mx-auto max-w-[980px] px-3 py-2 text-xs leading-5 text-[#8A6D3B]">
            <span className="mr-2 inline-block bg-[#FF6600] px-1.5 py-0.5 align-[1px] text-[10px] text-white">
              通知
            </span>
            {notice}
          </div>
        </div>
      ) : null}

      <main className="flex-1">{children}</main>

      {/* 页脚：网站地图分页链接 + 版权 */}
      <footer className="mt-8 border-t border-[#a6d3e8] bg-[#FAFAFA]">
        <div className="mx-auto max-w-[980px] px-3 py-6 text-center text-xs leading-6 text-[#999]">
          <p className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
            <span className="mr-1 text-[#666]">网站地图：</span>
            {(cats ?? []).slice(0, 10).map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate({ name: 'category', categoryId: c.id })}
                className="cursor-pointer text-[#6f78a7] hover:text-[#FF6600] hover:underline"
              >
                [{i + 1}]{c.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => navigate({ name: 'category' })}
              className="cursor-pointer text-[#6f78a7] hover:text-[#FF6600] hover:underline"
            >
              [{Math.min((cats ?? []).length, 10) + 1}]全部
            </button>
            {(footerCfg?.links ?? []).map((lk) => (
              <a
                key={`${lk.label}-${lk.href}`}
                href={lk.href}
                target="_blank"
                rel="noopener noreferrer"
                className="cursor-pointer text-[#6f78a7] hover:text-[#FF6600] hover:underline"
              >
                [{lk.label}]
              </a>
            ))}
          </p>
          <p className="mt-2">
            {footerCfg?.extra || '本站为小说 CMS 结构级主题演示，界面按经典杰奇 CMS 风格重建，全部内容来自演示数据，仅供学习交流，请勿用于商业用途。'}
          </p>
          <p>{footerCfg?.text || `${siteName} · 源站 trxsw.com（重建模板）`}</p>
        </div>
      </footer>

      <HistoryPanel
        open={histOpen}
        onClose={() => setHistOpen(false)}
        navigate={navigate}
        accent="#CC0000"
      />
    </div>
  )
}

/* ==================================================================== */
/* Home：封面推荐横条 + 760/190 双栏 + 三块榜单 + 友链                    */
/* ==================================================================== */

function HomeView({ navigate }: ViewProps) {
  const { data, isLoading, isError, refetch } = useHomeData()

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[980px] px-2 py-3">
        <SkeletonBlock rows={4} className="h-auto" />
        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_190px]">
          <div className="min-w-0 space-y-3">
            <SkeletonBlock rows={12} />
            <SkeletonBlock rows={6} />
          </div>
          <div className="min-w-0 space-y-3">
            <SkeletonBlock rows={10} />
            <SkeletonBlock rows={8} />
          </div>
        </div>
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="mx-auto max-w-[980px] px-2 py-6">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      {/* 封面推荐横条（可横向滚动） */}
      <Block title="编辑推荐" extra={<span>每周精选 · 左右滑动查看更多</span>} bodyClass="p-2.5">
        <div className="no-scrollbar flex gap-3 overflow-x-auto pb-1">
          {data.featured.slice(0, 8).map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => navigate({ name: 'book', novelId: n.id })}
              className="group w-[100px] shrink-0 cursor-pointer text-left"
            >
              <Cover
                novel={n}
                className="h-[133px] w-full transition-transform group-hover:-translate-y-0.5"
              />
              <span className="mt-1 block truncate text-xs text-[#6f78a7] group-hover:text-[#FF6600]">
                {n.title}
              </span>
              <span className="block truncate text-[10px] text-[#999]">{n.author}</span>
            </button>
          ))}
        </div>
      </Block>

      {/* 中部双栏：内容 760 + 侧栏 190 */}
      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_190px]">
        <div className="min-w-0 space-y-3">
          <Block
            title="最新更新"
            extra={<span>今日更新 {data.stats.todayUpdates} 章</span>}
            bodyClass="px-2 py-1"
          >
            {data.latest.slice(0, 30).map((n) => (
              <UpdateRow key={n.id} novel={n} navigate={navigate} />
            ))}
          </Block>

          <Block title="热门小说" extra={<span>全站点击 TOP12</span>} bodyClass="px-3 py-2">
            <div className="grid gap-x-6 sm:grid-cols-2">
              {data.hot.slice(0, 12).map((n, i) => (
                <div
                  key={n.id}
                  className="flex items-baseline gap-2 border-b border-dotted border-[#a6d3e8] py-[6px] text-xs last:border-b-0 sm:last:border-b"
                >
                  <span
                    className={cn(
                      'w-4 shrink-0 text-center font-bold',
                      i < 3 ? 'text-[#FF3300]' : 'text-[#BBB]',
                    )}
                  >
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate({ name: 'book', novelId: n.id })}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-[#6f78a7] hover:text-[#FF6600] hover:underline"
                  >
                    {n.title}
                  </button>
                  <span className="shrink-0 text-[10px] text-[#999]">{n.categoryName}</span>
                </div>
              ))}
            </div>
          </Block>
        </div>

        <aside className="min-w-0 space-y-3">
          <Block title="总推荐榜" bodyClass="px-2 py-1">
            <RankRows novels={data.rankings.clicks} navigate={navigate} limit={15} value="clicks" />
          </Block>
          <Block title="最新入库" bodyClass="px-2 py-1">
            {data.latest.slice(0, 12).map((n) => (
              <div
                key={n.id}
                className="flex items-center justify-between gap-2 border-b border-dotted border-[#a6d3e8] py-[4px] text-xs last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => navigate({ name: 'book', novelId: n.id })}
                  className="min-w-0 flex-1 cursor-pointer truncate text-left text-[#6f78a7] hover:text-[#FF6600] hover:underline"
                >
                  {n.title}
                </button>
                <span className="shrink-0 text-[10px] text-[#BBB]">{shortDate(n.updatedAt)}</span>
              </div>
            ))}
          </Block>
        </aside>
      </div>

      {/* 后台可配置的首页自定义图文区块：置于「分类导航 + 双榜」上方（无配置时渲染 null） */}
      <div className="mt-3">
        <HomeCustomBlocks navigate={navigate} />
      </div>

      {/* 分类导航 + 双榜 */}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Block title="分类导航" bodyClass="p-2">
          <div className="grid grid-cols-2 gap-1.5">
            {data.categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate({ name: 'category', categoryId: c.id })}
                className="flex cursor-pointer items-center justify-between border border-[#a6d3e8] bg-[#FAFAFA] px-2 py-1.5 text-xs text-[#6f78a7] transition-colors hover:border-[#459df5] hover:text-[#FF6600]"
              >
                <span className="truncate">{c.name}</span>
                <span className="shrink-0 text-[10px] text-[#999]">{c.novelCount}部</span>
              </button>
            ))}
          </div>
        </Block>
        <Block title="更新榜" bodyClass="px-2 py-1">
          <RankRows novels={data.rankings.updates} navigate={navigate} limit={10} value="words" />
        </Block>
        <Block title="完本榜" bodyClass="px-2 py-1">
          <RankRows novels={data.rankings.finished} navigate={navigate} limit={10} value="words" />
        </Block>
      </div>

      {/* 友情链接（真实数据驱动：站内分类入口 + 全部书库，杰奇首页底部惯例） */}
      <Block title="友情链接" className="mt-3" bodyClass="p-2.5">
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs leading-5 text-[#6f78a7]">
          {(data.categories ?? []).slice(0, 9).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => navigate({ name: 'category', categoryId: c.id })}
              className="cursor-pointer transition-colors hover:text-[#FF6600] hover:underline"
            >
              {c.name.endsWith('小说') ? c.name : `${c.name}小说`}
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigate({ name: 'category' })}
            className="cursor-pointer transition-colors hover:text-[#FF6600] hover:underline"
          >
            全部书库
          </button>
          <button
            type="button"
            onClick={() => navigate({ name: 'category' })}
            className="cursor-pointer transition-colors hover:text-[#FF6600] hover:underline"
          >
            完本列表
          </button>
        </p>
      </Block>
    </div>
  )
}

/* ==================================================================== */
/* Category：左 190 榜单侧栏 + 右 760 六列数据表                           */
/* ==================================================================== */

type SortKey = 'latest' | 'clicks' | 'words'
type StatusKey = 'all' | 'serial' | 'finished'
type PresetKey = 'clicks' | 'latest' | 'finished' | 'words'

function CategoryView({ navigate, categoryId }: ViewProps & { categoryId?: number }) {
  const { data: cats } = useCategories()
  const { data: home } = useHomeData()
  const [sort, setSort] = useState<SortKey>('latest')
  const [status, setStatus] = useState<StatusKey>('all')

  const { data, isLoading, isError, refetch } = useNovels({
    categoryId,
    pageSize: 500,
    sort,
    status: status === 'all' ? undefined : status,
  })

  const catName =
    categoryId != null ? (cats ?? []).find((c) => c.id === categoryId)?.name : undefined
  const applySort = (s: SortKey) => {
    setSort(s)
    setStatus('all')
  }
  const applyStatus = (s: StatusKey) => {
    setStatus(s)
  }
  const applyPreset = (p: PresetKey) => {
    if (p === 'finished') {
      setSort('latest')
      setStatus('finished')
    } else {
      setSort(p)
      setStatus('all')
    }
  }

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      <Crumbs
        items={[{ label: '首页', view: { name: 'home' } }, { label: catName ?? '全部小说' }]}
        navigate={navigate}
      />

      <div className="mt-3 grid gap-3 md:grid-cols-[190px_minmax(0,1fr)]">
        {/* 左侧栏 190：推荐榜 + 榜单直达 */}
        <aside className="order-2 min-w-0 space-y-3 md:order-1">
          <Block title="会员推荐榜" bodyClass="px-2 py-1">
            <RankRows novels={(home?.rankings.clicks ?? []).slice(0, 10)} navigate={navigate} limit={10} />
          </Block>
          <Block title="榜单直达" bodyClass="p-2">
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ['clicks', '点击榜'],
                  ['latest', '更新榜'],
                  ['finished', '完本榜'],
                  ['words', '字数榜'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => applyPreset(k)}
                  className="cursor-pointer border border-[#a6d3e8] bg-[#FAFAFA] py-1.5 text-xs text-[#6f78a7] transition-colors hover:border-[#FF6600] hover:text-[#FF6600]"
                >
                  {label}
                </button>
              ))}
            </div>
          </Block>
        </aside>

        {/* 右侧数据表 760 */}
        <Block
          className="order-1 min-w-0 md:order-2"
          title={`${catName ?? '全部小说'}列表`}
          extra={<span>共 {data?.total ?? '—'} 部</span>}
          bodyClass="px-2 py-1"
        >
          {/* 排序筛选行 */}
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[#a6d3e8] bg-[#e9faff] px-2 py-1.5 text-xs">
            <span className="text-[#999]">排序</span>
            {(
              [
                ['latest', '最近更新'],
                ['clicks', '点击最多'],
                ['words', '字数最多'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => applySort(k)}
                className={cn(
                  'cursor-pointer',
                  sort === k && status !== 'finished'
                    ? 'font-bold text-[#FF6600]'
                    : 'text-[#6f78a7] hover:text-[#FF6600]',
                )}
              >
                {label}
              </button>
            ))}
            <span className="ml-2 text-[#999]">状态</span>
            {(
              [
                ['all', '全部'],
                ['serial', '连载'],
                ['finished', '完本'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => applyStatus(k)}
                className={cn(
                  'cursor-pointer',
                  status === k ? 'font-bold text-[#FF6600]' : 'text-[#6f78a7] hover:text-[#FF6600]',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 图文推荐 / 热门书籍区块（无数据时自渲染 null） */}
          <CategoryFeaturedBlock navigate={navigate} categoryId={categoryId} />
          <CategoryHotBlock navigate={navigate} categoryId={categoryId} />

          {/* 表头（灰底） */}
          <div className="hidden bg-[#e1eced] px-2 py-1.5 text-xs font-bold text-[#666] md:grid md:grid-cols-[minmax(0,18fr)_minmax(0,46fr)_minmax(0,13fr)_minmax(0,8fr)_minmax(0,9fr)_minmax(0,6fr)] md:gap-x-3">
            <span>书名</span>
            <span>最新章节</span>
            <span>作者</span>
            <span className="text-right">字数</span>
            <span>更新</span>
            <span className="text-center">状态</span>
          </div>

          {isLoading ? (
            <SkeletonLines className="py-4" rows={10} />
          ) : isError ? (
            <div className="py-6">
              <ErrorBox onRetry={() => refetch()} />
            </div>
          ) : data && data.list.length > 0 ? (
            data.list.map((n) => <BookRow key={n.id} novel={n} navigate={navigate} />)
          ) : (
            <p className="py-10 text-center text-sm text-[#999]">该分类下暂无小说，换个条件试试～</p>
          )}
        </Block>
      </div>
    </div>
  )
}

/* ==================================================================== */
/* Book：居中标题 + 封面浮左属性表 + 橙色主按钮 + 简介 + 最近章节          */
/* ==================================================================== */

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-1">
      <dt className="shrink-0 text-[#999]">{k}：</dt>
      <dd className="truncate text-[#666]" title={v}>
        {v}
      </dd>
    </div>
  )
}

/* ---- 书架（localStorage 持久化，跨视图/跨会话一致） ---- */

const SHELF_KEY = 'trxsw-shelf'

function loadShelf(): number[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(window.localStorage.getItem(SHELF_KEY) ?? '[]') as number[]
  } catch {
    return []
  }
}

function toggleShelf(id: number): boolean {
  if (typeof window === 'undefined') return false
  try {
    const arr = loadShelf()
    const has = arr.includes(id)
    window.localStorage.setItem(SHELF_KEY, JSON.stringify(has ? arr.filter((x) => x !== id) : [...arr, id]))
    return !has
  } catch {
    return false
  }
}

function BookView(props: ViewProps & { novelId: number }) {
  /* key=novelId：换书重挂载，重置书架/投票等本地状态并重新读 storage */
  return <BookInner key={props.novelId} {...props} />
}

function BookInner({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: n, isLoading, isError, refetch } = useNovel(novelId)
  /* 最近章节需从全量章节取末 12 条（详情接口的 chapters 是最早 12 章，不能直接用） */
  const chaptersQ = useChapters(novelId)
  const latest12 = chaptersQ.data ? [...chaptersQ.data].slice(-12).reverse() : null
  const [shelf, setShelf] = useState(() => loadShelf().includes(novelId))
  const [voted, setVoted] = useState(false)

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-[980px] px-2 py-3">
        <div aria-hidden className="animate-pulse border border-[#a6d3e8] bg-white p-4">
          <div className="mx-auto h-5 w-1/3 bg-[#F0F0F0]" />
          <div className="mx-auto mt-2 h-3 w-1/2 bg-[#F0F0F0]" />
          <div className="mt-4 flex flex-col gap-4 sm:flex-row">
            <div className="h-[150px] w-[120px] shrink-0 self-center bg-[#F0F0F0] sm:self-start" />
            <div className="flex-1 space-y-2.5 pt-1">
              <div className="h-3 w-2/3 bg-[#F0F0F0]" />
              <div className="h-3 w-1/2 bg-[#F0F0F0]" />
              <div className="h-3 w-3/5 bg-[#F0F0F0]" />
              <div className="h-8 w-56 bg-[#F0F0F0]" />
            </div>
          </div>
        </div>
        <SkeletonBlock className="mt-3" rows={5} />
      </div>
    )
  }
  if (isError || !n) {
    return (
      <div className="mx-auto max-w-[980px] px-2 py-6">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      {/* 居中大标题 */}
      <h1 className="text-center text-xl font-bold text-[#333]">{n.title}</h1>
      <p className="mt-1 text-center text-xs text-[#999]">
        {n.categoryName} · {n.author} · {statusText(n.status)} · {formatWords(n.wordCount)}字
      </p>

      {/* 封面浮左 + 属性表 + 按钮行 */}
      <div className="mt-3 border border-[#a6d3e8] bg-white p-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          <Cover novel={n} className="h-[150px] w-[120px] self-center text-5xl sm:self-start" charClass="text-5xl" />
          <div className="min-w-0 flex-1">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
              <Meta k="类别" v={n.categoryName} />
              <Meta k="作者" v={n.author} />
              <Meta k="状态" v={statusText(n.status)} />
              <Meta k="字数" v={`${formatWords(n.wordCount)} 字`} />
              <Meta k="更新时间" v={fullDate(n.updatedAt)} />
              <Meta k="总点击" v={formatWords(n.clicks)} />
            </dl>
            <p className="mt-2 truncate text-xs text-[#666]">
              最新章节：
              {n.lastChapterId ? (
                <button
                  type="button"
                  onClick={() => navigate({ name: 'chapter', chapterId: n.lastChapterId as number })}
                  className="cursor-pointer text-[#6f78a7] hover:text-[#FF6600] hover:underline"
                >
                  {n.lastChapterTitle ?? '点击查看'}
                </button>
              ) : (
                <span className="text-[#999]">暂无</span>
              )}
              <span className="ml-3 text-[#999]">共 {n.totalChapters} 章</span>
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  n.firstChapterId
                    ? navigate({ name: 'chapter', chapterId: n.firstChapterId })
                    : navigate({ name: 'toc', novelId })
                }
                className="cursor-pointer bg-[#FF6600] px-5 py-1.5 text-sm text-white transition-colors hover:bg-[#E05A00]"
              >
                全文阅读
              </button>
              <button
                type="button"
                onClick={() => setShelf(toggleShelf(novelId))}
                className={cn(
                  'cursor-pointer border px-4 py-1.5 text-sm transition-colors',
                  shelf
                    ? 'border-[#FF6600] bg-[#FFF3E8] text-[#E05A00]'
                    : 'border-[#FF6600] text-[#FF6600] hover:bg-[#FFF3E8]',
                )}
              >
                {shelf ? '已在书架 ✓' : '加入书架'}
              </button>
              <button
                type="button"
                onClick={() => setVoted(true)}
                className="cursor-pointer border border-[#FF6600] px-4 py-1.5 text-sm text-[#FF6600] transition-colors hover:bg-[#FFF3E8]"
              >
                {voted ? '已推荐 +1' : '推荐本书'}
              </button>
              <button
                type="button"
                disabled
                title="演示站点不提供下载"
                className="cursor-not-allowed border border-[#a6d3e8] px-4 py-1.5 text-sm text-[#BBB]"
              >
                TXT 下载
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 内容简介（灰底标题条） */}
      <Block className="mt-3" title="内容简介" bodyClass="p-4">
        <p className="indent-[2em] text-sm leading-7 text-[#666]">
          {n.description || '作者尚未填写简介。'}
        </p>
        <NovelTagsRow tags={n.tags ?? []} navigate={navigate} className="mt-3" />
      </Block>

      {/* 最近章节（全量章节末 12 条倒序 = 最新 12 章，新→旧，双栏） */}
      <Block
        className="mt-3"
        title="最近章节"
        extra={
          <button
            type="button"
            onClick={() => navigate({ name: 'toc', novelId })}
            className="cursor-pointer text-[11px] text-[#6f78a7] hover:text-[#FF6600]"
          >
            完整目录 »
          </button>
        }
        bodyClass="px-3 py-1"
      >
        <div className="grid gap-x-8 md:grid-cols-2">
          {chaptersQ.isPending ? (
            <SkeletonLines className="py-3" rows={8} />
          ) : chaptersQ.isError ? (
            <div className="py-4">
              <ErrorBox message="章节加载失败" onRetry={() => chaptersQ.refetch()} />
            </div>
          ) : !latest12 || latest12.length === 0 ? (
            <p className="py-10 text-center text-sm text-[#999]">暂无章节</p>
          ) : (
            latest12.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                className="flex cursor-pointer items-center justify-between gap-3 border-b border-dotted border-[#a6d3e8] py-[7px] text-xs hover:bg-[#FBFBFB]"
              >
                <span className="truncate text-[#6f78a7] hover:text-[#FF6600]">{c.title}</span>
                <span className="shrink-0 text-[10px] text-[#BBB]">{formatWords(c.wordCount)}字</span>
              </button>
            ))
          )}
        </div>
      </Block>
    </div>
  )
}

/* ==================================================================== */
/* Toc：30px 紧凑顶栏 + 书头小卡 + 4 列章节表（正序）                     */
/* ==================================================================== */

function TocView({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel } = useNovel(novelId)
  const { data: chapters, isLoading, isError, refetch } = useChapters(novelId)
  const sorted = useMemo(() => [...(chapters ?? [])].sort((a, b) => a.idx - b.idx), [chapters])
  const firstId = sorted[0]?.id ?? novel?.firstChapterId ?? null

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      {/* 紧凑顶栏（30px）：面包屑 + 开始阅读 */}
      <div className="flex h-[30px] items-center justify-between gap-2 border border-[#a6d3e8] bg-[#FAFAFA] px-3 text-xs">
        <Crumbs
          className="min-w-0"
          items={[
            { label: '首页', view: { name: 'home' } },
            ...(novel ? [{ label: novel.title, view: { name: 'book', novelId } as const }] : []),
            { label: '目录' },
          ]}
          navigate={navigate}
        />
        <button
          type="button"
          disabled={!firstId}
          onClick={() => firstId && navigate({ name: 'chapter', chapterId: firstId })}
          className={cn(
            'shrink-0 px-3 py-0.5 text-white transition-colors',
            firstId
              ? 'cursor-pointer bg-[#FF6600] hover:bg-[#E05A00]'
              : 'cursor-not-allowed bg-[#FFC299]',
          )}
        >
          开始阅读
        </button>
      </div>

      {/* 书头小卡 */}
      {novel ? (
        <div className="mt-3 flex gap-3 border border-[#a6d3e8] bg-white p-3">
          <Cover novel={novel} className="h-[120px] w-[90px] text-4xl" />
          <div className="min-w-0 flex-1 text-xs leading-6 text-[#666]">
            <button
              type="button"
              onClick={() => navigate({ name: 'book', novelId })}
              className="cursor-pointer text-base font-bold text-[#6f78a7] hover:text-[#FF6600]"
            >
              《{novel.title}》
            </button>
            <p>
              作者：{novel.author} · {novel.categoryName} · {statusText(novel.status)}
            </p>
            <p>
              共 {novel.totalChapters} 章 · {formatWords(novel.wordCount)}字 · 更新于{' '}
              {fullDate(novel.updatedAt)}
            </p>
          </div>
        </div>
      ) : (
        <SkeletonBlock className="mt-3" rows={2} />
      )}

      {/* 最新章节（全书倒数 12 章，新→旧） */}
      {sorted.length > 0 && (
        <Block className="mt-3" title="最新章节（最近更新 12 章 · 新→旧）" bodyClass="p-2">
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 md:grid-cols-4">
            {[...sorted].slice(-12).reverse().map((c) => (
              <button
                key={`latest-${c.id}`}
                type="button"
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                title={c.title}
                className="cursor-pointer truncate border-b border-dotted border-[#a6d3e8] px-1 py-[7px] text-left text-xs text-[#6f78a7] transition-colors hover:bg-[#FFF7F0] hover:text-[#FF6600]"
              >
                {c.idx}. {c.title}
              </button>
            ))}
          </div>
        </Block>
      )}

      {/* 4 列章节表 */}
      <Block
        className="mt-3"
        title={`章节目录（${sorted.length} 章 · 正序）`}
        bodyClass="p-2"
      >
        {isLoading ? (
          <SkeletonLines className="p-2" rows={10} />
        ) : isError ? (
          <ErrorBox onRetry={() => refetch()} />
        ) : sorted.length === 0 ? (
          <p className="py-10 text-center text-sm text-[#999]">暂无章节数据</p>
        ) : (
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 md:grid-cols-4">
            {sorted.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                title={c.title}
                className="cursor-pointer truncate border-b border-dotted border-[#a6d3e8] px-1 py-[7px] text-left text-xs text-[#6f78a7] transition-colors hover:bg-[#FFF7F0] hover:text-[#FF6600]"
              >
                {c.idx}. {c.title}
              </button>
            ))}
          </div>
        )}
      </Block>
    </div>
  )
}

/* ==================================================================== */
/* Chapter：淡蓝底阅读页 + 居中标题 + 双份翻章导航 + 键盘 ←/→ + 阅读设置   */
/* ==================================================================== */

/* 场景配色：日间淡蓝底 + 白纸面，其余按语义键换肤 */
const SCENES: Record<string, ReaderSceneColors> = {
  day: { page: '#e9faff', paper: '#ffffff', ink: '#333333', muted: '#8FA6C0', line: '#D8E8F6' },
  paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#d4c5a3' },
  green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', muted: '#8fa590', line: '#bcd4bc' },
  blue: { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', muted: '#8fa2b0', line: '#b8cede' },
  night: { page: '#1e2024', paper: '#26262b', ink: '#c0c0c6', muted: '#8a8a92', line: '#3a3a42' },
}

/** 阅读设置条：字号 A± / 行距 / 字体 / 字色 / 背景（跨主题共享同一份偏好，localStorage 持久化） */
function ReaderBar() {
  const [prefs] = useReaderPrefs()
  const btn =
    'flex h-[22px] min-w-[26px] cursor-pointer items-center justify-center border border-[#CBE0F2] bg-white px-1.5 text-[11px] text-[#6f78a7] transition-colors hover:border-[#FF6600] hover:text-[#FF6600]'
  const on = 'border-[#FF6600] bg-[#FFF3E8] text-[#E05A00]'
  const night = prefs.scene === 'night'
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-[#8FA6C0]">
      字号
      <button className={btn} title="减小字号" onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, -1) })}>
        A-
      </button>
      <button className={btn} title="增大字号" onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, 1) })}>
        A+
      </button>
      <span className="w-[36px] text-right">{prefs.fontSize}px</span>
      <span className="h-[12px] w-px bg-[#D8E8F6]" />
      行距
      {READER_LINE_HEIGHTS.map((lh) => (
        <button key={lh} className={`${btn} ${prefs.lineHeight === lh ? on : ''}`} onClick={() => setReaderPrefs({ lineHeight: lh })}>
          {lh.toFixed(1)}
        </button>
      ))}
      <span className="h-[12px] w-px bg-[#D8E8F6]" />
      字体
      <select
        value={prefs.font}
        onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
        className="h-[22px] cursor-pointer border border-[#CBE0F2] bg-white px-0.5 text-[11px] text-[#6f78a7] outline-none"
      >
        <option value="default">默认</option>
        <option value="song">宋体</option>
        <option value="hei">黑体</option>
        <option value="kai">楷体</option>
      </select>
      <span className="h-[12px] w-px bg-[#D8E8F6]" />
      字色
      <select
        value={prefs.ink}
        onChange={(e) => setReaderPrefs({ ink: e.target.value })}
        aria-label="字色"
        className="h-[22px] cursor-pointer border border-[#CBE0F2] bg-white px-0.5 text-[11px] text-[#6f78a7] outline-none"
      >
        {READER_INKS.map((c) => (
          <option key={c.k} value={c.v}>{c.k}</option>
        ))}
      </select>
      <span className="h-[12px] w-px bg-[#D8E8F6]" />
      背景
      {READER_SCENES.map((s) => (
        <button
          key={s.key}
          title={s.label}
          aria-label={`背景：${s.label}`}
          onClick={() => setReaderPrefs({ scene: s.key })}
          className={`h-4 w-4 cursor-pointer rounded-full border transition-all ${
            prefs.scene === s.key ? 'scale-110 border-[#FF6600]' : 'border-black/25'
          }`}
          style={{ background: SCENES[s.key].paper }}
        />
      ))}
      <button className={`${btn} ${night ? on : ''}`} onClick={() => setReaderPrefs({ scene: night ? 'day' : 'night' })}>
        {night ? '日间' : '夜间'}
      </button>
      <button className="cursor-pointer text-[11px] text-[#B7C8DA] hover:text-[#FF6600]" onClick={resetReaderPrefs}>
        恢复默认
      </button>
    </div>
  )
}

function ChapterNav({
  ch,
  navigate,
  className,
}: {
  ch: ChapterDetail
  navigate: ViewProps['navigate']
  className?: string
}) {
  const base = 'cursor-pointer border px-4 py-1.5 text-xs transition-colors'
  const on =
    'border-[#CBE0F2] bg-white text-[#6f78a7] hover:border-[#FF6600] hover:text-[#FF6600]'
  const off = 'cursor-not-allowed border-[#DCEAF5] bg-[#F4FAFF] text-[#B9CDE0]'
  return (
    <div className={cn('flex items-center justify-center gap-3', className)}>
      <button
        type="button"
        disabled={!ch.prevId}
        onClick={() => {
          if (ch.prevId) navigate({ name: 'chapter', chapterId: ch.prevId })
        }}
        className={cn(base, ch.prevId ? on : off)}
      >
        上一页
      </button>
      <button type="button" onClick={() => navigate({ name: 'toc', novelId: ch.novelId })} className={cn(base, on)}>
        返回目录
      </button>
      <button
        type="button"
        disabled={!ch.nextId}
        onClick={() => {
          if (ch.nextId) navigate({ name: 'chapter', chapterId: ch.nextId })
        }}
        className={cn(base, ch.nextId ? on : off)}
      >
        下一页
      </button>
    </div>
  )
}

function ChapterView(props: ViewProps & { chapterId: number }) {
  /* key=chapterId：换章重挂载，重置书架/投票等本地状态 */
  return <ChapterInner key={props.chapterId} {...props} />
}

function ChapterInner({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const { data: ch, isLoading, isError, refetch } = useChapter(chapterId)
  const [prefs] = useReaderPrefs()
  const [shelf, setShelf] = useState(false)
  const [voted, setVoted] = useState(false)
  /* 章节加载后从 storage 同步书架态（书架按书持久化） */
  const [shelfNovelId, setShelfNovelId] = useState<number | null>(null)
  if (ch && shelfNovelId !== ch.novelId) {
    setShelfNovelId(ch.novelId)
    setShelf(loadShelf().includes(ch.novelId))
  }

  const paras = useMemo(
    () =>
      (ch?.content ?? '')
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [ch?.content],
  )

  const scene = SCENES[prefs.scene] ?? SCENES.day

  const goPrev = () => {
    if (ch?.prevId) navigate({ name: 'chapter', chapterId: ch.prevId })
  }
  const goNext = () => {
    if (ch?.nextId) navigate({ name: 'chapter', chapterId: ch.nextId })
  }

  /* 键盘 ←/→ 翻章（焦点在输入框/下拉/按钮上时不触发；无依赖数组：每次渲染绑定最新闭包） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-[980px] px-2 py-3">
        <div aria-hidden className="animate-pulse border border-[#D0E4F5] bg-[#e9faff] px-4 py-8 sm:px-10">
          <div className="mx-auto h-5 w-1/2 bg-[#D2E6F7]" />
          <div className="mx-auto mt-3 h-8 w-2/3 bg-white/70" />
          <div className="mt-5 space-y-3 rounded-sm bg-white px-6 py-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-4 bg-[#F0F0F0]" style={{ width: `${92 - ((i * 17) % 40)}%` }} />
            ))}
          </div>
        </div>
      </div>
    )
  }
  if (isError || !ch) {
    return (
      <div className="mx-auto max-w-[980px] px-2 py-6">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      {/* 淡蓝底阅读区（场景换肤） */}
      <div className="border px-3 py-4 transition-colors sm:px-6" style={{ background: scene.page, borderColor: scene.line }}>
        {/* 面包屑 + 操作链接 */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <Crumbs
            className="min-w-0"
            items={[
              { label: '首页', view: { name: 'home' } },
              { label: ch.novelTitle, view: { name: 'book', novelId: ch.novelId } },
              { label: ch.title },
            ]}
            navigate={navigate}
          />
          <div className="flex shrink-0 gap-3 text-[#6f78a7]">
            <button
              type="button"
              onClick={() => ch && setShelf(toggleShelf(ch.novelId))}
              className="cursor-pointer hover:text-[#FF6600]"
            >
              {shelf ? '已在书架' : '加入书架'}
            </button>
            <button
              type="button"
              onClick={() => setVoted(true)}
              className="cursor-pointer hover:text-[#FF6600]"
            >
              {voted ? '已推荐' : '推荐本书'}
            </button>
          </div>
        </div>

        {/* 居中章节标题 */}
        <h1 className="py-3 text-center text-lg font-bold text-[#333]">{ch.title}</h1>

        {/* 章首翻章导航 */}
        <ChapterNav ch={ch} navigate={navigate} />

        {/* 阅读设置 */}
        <ReaderBar />

        {/* 正文：居中约 85% 宽，缩进 2em，字号/行距/字体/背景可调 */}
        <article
          className="mt-3 border px-4 py-6 transition-colors sm:px-10"
          style={{ background: scene.paper, borderColor: scene.line }}
        >
          <div className="mx-auto w-[92%] max-w-[760px] break-words md:w-[85%]">
            {paras.length === 0 ? (
              <p className="py-6 text-center text-sm" style={{ color: scene.muted }}>本章内容为空</p>
            ) : (
              paras.map((p, i) => (
                <p
                  key={i}
                  className="indent-[2em]"
                  style={{
                    fontSize: prefs.fontSize,
                    lineHeight: prefs.lineHeight,
                    fontFamily: readerFontStack(prefs.font),
                    color: readerInk(prefs, scene),
                  }}
                >
                  {p}
                </p>
              ))
            )}
            <p className="mt-6 text-center text-[11px]" style={{ color: scene.muted }}>
              本章约 {formatWords(ch.wordCount)} 字 · 键盘 ← / → 也可翻章
            </p>
          </div>
        </article>

        {/* 尾部按钮排 */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => ch && setShelf(toggleShelf(ch.novelId))}
            className={cn(
              'cursor-pointer border px-4 py-1.5 transition-colors',
              shelf
                ? 'border-[#FF6600] bg-[#FFF3E8] text-[#E05A00]'
                : 'border-[#CBE0F2] bg-white text-[#6f78a7] hover:border-[#FF6600] hover:text-[#FF6600]',
            )}
          >
            {shelf ? '已在书架 ✓' : '加入书架'}
          </button>
          <button
            type="button"
            onClick={() => setVoted(true)}
            className={cn(
              'cursor-pointer border px-4 py-1.5 transition-colors',
              voted
                ? 'border-[#FF6600] bg-[#FFF3E8] text-[#E05A00]'
                : 'border-[#CBE0F2] bg-white text-[#6f78a7] hover:border-[#FF6600] hover:text-[#FF6600]',
            )}
          >
            {voted ? '已推荐 +1' : '推荐本书'}
          </button>
          <span className="cursor-default px-2 text-[#8FA6C0]">举报错误</span>
        </div>

        {/* 章尾翻章导航 */}
        <ChapterNav ch={ch} navigate={navigate} className="mt-3" />
      </div>
    </div>
  )
}

/* ==================================================================== */
/* Search：本地输入 + 双按钮 + 六列结果表 + 本地分页                      */
/* ==================================================================== */

/* 外层按 query+字段 重挂载内层：关键词或检索字段变化时自动重置草稿与页码（无需 effect） */
function SearchView({ navigate, siteName, query }: ViewProps & { query: string }) {
  const field = useSearchField((s) => s.field)
  return <SearchInner key={`${query}|${field}`} navigate={navigate} siteName={siteName} query={query} field={field} />
}

function SearchInner({ navigate, query, field }: ViewProps & { query: string; field: SearchField }) {
  const [kw, setKw] = useState(query)
  const setField = useSearchField((s) => s.setField)

  /* all → 服务端检索；title/author → 一次拉全后按字段本地过滤（均无分页） */
  const serverQ = useNovels({ q: query || undefined, pageSize: 500, enabled: field === 'all' })
  const poolQ = useNovels({ q: query || undefined, pageSize: 500, enabled: field !== 'all' })

  const filtered = useMemo(() => {
    if (field === 'all' || !poolQ.data) return null
    const kwT = query.trim()
    const rows = poolQ.data.list.filter((n) => (field === 'title' ? n.title : n.author).includes(kwT))
    return { rows, total: rows.length }
  }, [field, poolQ.data, query])

  const isLoading = field === 'all' ? serverQ.isPending : poolQ.isPending
  const isError = field === 'all' ? serverQ.isError : poolQ.isError
  const refetch = () => (field === 'all' ? serverQ.refetch() : poolQ.refetch())
  const rows = field === 'all' ? (serverQ.data?.list ?? []) : (filtered?.rows ?? [])
  const total = field === 'all' ? (serverQ.data?.total ?? 0) : (filtered?.total ?? 0)

  /* 回车 = 综合检索（书名/作者/简介）；双按钮 = 分别按书名字段 / 作者字段检索 */
  const submit = () => {
    const t = kw.trim()
    if (!t) return
    setField('all')
    if (t !== query) navigate({ name: 'search', query: t })
  }
  const submitBy = (f: 'title' | 'author') => {
    const t = kw.trim()
    if (!t) return
    setField(f)
    if (t !== query) navigate({ name: 'search', query: t })
  }
  const fieldLabel = field === 'title' ? '按书名' : field === 'author' ? '按作者' : '综合检索'

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      {/* 搜索面板 */}
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] border-2 border-[#a6d3e8] bg-[#f7fbfd] p-3">
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="输入书名或作者关键词"
          className="h-8 min-w-0 flex-1 border border-[#a6d3e8] px-2 text-sm outline-none focus:border-[#459df5]"
        />
        <button
          type="button"
          onClick={() => submitBy('title')}
          title="按书名字段检索"
          className={`h-8 shrink-0 cursor-pointer px-4 text-xs text-white transition-colors ${
            field === 'title' ? 'bg-[#a01c04]' : 'bg-[#c42205] hover:bg-[#a01c04]'
          }`}
        >
          搜书名
        </button>
        <button
          type="button"
          onClick={() => submitBy('author')}
          title="按作者字段检索"
          className={`h-8 shrink-0 cursor-pointer border border-l-0 border-[#c42205] px-4 text-xs transition-colors ${
            field === 'author' ? 'bg-[#c42205] font-bold text-white' : 'text-[#c42205] hover:bg-[#FFF3F0]'
          }`}
        >
          搜作者
        </button>
      </div>

      <p className="mt-2 text-xs text-[#999]">
        {fieldLabel}：<span className="text-[#FF3300]">{query || '…'}</span>
        {query ? `，共找到 ${total} 条结果` : ''}
      </p>

      <Block className="mt-2" title="搜索结果" bodyClass="px-2 py-1">
        {/* 表头 */}
        <div className="hidden bg-[#e1eced] px-2 py-1.5 text-xs font-bold text-[#666] md:grid md:grid-cols-[minmax(0,18fr)_minmax(0,46fr)_minmax(0,13fr)_minmax(0,8fr)_minmax(0,9fr)_minmax(0,6fr)] md:gap-x-3">
          <span>书名</span>
          <span>最新章节</span>
          <span>作者</span>
          <span className="text-right">字数</span>
          <span>更新</span>
          <span className="text-center">状态</span>
        </div>
        {isLoading ? (
          <SkeletonLines className="py-4" rows={8} />
        ) : isError ? (
          <div className="py-4">
            <ErrorBox onRetry={refetch} />
          </div>
        ) : rows.length > 0 ? (
          rows.map((n) => <BookRow key={n.id} novel={n} navigate={navigate} />)
        ) : (
          <p className="py-10 text-center text-sm text-[#999]">未找到相关小说，换个关键词试试～</p>
        )}
      </Block>
    </div>
  )
}

/* ==================================================================== */
/* ThemeModule 导出                                                      */
/* ==================================================================== */

const theme: ThemeModule = {
  id: 'trxsw',
  name: '唐人小说',
  source: 'trxsw.com',
  description:
    '唐人小说网（葡萄模板）980px 重建：蓝底圆角导航 #88c6e5 + 黄条分类导航 #fff9d9、圆角蓝框区块 #a6d3e8、760+190 双栏五段式更新表、六列数据表、强调 #c42205；目录 4 列，阅读页淡蓝底 #e9faff 并支持键盘 ←/→ 翻章。',
  swatch: ['#88c6e5', '#e9faff'],
  Layout,
  Home: HomeView,
  Category: CategoryView,
  Book: BookView,
  Toc: TocView,
  Chapter: ChapterView,
  Search: SearchView,
}

export default theme
