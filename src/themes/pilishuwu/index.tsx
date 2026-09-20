'use client'

/**
 * pilishuwu（飞速小说风）—— 结构级主题模版
 * 规格要点：980px 定宽居中；顶部欢迎条 + Logo/搜索 + 深蓝导航(#3B76A8) + 公告条；
 * 首页左 700px 主栏（强推封面网格 2×2 / 热门 / 五段式最新更新表）+ 右 260px 榜单侧栏；
 * 经杰奇式 block + 标题条结构；正文页居中 85% 宽、章首章尾双份上下章导航、字号/护眼切换。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
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
import {
  READER_INKS,
  READER_LINE_HEIGHTS,
  READER_SCENES,
  readerFontStack,
  readerInk,
  setReaderPrefs,
  stepFontSize,
  useReaderPrefs,
  type ReaderSceneColors,
} from '@/hooks/use-reader-prefs'
import type { ChapterDetail } from '@/lib/types'
import type { ThemeLayoutProps, ThemeModule, ThemeView, ViewProps } from '../types'
import { HistoryPanel } from '@/components/theme-tools/HistoryPanel'
import { useFavoriteSite, showSetHomepageHint } from '@/components/theme-tools/FavoriteSite'
import { TradToggle } from '@/components/theme-tools/TradToggle'
import {
  Block,
  Cover,
  Crumbs,
  ErrorBox,
  Pager,
  RankList,
  ResultRow,
  SkeletonBlock,
  SkeletonLines,
  UpdateRow,
  formatDate,
  formatWords,
  statusText,
} from './ui'

/* ==================================================================== */
/* Layout：欢迎条 + Logo/搜索 + 深蓝导航 + 公告 + 页脚                    */
/* ==================================================================== */

function Layout({ view, children, navigate, siteName, notice }: ThemeLayoutProps) {
  const { data: cats } = useCategories()
  const { data: settings } = useSettings()
  const footerCfg = settings?.footer
  const [kw, setKw] = useState('')
  const [histOpen, setHistOpen] = useState(false)
  const { promptFavorite, shortcut } = useFavoriteSite()
  const dateRef = useRef<HTMLElement>(null)

  /* 日期仅客户端填充（直接写 DOM，避免 effect 内 setState） */
  useEffect(() => {
    if (dateRef.current) {
      dateRef.current.textContent = new Date().toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
      })
    }
  }, [])

  const submitSearch = () => {
    const t = kw.trim()
    if (t) navigate({ name: 'search', query: t })
  }

  const activeCategoryId = view.name === 'category' ? view.categoryId : undefined

  const navLink = (active: boolean) =>
    cn(
      'shrink-0 cursor-pointer px-4 py-2.5 transition-colors',
      active ? 'bg-[#2F6FA3] font-bold shadow-[inset_0_-3px_0_#FF9900]' : 'hover:bg-[#2F6FA3]',
    )

  return (
    <div className="flex min-h-screen flex-col bg-[#F5F9FD] text-[#333]">
      {/* 顶部欢迎条 */}
      <div className="hidden border-b border-[#D7E7F4] bg-[#EAF3FB] text-xs text-[#666] md:block">
        <div className="mx-auto flex h-7 max-w-[980px] items-center justify-between px-2">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => showSetHomepageHint(siteName)}
              title="如何在浏览器中把本站设为主页"
              className="cursor-pointer hover:text-[#FF6600]"
            >
              设为首页
            </button>
            <button
              type="button"
              onClick={promptFavorite}
              title={`按 ${shortcut} 也可收藏本站`}
              className="cursor-pointer hover:text-[#FF6600]"
            >
              收藏本站
            </button>
            <button
              type="button"
              onClick={() => setHistOpen(true)}
              title="查看最近阅读过的章节"
              className="cursor-pointer hover:text-[#FF6600]"
            >
              阅读记录
            </button>
            <TradToggle className="hover:text-[#FF6600]" />
            <span className="text-[#8AA6C0]">简洁阅读 · 全站无弹窗</span>
          </div>
          <span ref={dateRef} className="text-[#8AA6C0]">
            {/* 日期由 effect 客户端填充 */}
          </span>
        </div>
      </div>

      {/* Logo + 搜索 */}
      <header className="bg-white">
        <div className="mx-auto flex max-w-[980px] flex-wrap items-center gap-x-5 gap-y-3 px-2 py-4">
          <button
            type="button"
            onClick={() => navigate({ name: 'home' })}
            className="flex cursor-pointer select-none items-center gap-2 text-left"
          >
            <span className="flex h-11 w-11 items-center justify-center bg-[#3B76A8] text-xl font-black text-white">
              飞
            </span>
            <span>
              <span className="block text-2xl font-black leading-none tracking-wide text-[#3B76A8]">
                {siteName}
              </span>
              <span className="mt-1 block text-[10px] tracking-[0.35em] text-[#9BB8D2]">
                PILISHUWU · 经典蓝白风
              </span>
            </span>
          </button>
          <div className="ml-auto flex w-full max-w-[420px] items-center sm:w-auto">
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch()
              }}
              placeholder="输入书名 / 作者，回车搜索"
              className="h-8 min-w-0 flex-1 border border-r-0 border-[#BFD8EA] bg-white px-2 text-sm text-[#333] outline-none placeholder:text-[#B9CBDC] focus:border-[#3B76A8]"
            />
            <button
              type="button"
              onClick={submitSearch}
              className="h-8 shrink-0 cursor-pointer bg-[#3B76A8] px-4 text-sm text-white transition-colors hover:bg-[#2F6FA3]"
            >
              搜 索
            </button>
          </div>
        </div>
      </header>

      {/* 深蓝主导航 */}
      <nav className="bg-[#3B76A8] text-sm text-white shadow-sm">
        <div className="mx-auto flex max-w-[980px] flex-wrap items-stretch px-2">
          <button type="button" onClick={() => navigate({ name: 'home' })} className={navLink(view.name === 'home')}>
            首 页
          </button>
          {(cats ?? []).slice(0, 8).map((c) => (
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
            全部书库
          </button>
        </div>
      </nav>

      {/* 公告条 */}
      {notice ? (
        <div className="bg-white">
          <div className="mx-auto max-w-[980px] px-2 py-2 text-xs leading-5 text-[#8A6D3B]">
            <span className="mr-2 inline-block bg-[#CC0000] px-1.5 py-0.5 align-[1px] text-[10px] text-white">
              公告
            </span>
            {notice}
          </div>
        </div>
      ) : null}

      <main className="flex-1">{children}</main>

      {/* 页脚 */}
      <footer className="mt-8 border-t-2 border-[#3B76A8] bg-white">
        <div className="mx-auto max-w-[980px] px-2 py-6 text-center text-xs leading-6 text-[#999]">
          <p className="mb-2 flex flex-wrap items-center justify-center gap-x-5">
            <button
              type="button"
              onClick={() => navigate({ name: 'home' })}
              className="cursor-pointer text-[#666] hover:text-[#FF6600]"
            >
              返回首页
            </button>
            <button
              type="button"
              onClick={() => navigate({ name: 'category' })}
              className="cursor-pointer text-[#666] hover:text-[#FF6600]"
            >
              全部小说
            </button>
            <button
              type="button"
              onClick={() => setHistOpen(true)}
              className="cursor-pointer text-[#666] hover:text-[#FF6600]"
            >
              阅读记录
            </button>
            <button
              type="button"
              onClick={promptFavorite}
              className="cursor-pointer text-[#666] hover:text-[#FF6600]"
            >
              收藏本站
            </button>
            <TradToggle className="text-[#666] hover:text-[#FF6600]" />
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="cursor-pointer text-[#666] hover:text-[#FF6600]"
            >
              回到顶部
            </button>
            {(footerCfg?.links ?? []).map((lk) => (
              <a
                key={`${lk.label}-${lk.href}`}
                href={lk.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#666] hover:text-[#FF6600]"
              >
                {lk.label}
              </a>
            ))}
          </p>
          <p>{footerCfg?.extra || '本站为小说 CMS 结构级主题演示，界面按经典杰奇蓝白风格重建，内容均来自演示数据，仅供学习交流。'}</p>
          <p>{footerCfg?.text || `${siteName} · 源站 pilishuwu.com（重建模板）`}</p>
        </div>
      </footer>

      <HistoryPanel
        open={histOpen}
        onClose={() => setHistOpen(false)}
        navigate={navigate}
        accent="#3B76A8"
      />
    </div>
  )
}

/* ==================================================================== */
/* Home：左 700 主栏（强推 2×2 / 热门 / 最新更新）+ 右 260 榜单侧栏        */
/* ==================================================================== */

type RankKey = 'clicks' | 'updates' | 'finished'

function HomeView({ navigate }: ViewProps) {
  const { data, isLoading, isError, refetch } = useHomeData()
  const [rank, setRank] = useState<RankKey>('clicks')

  if (isLoading) {
    return (
      <div className="mx-auto grid max-w-[980px] gap-3 px-2 py-4 md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-3">
          <SkeletonBlock rows={7} />
          <SkeletonBlock rows={5} />
          <SkeletonBlock rows={9} />
        </div>
        <div className="min-w-0 space-y-3">
          <SkeletonBlock rows={3} />
          <SkeletonBlock rows={8} />
          <SkeletonBlock rows={6} />
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

  const rankMap: Record<RankKey, typeof data.rankings.clicks> = {
    clicks: data.rankings.clicks,
    updates: data.rankings.updates,
    finished: data.rankings.finished,
  }

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_260px]">
        {/* ============ 左主栏 ============ */}
        <div className="min-w-0 space-y-3">
          {/* 封面强推网格 2×2 */}
          <Block title="本周强推" extra={<span>编辑每日精选</span>} bodyClass="p-2.5">
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {data.featured.slice(0, 4).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => navigate({ name: 'book', novelId: n.id })}
                  className="group flex cursor-pointer gap-3 border border-transparent p-1 text-left transition-colors hover:border-[#BFD8EA] hover:bg-[#F7FBFF]"
                >
                  <Cover novel={n} className="h-[150px] w-[120px] text-5xl" charClass="text-5xl" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-bold text-[#3366BB] group-hover:text-[#FF6600]">
                      {n.title}
                    </span>
                    <span className="mt-0.5 truncate text-[11px] text-[#999]">
                      {n.author} · {n.categoryName} · {statusText(n.status)}
                    </span>
                    <span className="mt-1 line-clamp-4 text-xs leading-5 text-[#666]">{n.description}</span>
                    <span className="mt-auto pt-1 text-[11px] text-[#CC0000]">
                      {formatWords(n.wordCount)}字 · {formatWords(n.clicks)}点击
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </Block>

          {/* 热门小说（双栏序号列表） */}
          <Block title="热门小说" extra={<span>按全站点击排序</span>} bodyClass="px-3 py-2">
            <div className="grid gap-x-6 sm:grid-cols-2">
              {data.hot.slice(0, 10).map((n, i) => (
                <div
                  key={n.id}
                  className="flex items-baseline gap-2 border-b border-dotted border-[#D5E6F3] py-[6px] text-xs last:border-b-0 sm:last:border-b"
                >
                  <span
                    className={cn(
                      'w-4 shrink-0 text-center font-bold',
                      i < 3 ? 'text-[#CC0000]' : 'text-[#8FB4D4]',
                    )}
                  >
                    {i + 1}.
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate({ name: 'book', novelId: n.id })}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-[#3366BB] hover:text-[#FF6600] hover:underline"
                  >
                    {n.title}
                  </button>
                  <span className="shrink-0 text-[10px] text-[#999]">{n.author}</span>
                </div>
              ))}
            </div>
          </Block>

          {/* 最新更新：五段式表格式行 */}
          <Block
            title="最新更新"
            extra={
              <button
                type="button"
                onClick={() => navigate({ name: 'category' })}
                className="cursor-pointer text-[11px] text-[#3366BB] hover:text-[#FF6600]"
              >
                更多»
              </button>
            }
            bodyClass="px-2 py-1"
          >
            {data.latest.slice(0, 15).map((n) => (
              <UpdateRow key={n.id} novel={n} navigate={navigate} />
            ))}
          </Block>
        </div>

        {/* ============ 右侧栏 260px ============ */}
        <aside className="min-w-0 space-y-3">
          {/* 站点统计 */}
          <Block title="站点数据" bodyClass="p-3">
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs text-[#666]">
              <div>
                收录小说：<b className="text-[#CC0000]">{data.stats.novelCount}</b> 部
              </div>
              <div>
                收录章节：<b className="text-[#CC0000]">{formatWords(data.stats.chapterCount)}</b>
              </div>
              <div>
                总字数：<b className="text-[#CC0000]">{formatWords(data.stats.totalWordCount)}</b>
              </div>
              <div>
                今日更新：<b className="text-[#CC0000]">{data.stats.todayUpdates}</b> 章
              </div>
            </dl>
          </Block>

          {/* 排行榜（点击/更新/完本 三标签） */}
          <Block title="排行榜" bodyClass="p-2.5">
            <div className="mb-2 flex border border-[#BFD8EA] text-xs">
              {(
                [
                  ['clicks', '点击榜'],
                  ['updates', '更新榜'],
                  ['finished', '完本榜'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setRank(k)}
                  className={cn(
                    'flex-1 cursor-pointer py-1 text-center transition-colors',
                    rank === k
                      ? 'bg-[#3B76A8] font-bold text-white'
                      : 'bg-[#F7FBFF] text-[#3366BB] hover:bg-[#EAF3FB]',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <RankList novels={rankMap[rank]} navigate={navigate} limit={10} />
          </Block>

          {/* 最新入库 */}
          <Block title="最新入库" bodyClass="px-2.5 py-1">
            {data.latest.slice(0, 8).map((n) => (
              <div
                key={n.id}
                className="flex items-center justify-between gap-2 border-b border-dotted border-[#DCE9F5] py-[5px] text-xs last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => navigate({ name: 'book', novelId: n.id })}
                  className="min-w-0 flex-1 cursor-pointer truncate text-left text-[#3366BB] hover:text-[#FF6600] hover:underline"
                >
                  {n.title}
                </button>
                <span className="shrink-0 text-[10px] text-[#999]">{formatDate(n.updatedAt).slice(5)}</span>
              </div>
            ))}
          </Block>

          {/* 友情链接（静态文字位） */}
          <Block title="友情链接" bodyClass="p-2.5">
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-[#8AA6C0]">
              <span>中文网文聚合</span>
              <span>·</span>
              <span>经典阅读导航</span>
              <span>·</span>
              <span>书友交流社区</span>
              <span>·</span>
              <span>精品完本库</span>
            </p>
          </Block>
        </aside>
      </div>
    </div>
  )
}

/* ==================================================================== */
/* Category：面包屑 + 排序筛选 + 六段式列表 + 分页                        */
/* ==================================================================== */

type SortKey = 'latest' | 'clicks' | 'words'
type StatusKey = 'all' | 'serial' | 'finished'

function CategoryView({
  navigate,
  categoryId,
  page = 1,
}: ViewProps & { categoryId?: number; page?: number }) {
  const { data: cats } = useCategories()
  const [sort, setSort] = useState<SortKey>('latest')
  const [status, setStatus] = useState<StatusKey>('all')
  const cur = page > 0 ? page : 1

  const { data, isLoading, isError, refetch } = useNovels({
    categoryId,
    page: cur,
    pageSize: 20,
    sort,
    status: status === 'all' ? undefined : status,
  })

  const catName =
    categoryId != null ? (cats ?? []).find((c) => c.id === categoryId)?.name : undefined
  const goPage = (p: number) => navigate({ name: 'category', categoryId, page: p })
  const changeSort = (s: SortKey) => {
    setSort(s)
    if (cur !== 1) goPage(1)
  }
  const changeStatus = (s: StatusKey) => {
    setStatus(s)
    if (cur !== 1) goPage(1)
  }

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      <Crumbs
        items={[
          { label: '首页', view: { name: 'home' } },
          { label: catName ?? '全部小说' },
        ]}
        navigate={navigate}
      />
      <Block
        className="mt-3"
        title={`${catName ?? '全部小说'}列表`}
        extra={
          <span>
            共 {data?.total ?? '—'} 部 · 第 {cur}/{data?.totalPages ?? 1} 页
          </span>
        }
        bodyClass="px-2 py-1"
      >
        {/* 排序 / 状态筛选行 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dotted border-[#D5E6F3] px-1 pb-2 text-xs">
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
              onClick={() => changeSort(k)}
              className={cn(
                'cursor-pointer',
                sort === k ? 'font-bold text-[#CC0000]' : 'text-[#3366BB] hover:text-[#FF6600]',
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
              onClick={() => changeStatus(k)}
              className={cn(
                'cursor-pointer',
                status === k ? 'font-bold text-[#CC0000]' : 'text-[#3366BB] hover:text-[#FF6600]',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {isLoading ? (
          <SkeletonLines className="py-4" rows={10} />
        ) : isError ? (
          <div className="py-6">
            <ErrorBox onRetry={() => refetch()} />
          </div>
        ) : data && data.list.length > 0 ? (
          <>
            {data.list.map((n) => (
              <ResultRow key={n.id} novel={n} navigate={navigate} />
            ))}
            <Pager page={cur} totalPages={data.totalPages} onPage={goPage} />
          </>
        ) : (
          <p className="py-10 text-center text-sm text-[#999]">该分类下暂无小说，换个条件试试～</p>
        )}
      </Block>
    </div>
  )
}

/* ==================================================================== */
/* Book：信息卡（封面左 + 键值行 + 按钮行）+ 简介 + 最新章节               */
/* ==================================================================== */

/* ---- 书架（localStorage 持久化，跨视图/跨会话一致） ---- */

const SHELF_KEY = 'pls-shelf'

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
        <div aria-hidden className="animate-pulse border border-[#BFD8EA] bg-white p-4">
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="h-[150px] w-[120px] shrink-0 self-center bg-[#E4EEF7] sm:self-start" />
            <div className="flex-1 space-y-3 pt-1">
              <div className="h-5 w-1/3 bg-[#E4EEF7]" />
              <div className="h-3 w-2/3 bg-[#E4EEF7]" />
              <div className="h-3 w-1/2 bg-[#E4EEF7]" />
              <div className="h-8 w-52 bg-[#E4EEF7]" />
            </div>
          </div>
        </div>
        <SkeletonBlock className="mt-3" rows={5} />
        <SkeletonBlock className="mt-3" rows={6} />
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
      <Crumbs
        items={[
          { label: '首页', view: { name: 'home' } },
          { label: n.categoryName, view: { name: 'category', categoryId: n.categoryId } },
          { label: n.title },
        ]}
        navigate={navigate}
      />

      {/* 信息卡：封面左 120×150 + 信息右 */}
      <div className="mt-3 border border-[#BFD8EA] bg-white p-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          <Cover novel={n} className="h-[150px] w-[120px] self-center text-5xl sm:self-start" charClass="text-5xl" />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold leading-snug text-[#333]">{n.title}</h1>
            <p className="mt-1 text-xs text-[#999]">
              作者：{n.author} · {n.categoryName} · {statusText(n.status)}
            </p>
            <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-[#666] sm:grid-cols-3">
              <li>字数：{formatWords(n.wordCount)} 字</li>
              <li>章节：共 {n.totalChapters} 章</li>
              <li>点击：{formatWords(n.clicks)}</li>
              <li>更新：{formatDate(n.updatedAt)}</li>
              <li className="sm:col-span-2">
                最新：
                {n.lastChapterId ? (
                  <button
                    type="button"
                    onClick={() => navigate({ name: 'chapter', chapterId: n.lastChapterId as number })}
                    className="cursor-pointer text-[#3366BB] hover:text-[#FF6600] hover:underline"
                  >
                    {n.lastChapterTitle ?? '点击查看'}
                  </button>
                ) : (
                  <span className="text-[#999]">暂无</span>
                )}
              </li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  n.firstChapterId
                    ? navigate({ name: 'chapter', chapterId: n.firstChapterId })
                    : navigate({ name: 'toc', novelId })
                }
                className="cursor-pointer bg-[#3B76A8] px-5 py-1.5 text-sm text-white transition-colors hover:bg-[#2F6FA3]"
              >
                开始阅读
              </button>
              <button
                type="button"
                onClick={() => setShelf(toggleShelf(novelId))}
                className={cn(
                  'cursor-pointer border px-4 py-1.5 text-sm transition-colors',
                  shelf
                    ? 'border-[#3B76A8] bg-[#EAF3FB] text-[#2F5E8C]'
                    : 'border-[#BFD8EA] text-[#3366BB] hover:border-[#FF6600] hover:text-[#FF6600]',
                )}
              >
                {shelf ? '已在书架 ✓' : '加入书架'}
              </button>
              <button
                type="button"
                onClick={() => setVoted(true)}
                className="cursor-pointer border border-[#FF9900] px-4 py-1.5 text-sm text-[#FF9900] transition-colors hover:bg-[#FFF6E8]"
              >
                {voted ? '已投推荐票 +1' : '投推荐票'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 内容简介：浅底 + 缩进 2em */}
      <Block className="mt-3" title="内容简介" bodyClass="p-4">
        <p className="indent-[2em] text-sm leading-7 text-[#666]">
          {n.description || '作者尚未填写简介。'}
        </p>
      </Block>

      {/* 最近章节（全量章节末 12 条倒序 = 最新 12 章，新→旧，双栏） */}
      <Block
        className="mt-3"
        title="最新章节"
        extra={
          <button
            type="button"
            onClick={() => navigate({ name: 'toc', novelId })}
            className="cursor-pointer text-[11px] text-[#3366BB] hover:text-[#FF6600]"
          >
            查看完整目录 »
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
                className="flex cursor-pointer items-center justify-between gap-3 border-b border-dotted border-[#D5E6F3] py-[7px] text-xs hover:bg-[#F7FBFF]"
              >
                <span className="truncate text-[#3366BB] hover:text-[#FF6600]">{c.title}</span>
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
/* Toc：书头小卡 + 三栏章节列表（正序）                                   */
/* ==================================================================== */

function TocView({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel } = useNovel(novelId)
  const { data: chapters, isLoading, isError, refetch } = useChapters(novelId)
  const sorted = useMemo(() => [...(chapters ?? [])].sort((a, b) => a.idx - b.idx), [chapters])
  const firstId = sorted[0]?.id ?? novel?.firstChapterId ?? null

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      <Crumbs
        items={[
          { label: '首页', view: { name: 'home' } },
          ...(novel
            ? [{ label: novel.title, view: { name: 'book', novelId } as ThemeView }]
            : []),
          { label: '目录' },
        ]}
        navigate={navigate}
      />

      {/* 书头小卡 */}
      {novel ? (
        <div className="mt-3 flex gap-4 border border-[#BFD8EA] bg-white p-4">
          <Cover novel={novel} className="h-[120px] w-[90px] text-4xl" />
          <div className="min-w-0 flex-1 text-xs leading-6 text-[#666]">
            <button
              type="button"
              onClick={() => navigate({ name: 'book', novelId })}
              className="cursor-pointer text-base font-bold text-[#3366BB] hover:text-[#FF6600]"
            >
              《{novel.title}》
            </button>
            <p>
              作者：{novel.author} · {novel.categoryName} · {statusText(novel.status)}
            </p>
            <p>
              共 {novel.totalChapters} 章 · {formatWords(novel.wordCount)}字 · 更新于{' '}
              {formatDate(novel.updatedAt)}
            </p>
            <button
              type="button"
              disabled={!firstId}
              onClick={() => firstId && navigate({ name: 'chapter', chapterId: firstId })}
              className={cn(
                'mt-2 px-5 py-1.5 text-sm text-white transition-colors',
                firstId
                  ? 'cursor-pointer bg-[#3B76A8] hover:bg-[#2F6FA3]'
                  : 'cursor-not-allowed bg-[#B9CFE2]',
              )}
            >
              开始阅读
            </button>
          </div>
        </div>
      ) : (
        <SkeletonBlock className="mt-3" rows={2} />
      )}

      {/* 最新章节（全书倒数 12 章，新→旧） */}
      {sorted.length > 0 && (
        <Block className="mt-3" title={`最新章节（最近更新 12 章 · 新→旧）`} bodyClass="p-2">
          <div className="grid gap-x-5 sm:grid-cols-2 lg:grid-cols-3">
            {[...sorted].slice(-12).reverse().map((c) => (
              <button
                key={`latest-${c.id}`}
                type="button"
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                title={c.title}
                className="flex cursor-pointer items-baseline justify-between gap-2 border-b border-dotted border-[#D5E6F3] px-1 py-[7px] text-xs hover:bg-[#F7FBFF]"
              >
                <span className="truncate text-[#3366BB] hover:text-[#FF6600] hover:underline">
                  {c.idx}. {c.title}
                </span>
                <span className="shrink-0 text-[10px] text-[#BBB]">{formatWords(c.wordCount)}字</span>
              </button>
            ))}
          </div>
        </Block>
      )}

      {/* 三栏章节列表 */}
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
          <div className="grid gap-x-5 sm:grid-cols-2 lg:grid-cols-3">
            {sorted.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                title={c.title}
                className="flex cursor-pointer items-baseline justify-between gap-2 border-b border-dotted border-[#D5E6F3] px-1 py-[7px] text-xs hover:bg-[#F7FBFF]"
              >
                <span className="truncate text-[#3366BB] hover:text-[#FF6600] hover:underline">
                  {c.idx}. {c.title}
                </span>
                <span className="shrink-0 text-[10px] text-[#BBB]">{formatWords(c.wordCount)}字</span>
              </button>
            ))}
          </div>
        )}
      </Block>
    </div>
  )
}

/* ==================================================================== */
/* Chapter：面包屑 + 章首/章尾双份上下章导航 + 85% 正文 + 阅读设置          */
/* ==================================================================== */

/* 场景配色（护眼=绿纸面，与其它主题一致） */
const SCENES: Record<string, ReaderSceneColors> = {
  day: { page: '', paper: '#ffffff', ink: '#333333', muted: '#999999', line: '#BFD8EA' },
  paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#d4c5a3' },
  green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', muted: '#8fa590', line: '#bcd4bc' },
  blue: { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', muted: '#8fa2b0', line: '#b8cede' },
  night: { page: '#1e2024', paper: '#26262b', ink: '#c0c0c6', muted: '#8a8a92', line: '#3a3a42' },
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
  const base = 'cursor-pointer border px-5 py-1.5 text-sm transition-colors'
  const on =
    'border-[#BFD8EA] bg-white text-[#3366BB] hover:border-[#3B76A8] hover:bg-[#EAF3FB] hover:text-[#FF6600]'
  const off = 'cursor-not-allowed border-[#E3EEF7] bg-[#F7FBFF] text-[#BBB]'
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
        上一章
      </button>
      <button type="button" onClick={() => navigate({ name: 'toc', novelId: ch.novelId })} className={cn(base, on)}>
        目 录
      </button>
      <button
        type="button"
        disabled={!ch.nextId}
        onClick={() => {
          if (ch.nextId) navigate({ name: 'chapter', chapterId: ch.nextId })
        }}
        className={cn(base, ch.nextId ? on : off)}
      >
        下一章
      </button>
    </div>
  )
}

function ChapterView({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const { data: ch, isLoading, isError, refetch } = useChapter(chapterId)
  const { data: home } = useHomeData()
  const [prefs] = useReaderPrefs()

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

  /* 键盘 ←/→ 翻章（焦点在输入框/下拉/按钮上时不触发，避免误触与双重导航） */
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
        <div className="border border-[#BFD8EA] bg-white px-6 py-8">
          <div aria-hidden className="animate-pulse space-y-4">
            <div className="mx-auto h-6 w-1/2 bg-[#E4EEF7]" />
            <div className="mx-auto h-4 w-1/3 bg-[#E4EEF7]" />
            <SkeletonLines rows={12} className="pt-2" />
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

  const hot = (home?.rankings.clicks ?? []).slice(0, 6)
  const eye = prefs.scene === 'green'

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      <Crumbs
        items={[
          { label: '首页', view: { name: 'home' } },
          { label: ch.novelTitle, view: { name: 'book', novelId: ch.novelId } },
          { label: ch.title },
        ]}
        navigate={navigate}
      />

      <div
        className="mt-3 border px-4 py-6 transition-colors sm:px-8"
        style={{ background: scene.paper, borderColor: scene.line }}
      >
        <h1 className="text-center text-xl font-bold text-[#333]">{ch.title}</h1>
        <p className="mt-1 text-center text-xs text-[#999]">
          第 {ch.idx} 章 · 约 {formatWords(ch.wordCount)} 字
        </p>

        {/* 章首导航 */}
        <ChapterNav ch={ch} navigate={navigate} className="mt-4" />

        {/* 阅读工具条：字号 / 行距 / 背景 / 护眼 / 字体 / 字色（跨主题共享同一份偏好） */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, -1) })}
            disabled={prefs.fontSize <= 14}
            className={cn(
              'border px-2 py-0.5 transition-colors',
              prefs.fontSize <= 14
                ? 'cursor-not-allowed border-[#E3EEF7] text-[#BBB]'
                : 'cursor-pointer border-[#BFD8EA] text-[#3366BB] hover:border-[#FF6600] hover:text-[#FF6600]',
            )}
          >
            A-
          </button>
          <button
            type="button"
            onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, 1) })}
            disabled={prefs.fontSize >= 28}
            className={cn(
              'border px-2 py-0.5 transition-colors',
              prefs.fontSize >= 28
                ? 'cursor-not-allowed border-[#E3EEF7] text-[#BBB]'
                : 'cursor-pointer border-[#BFD8EA] text-[#3366BB] hover:border-[#FF6600] hover:text-[#FF6600]',
            )}
          >
            A+
          </button>
          <span className="text-[#999]">{prefs.fontSize}px</span>
          {READER_LINE_HEIGHTS.map((lh) => (
            <button
              key={lh}
              type="button"
              onClick={() => setReaderPrefs({ lineHeight: lh })}
              className={cn(
                'border px-2 py-0.5 transition-colors',
                prefs.lineHeight === lh
                  ? 'border-[#3B76A8] bg-[#EAF3FB] text-[#2F5E8C]'
                  : 'cursor-pointer border-[#BFD8EA] text-[#3366BB] hover:border-[#FF6600] hover:text-[#FF6600]',
              )}
            >
              行距 {lh.toFixed(1)}
            </button>
          ))}
          <span className="flex items-center gap-1.5">
            背景
            {READER_SCENES.map((s) => (
              <button
                key={s.key}
                type="button"
                title={s.label}
                aria-label={`背景：${s.label}`}
                onClick={() => setReaderPrefs({ scene: s.key })}
                className={cn(
                  'h-4 w-4 cursor-pointer rounded-full border transition-all',
                  prefs.scene === s.key ? 'scale-110 border-[#FF6600]' : 'border-black/25',
                )}
                style={{ background: SCENES[s.key].paper }}
              />
            ))}
          </span>
          <button
            type="button"
            onClick={() => setReaderPrefs({ scene: eye ? 'day' : 'green' })}
            className={cn(
              'cursor-pointer border px-2 py-0.5 transition-colors',
              eye
                ? 'border-[#3B76A8] bg-[#EAF3FB] text-[#2F5E8C]'
                : 'border-[#BFD8EA] text-[#3366BB] hover:border-[#FF6600] hover:text-[#FF6600]',
            )}
          >
            {eye ? '恢复白底' : '护眼模式'}
          </button>
          <select
            value={prefs.font}
            onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
            className="cursor-pointer border border-[#BFD8EA] bg-white px-1 py-0.5 text-xs text-[#3366BB] outline-none"
          >
            <option value="default">默认字体</option>
            <option value="song">宋体</option>
            <option value="hei">黑体</option>
            <option value="kai">楷体</option>
          </select>
          <select
            value={prefs.ink}
            onChange={(e) => setReaderPrefs({ ink: e.target.value })}
            aria-label="字色"
            className="cursor-pointer border border-[#BFD8EA] bg-white px-1 py-0.5 text-xs text-[#3366BB] outline-none"
          >
            {READER_INKS.map((c) => (
              <option key={c.k} value={c.v}>{c.k}</option>
            ))}
          </select>
        </div>

        {/* 正文：居中 85% 宽，缩进 2em，字号/行距/字体可调 */}
        <article className="mx-auto mt-5 w-[92%] max-w-[820px] break-words md:w-[85%]">
          {paras.length === 0 ? (
            /* 两阶段采集：章节骨架先入库、正文异步回填——content 为空/纯空白时渲染占位 */
            <div className="py-8 text-center">
              <p className="text-sm font-bold text-[#CC0000]">章节内容正在采集中，请稍后刷新重试。</p>
              <p className="mt-1.5 text-xs" style={{ color: scene.muted }}>
                正文回填需要一点时间；也可以先返回目录阅读其他章节。
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-4 cursor-pointer bg-[#3B76A8] px-5 py-1.5 text-sm text-white transition-colors hover:bg-[#2F6FA3]"
              >
                刷新本页
              </button>
            </div>
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
          <p className="mt-6 text-center text-[11px]" style={{ color: scene.muted }}>键盘 ← / → 也可翻章</p>
        </article>

        {/* 章尾导航 */}
        <ChapterNav ch={ch} navigate={navigate} className="mt-6" />

        {/* 热门推荐行 */}
        {hot.length > 0 && (
          <p className="mt-6 border-t border-dotted border-[#D5E6F3] pt-3 text-center text-xs leading-6">
            <span className="mr-2 font-bold text-[#CC0000]">热门推荐</span>
            {hot.map((n, i) => (
              <span key={n.id}>
                {i > 0 && <span className="mx-1 text-[#C9DEEF]">·</span>}
                <button
                  type="button"
                  onClick={() => navigate({ name: 'book', novelId: n.id })}
                  className="cursor-pointer text-[#3366BB] hover:text-[#FF6600] hover:underline"
                >
                  {n.title}
                </button>
              </span>
            ))}
          </p>
        )}
      </div>

      {/* 返回顶部挂件 */}
      <button
        type="button"
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        title="返回顶部"
        className="fixed bottom-24 right-3 z-40 hidden h-9 w-9 cursor-pointer items-center justify-center border border-[#BFD8EA] bg-white text-xs text-[#3B76A8] shadow-sm hover:bg-[#EAF3FB] md:flex"
      >
        顶部
      </button>
    </div>
  )
}

/* ==================================================================== */
/* Search：本地输入 + 结果列表 + 本地分页                                 */
/* ==================================================================== */

/* 外层按 query 重挂载内层：query 变化时自动重置草稿与页码（无需 effect） */
function SearchView({ navigate, siteName, query }: ViewProps & { query: string }) {
  return <SearchInner key={query} navigate={navigate} siteName={siteName} query={query} />
}

function SearchInner({ navigate, query }: ViewProps & { query: string }) {
  const [kw, setKw] = useState(query)
  const [page, setPage] = useState(1)

  const { data, isLoading, isError, refetch } = useNovels({ q: query || undefined, page, pageSize: 20 })

  const submit = () => {
    const t = kw.trim()
    if (t) navigate({ name: 'search', query: t })
  }

  return (
    <div className="mx-auto w-full max-w-[980px] px-2 py-3">
      {/* 搜索面板 */}
      <div className="flex flex-wrap items-center gap-2 border border-[#BFD8EA] bg-white p-3">
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="输入书名 / 作者关键词"
          className="h-8 min-w-0 flex-1 border border-[#BFD8EA] px-2 text-sm outline-none focus:border-[#3B76A8]"
        />
        <button
          type="button"
          onClick={submit}
          className="h-8 cursor-pointer bg-[#3B76A8] px-4 text-sm text-white transition-colors hover:bg-[#2F6FA3]"
        >
          搜 索
        </button>
      </div>

      <p className="mt-2 text-xs text-[#999]">
        搜索“<span className="text-[#CC0000]">{query || '…'}</span>”
        {data ? `，共找到 ${data.total} 条结果` : ''}
      </p>

      <Block className="mt-2" title="搜索结果" bodyClass="px-2 py-1">
        {isLoading ? (
          <SkeletonLines className="py-4" rows={8} />
        ) : isError ? (
          <div className="py-4">
            <ErrorBox onRetry={() => refetch()} />
          </div>
        ) : data && data.list.length > 0 ? (
          <>
            {data.list.map((n) => (
              <ResultRow key={n.id} novel={n} navigate={navigate} />
            ))}
            <Pager page={page} totalPages={data.totalPages} onPage={setPage} />
          </>
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
  id: 'pilishuwu',
  name: '飞速小说',
  source: 'pilishuwu.com',
  description:
    '经典杰奇蓝白系重建：980px 定宽、深蓝导航、block+标题条结构，首页强推 2×2 封面网格 + 五段式更新表 + 右侧三榜排行；正文页 85% 宽、章首章尾双导航、字号/护眼切换。',
  swatch: ['#1e50a2', '#e8f0fe'],
  Layout,
  Home: HomeView,
  Category: CategoryView,
  Book: BookView,
  Toc: TocView,
  Chapter: ChapterView,
  Search: SearchView,
}

export default theme
