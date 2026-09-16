'use client'

// ==================== 101kks 六视图 ====================
// Home：搜索门户（Hero 搜索 + 4 蓝按钮 + 热门书单卡 3 列 + 标签云）
// Category：分类药丸 + 封面网格 + 点击排行行列表 + 分页
// Book：66/32 两列（信息盒 + 选项卡盒 | 本周最強排行）
// Toc：单列白卡 + 蓝竖条节标题 + 三栏章节列表 + 正序/倒序
// Chapter：独立沉浸式阅读器（工具行 + 设置面板 + 4 等分翻页条 + 夜间）
// Search：门户式搜索 + 结果网格

import { useEffect, useMemo, useState } from 'react'
import {
  AlignLeft,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  BookOpen,
  Bookmark,
  CheckCircle2,
  Clock3,
  Flame,
  Library,
  List,
  Minus,
  Moon,
  Plus,
  Search,
  SearchX,
  Settings2,
  Star,
  UserRound,
  X,
} from 'lucide-react'
import { useCategories, useChapter, useChapters, useHomeData, useNovel, useNovels } from '@/hooks/use-novel-data'
import { cn } from '@/lib/utils'
import type { NovelListItem } from '@/lib/types'
import type { ThemeView, ViewProps } from '../types'
import {
  ACCENT_RED,
  BlueBtn,
  BlueTag,
  BookSkeleton,
  ChapterSkeleton,
  Container,
  CoverCard,
  CoverFace,
  ErrorRetry,
  GridSkeleton,
  MyBox,
  Pager,
  SectionTitle,
  fmtDate,
  fmtWords,
  loadBookmarks,
  loadShelf,
  saveBookmark,
  setCategoryIntent,
  takeCategoryIntent,
  toggleShelf,
} from './ui'

// ---------- 工具 ----------

function statusLabel(s: 'serial' | 'finished'): string {
  return s === 'finished' ? '完結' : '連載'
}

/** 標籤雲詞庫（原创常用题材词） */
const TAGS = [
  '玄幻', '仙俠', '都市', '言情', '歷史', '軍事', '科幻', '遊戲', '懸疑', '靈異',
  '同人', '輕小說', '穿越', '重生', '系統', '修真', '校園', '職場', '豪門', '宮鬥',
  '種田', '甜寵', '虐戀', '總裁', '贅婿', '戰神', '醫妃', '團寵', '馬甲', '無限流',
  '規則怪談', '基建', '經營', '美食', '直播', '電競', '衍生', '快穿', '末世', '盜墓',
].filter((t) => t.trim().length > 1)

// ==================== Home ====================

export function HomeView({ navigate, siteName }: ViewProps) {
  const { data, isLoading, isError, refetch } = useHomeData()
  const [q, setQ] = useState('')

  const booklist = useMemo(() => (data?.hot ?? []).slice(0, 6), [data])
  const allTags = useMemo(() => {
    const catNames = (data?.categories ?? []).map((c) => c.name)
    return [...catNames, ...TAGS].slice(0, 60)
  }, [data])

  if (isError) return <Container className="py-6"><ErrorRetry onRetry={() => refetch()} /></Container>

  const goCategory = (intent: Parameters<typeof setCategoryIntent>[0]) => {
    setCategoryIntent(intent)
    navigate({ name: 'category', page: 1 })
  }

  return (
    <Container className="space-y-4 py-4">
      {/* 搜索 Hero 盒 */}
      <MyBox>
        <div className="flex h-[110px] items-center justify-center sm:h-[150px]">
          <h1 className="text-center text-3xl font-black tracking-widest text-[#1f6cb2] sm:text-4xl">
            {siteName}
            <span className="mt-1 block text-xs font-medium tracking-normal text-[#888] sm:text-sm">
              藍白工具風 · 搜一搜，好書即刻到手
            </span>
          </h1>
        </div>
        {/* 大圆角搜索框 */}
        <form
          className="flex h-[50px] items-center rounded-[25px] border border-[#dce9f5] bg-white px-5 shadow-[0_2px_10px_rgba(31,108,178,.18)]"
          onSubmit={(e) => {
            e.preventDefault()
            navigate({ name: 'search', query: q.trim() })
          }}
        >
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="輸入書名 / 作者關鍵字"
            className="h-full min-w-0 flex-1 bg-transparent text-base text-[#333] outline-none placeholder:text-[#b8c4cf]"
          />
          <button type="submit" aria-label="搜尋" className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#1f6cb2] transition-colors hover:bg-[#e8f4ff]">
            <Search className="h-5 w-5" />
          </button>
        </form>
        {/* 4 枚蓝色快捷按钮 */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: '小說分類', icon: Library, go: () => goCategory(null) },
            { label: '熱門排行', icon: Flame, go: () => goCategory({ sort: 'clicks' }) },
            { label: '完本小說', icon: CheckCircle2, go: () => goCategory({ status: 'finished' }) },
            { label: '最新上架', icon: Clock3, go: () => goCategory({ sort: 'latest' }) },
          ].map((b) => {
            const Icon = b.icon
            return (
              <button
                key={b.label}
                type="button"
                onClick={b.go}
                className="flex h-[50px] cursor-pointer items-center justify-center gap-2 rounded-[10px] bg-[#1f6cb2] text-[15px] text-white transition-all hover:bg-[#06c] hover:shadow-[0_3px_8px_rgba(0,0,0,.2)]"
              >
                <Icon className="h-4.5 w-4.5" />
                {b.label}
              </button>
            )
          })}
        </div>
      </MyBox>

      {/* 熱門書單推薦 */}
      <MyBox>
        <SectionTitle>熱門書單推薦</SectionTitle>
        {isLoading ? (
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[128px] animate-pulse rounded-[3px] bg-[#e9ecef]" />
            ))}
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
            {booklist.map((n) => (
              <BooklistCard key={n.id} novel={n} onClick={() => navigate({ name: 'book', novelId: n.id })} />
            ))}
          </div>
        )}
      </MyBox>

      {/* 標籤雲 */}
      <MyBox>
        <SectionTitle>熱門標籤</SectionTitle>
        <div className="mt-3 flex flex-wrap gap-2">
          {allTags.map((t) => (
            <BlueTag key={t} onClick={() => navigate({ name: 'search', query: t })}>
              {t}
            </BlueTag>
          ))}
        </div>
      </MyBox>
    </Container>
  )
}

/** 书单卡：128px 横向两段式（紫渐变封面区 + 信息列） */
function BooklistCard({ novel, onClick }: { novel: NovelListItem; onClick: () => void }) {
  // 由 id 确定性生成 3 张迷你渐变封面
  const tokens = [0, 4, 7].map((o) => `g${((novel.id + o) % 12) + 1}`)
  return (
    <div
      onClick={onClick}
      className="flex h-[128px] cursor-pointer select-none overflow-hidden rounded-[3px] bg-white shadow-[0_1px_3px_rgba(0,0,0,.12),0_1px_2px_rgba(0,0,0,.24)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(0,0,0,.2)]"
    >
      {/* 左 120px 紫渐变封面区：3 张 50×70 封面叠放 + 计数角标 */}
      <div className="relative flex w-[120px] shrink-0 items-center justify-center gap-1 bg-gradient-to-br from-[#667eea] to-[#764ba2]">
        {tokens.map((t, i) => (
          <div
            key={i}
            className={cn(
              'h-[64px] w-[44px] overflow-hidden rounded-[2px] shadow-md',
              i === 1 && 'h-[70px] w-[48px]',
            )}
          >
            <CoverFace title={novel.title} cover={t} className="h-full w-full" charClass="text-lg" />
          </div>
        ))}
        <span className="absolute right-1.5 top-1.5 rounded-[2px] bg-black/45 px-1.5 py-0.5 text-[10px] text-white">
          +{novel.chapterCount}
        </span>
      </div>
      {/* 右侧信息列 */}
      <div className="flex min-w-0 flex-1 flex-col p-3">
        <p className="truncate text-[15px] font-bold text-[#333] transition-colors hover:text-[#06c]">{novel.title}</p>
        <div className="mt-1.5 space-y-1 text-xs text-[#888]">
          <p className="flex items-center gap-1.5">
            <Flame className="h-3.5 w-3.5 shrink-0 text-[#1f6cb2]" />
            熱度 {novel.clicks}
          </p>
          <p className="flex items-center gap-1.5">
            <Library className="h-3.5 w-3.5 shrink-0 text-[#1f6cb2]" />
            收錄 {novel.chapterCount} 章
          </p>
          <p className="flex items-center gap-1.5">
            <UserRound className="h-3.5 w-3.5 shrink-0 text-[#1f6cb2]" />
            {novel.author}
          </p>
        </div>
        <p className="mt-auto line-clamp-2 text-xs leading-4 text-[#888]">{novel.description}</p>
      </div>
    </div>
  )
}

// ==================== Category ====================

export function CategoryView({
  navigate,
  categoryId,
  page = 1,
}: ViewProps & { categoryId?: number; page?: number }) {
  const { data: categories } = useCategories()
  const [sort, setSort] = useState<'latest' | 'clicks' | 'words'>('latest')
  const [status, setStatus] = useState<'serial' | 'finished' | undefined>(undefined)

  // 消费首页快捷按钮 / 导航注入的初始筛选意图（渲染期一次性消费，替代 effect）
  const [intentKey, setIntentKey] = useState<string | null>(null)
  const curIntentKey = `${String(categoryId)}:${String(page)}`
  if (intentKey !== curIntentKey) {
    setIntentKey(curIntentKey)
    const intent = takeCategoryIntent()
    if (intent) {
      setSort(intent.sort ?? 'latest')
      setStatus(intent.status)
    }
  }

  const { data, isLoading, isError, refetch } = useNovels({ categoryId, page, pageSize: 20, sort, status })
  const rank = useNovels({ categoryId, page: 1, pageSize: 10, sort: 'clicks' })

  const catName = categories?.find((c) => c.id === categoryId)?.name ?? '全部分類'

  return (
    <Container className="space-y-4 py-4">
      {/* 白卡一：分类 + 筛选 */}
      <MyBox>
        <SectionTitle>小說分類</SectionTitle>
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
          <BlueTag active={!categoryId} onClick={() => navigate({ name: 'category', page: 1 })}>
            全部分類
          </BlueTag>
          {(categories ?? []).map((c) => (
            <BlueTag
              key={c.id}
              active={categoryId === c.id}
              onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
            >
              {c.name}
            </BlueTag>
          ))}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className="text-xs text-[#888]">排序</span>
          {(
            [
              { key: 'latest', label: '最新更新' },
              { key: 'clicks', label: '點擊最多' },
              { key: 'words', label: '字數最多' },
            ] as const
          ).map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                setSort(o.key)
                if (page !== 1) navigate({ name: 'category', categoryId, page: 1 })
              }}
              className={cn(
                'cursor-pointer rounded-[3px] px-2 py-1 text-[13px] transition-colors hover:text-[#06c]',
                sort === o.key ? 'bg-[#e8f4ff] font-bold text-[#1f6cb2]' : 'text-[#666]',
              )}
            >
              {o.label}
            </button>
          ))}
          <span className="ml-2 text-xs text-[#888]">狀態</span>
          {(
            [
              { key: undefined, label: '全部' },
              { key: 'serial', label: '連載' },
              { key: 'finished', label: '完本' },
            ] as const
          ).map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => {
                setStatus(o.key)
                if (page !== 1) navigate({ name: 'category', categoryId, page: 1 })
              }}
              className={cn(
                'cursor-pointer rounded-[3px] px-2 py-1 text-[13px] transition-colors hover:text-[#06c]',
                status === o.key ? 'bg-[#e8f4ff] font-bold text-[#1f6cb2]' : 'text-[#666]',
              )}
            >
              {o.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-[#888]">
            {data ? `${catName} · 共 ${data.total} 部` : ''}
          </span>
        </div>
      </MyBox>

      {/* 封面卡网格 */}
      <MyBox>
        {isError ? (
          <ErrorRetry onRetry={() => refetch()} />
        ) : isLoading ? (
          <GridSkeleton />
        ) : data && data.list.length > 0 ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {data.list.map((n) => (
              <CoverCard key={n.id} novel={n} onClick={() => navigate({ name: 'book', novelId: n.id })} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center py-14 text-[#888]">
            <SearchX className="h-9 w-9" />
            <p className="mt-3 text-sm">該篩選條件下暫無收錄</p>
          </div>
        )}
        {data && data.list.length > 0 && (
          <Pager page={data.page} totalPages={data.totalPages} onGo={(p) => navigate({ name: 'category', categoryId, page: p })} />
        )}
      </MyBox>

      {/* 點擊排行列表（全宽横向小卡行） */}
      <MyBox>
        <SectionTitle>點擊排行</SectionTitle>
        <div className="mt-2">
          {(rank.data?.list ?? []).map((n, i) => (
            <div
              key={n.id}
              onClick={() => navigate({ name: 'book', novelId: n.id })}
              className="group flex cursor-pointer items-center gap-3 rounded-[3px] p-2 transition-colors hover:bg-[#f2f7fc]"
            >
              <span
                className={cn(
                  'w-6 shrink-0 text-center text-sm font-bold',
                  i < 3 ? 'text-[#e84118]' : 'text-[#888]',
                )}
              >
                {i + 1}
              </span>
              <CoverFace
                title={n.title}
                cover={n.cover}
                className="h-[80px] w-[60px] shrink-0 rounded-[3px]"
                charClass="text-xl"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] text-[#333] transition-colors group-hover:text-[#06c]">{n.title}</p>
                <p className="mt-0.5 truncate text-xs text-[#888]">{n.author}</p>
                <p className="mt-0.5 truncate text-xs text-[#757575]">
                  {n.categoryName} · {statusLabel(n.status)} · {fmtWords(n.wordCount)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </MyBox>
    </Container>
  )
}

// ==================== Book ====================

export function BookView({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isLoading, isError, refetch } = useNovel(novelId)
  const sideRank = useNovels({ sort: 'clicks', pageSize: 20 })
  const [shelf, setShelf] = useState(() => loadShelf().includes(novelId))
  const [votes, setVotes] = useState(0)
  const [tab, setTab] = useState<'toc' | 'intro' | 'review'>('toc')
  const [sideTab, setSideTab] = useState<'hot' | 'finished'>('hot')
  const [rating, setRating] = useState(0)

  const [shelfNovelId, setShelfNovelId] = useState(novelId)

  if (shelfNovelId !== novelId) {
    setShelfNovelId(novelId)
    setShelf(loadShelf().includes(novelId))
    setVotes(0)
    setTab('toc')
  }

  if (isError) return <Container className="py-6"><ErrorRetry onRetry={() => refetch()} /></Container>
  if (isLoading || !novel) return <Container className="py-6"><BookSkeleton /></Container>

  const sideList =
    sideTab === 'hot'
      ? (sideRank.data?.list ?? []).slice(0, 10)
      : (sideRank.data?.list ?? []).filter((n) => n.status === 'finished').slice(0, 10)

  return (
    <Container className="py-4">
      {/* 面包屑 */}
      <nav className="flex flex-wrap items-center gap-1.5 py-3 text-sm">
        <button type="button" onClick={() => navigate({ name: 'home' })} className="cursor-pointer text-[#1f6cb2] hover:text-[#06c]">
          首頁
        </button>
        <span className="text-[#bbb]">/</span>
        <button
          type="button"
          onClick={() => navigate({ name: 'category', categoryId: novel.categoryId, page: 1 })}
          className="cursor-pointer text-[#1f6cb2] hover:text-[#06c]"
        >
          {novel.categoryName}
        </button>
        <span className="text-[#bbb]">/</span>
        <span className="truncate text-[#666]">{novel.title}</span>
      </nav>

      {/* 66/32 两列 */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
        {/* 主栏 */}
        <div className="min-w-0 flex-1 space-y-4 lg:max-w-[66%]">
          {/* 盒一：书籍信息 */}
          <MyBox>
            <div className="flex flex-col gap-5 sm:flex-row">
              {/* 封面 180×240 + 角章 + 底部浮层 */}
              <div className="relative mx-auto w-[180px] shrink-0 sm:mx-0">
                <CoverFace
                  title={novel.title}
                  cover={novel.cover}
                  className="h-[240px] w-[180px] rounded-[3px] shadow-[0_4px_12px_rgba(0,0,0,.25)]"
                  charClass="text-6xl"
                />
                <span className="absolute left-0 top-2 w-[69px] bg-[#1f6cb2] py-1 text-center text-xs text-white">
                  {statusLabel(novel.status)}
                </span>
                <span className="absolute inset-x-0 bottom-0 rounded-b-[3px] bg-black/70 py-1 text-center text-xs text-white">
                  推薦 {novel.clicks + votes}
                </span>
              </div>
              {/* 信息列 */}
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-bold text-[#333]">{novel.title}</h1>
                <ul className="mt-3 space-y-1.5 text-[15px] text-[#757575]">
                  <li>
                    作者：
                    <button
                      type="button"
                      onClick={() => navigate({ name: 'search', query: novel.author })}
                      className="cursor-pointer text-[#1f6cb2] hover:text-[#06c]"
                    >
                      {novel.author}
                    </button>
                  </li>
                  <li>
                    分類：
                    <button
                      type="button"
                      onClick={() => navigate({ name: 'category', categoryId: novel.categoryId, page: 1 })}
                      className="cursor-pointer text-[#1f6cb2] hover:text-[#06c]"
                    >
                      {novel.categoryName}
                    </button>
                  </li>
                  <li>字數：{fmtWords(novel.wordCount)}</li>
                  <li>狀態：{statusLabel(novel.status)}</li>
                  <li>更新：{fmtDate(novel.updatedAt)}</li>
                </ul>
                {/* 按钮行：3 枚蓝底白字 */}
                <div className="mt-4 flex flex-wrap gap-1.5">
                  <BlueBtn
                    disabled={novel.firstChapterId == null}
                    onClick={() => novel.firstChapterId != null && navigate({ name: 'chapter', chapterId: novel.firstChapterId })}
                  >
                    開始閱讀
                  </BlueBtn>
                  <BlueBtn onClick={() => setShelf(toggleShelf(novel.id))}>
                    <Bookmark className={cn('h-4 w-4', shelf && 'fill-current')} />
                    {shelf ? '已在書架' : '加入書架'}
                  </BlueBtn>
                  <BlueBtn onClick={() => setVotes((v) => v + 1)}>
                    <Star className="h-4 w-4" />
                    {votes > 0 ? `已投 ${votes} 票` : '投推薦票'}
                  </BlueBtn>
                </div>
              </div>
            </div>
          </MyBox>

          {/* 盒二：标签 + 选项卡 */}
          <MyBox>
            <div className="flex flex-wrap gap-2">
              <BlueTag onClick={() => navigate({ name: 'category', categoryId: novel.categoryId, page: 1 })}>
                {novel.categoryName}
              </BlueTag>
              <BlueTag>{statusLabel(novel.status)}</BlueTag>
              {novel.isFeatured && <BlueTag>本站推薦</BlueTag>}
              {novel.isHot && <BlueTag>熱門</BlueTag>}
            </div>

            {/* 三选项卡 */}
            <div className="mt-4 flex gap-6 border-b border-black/10">
              {(
                [
                  { key: 'toc', label: '目錄', icon: List },
                  { key: 'intro', label: '簡介', icon: AlignLeft },
                  { key: 'review', label: '書評', icon: Star },
                ] as const
              ).map((t) => {
                const Icon = t.icon
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={cn(
                      '-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 pb-2 text-sm transition-colors',
                      tab === t.key
                        ? 'border-[#1f6cb2] font-bold text-[#1f6cb2]'
                        : 'border-transparent text-[#888] hover:text-[#333]',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {t.label}
                  </button>
                )
              })}
            </div>

            {tab === 'toc' && (
              <div className="mt-1">
                {novel.chapters.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 border-b border-black/5">
                    <button
                      type="button"
                      onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                      className="min-w-0 flex-1 cursor-pointer truncate py-2.5 text-left text-[15px] text-[#333] transition-colors hover:text-[#06c]"
                    >
                      {c.title}
                    </button>
                    <span className="shrink-0 text-xs text-[#888]">{fmtWords(c.wordCount)}</span>
                  </div>
                ))}
                <div className="mt-4 text-center">
                  <BlueBtn small onClick={() => navigate({ name: 'toc', novelId: novel.id })}>
                    完整目錄（{novel.totalChapters} 章）
                  </BlueBtn>
                </div>
              </div>
            )}

            {tab === 'intro' && (
              <div className="mt-4">
                <div className="grid grid-cols-2 rounded-[8px] bg-[#f4f4f4] py-3 text-center">
                  <div>
                    <p className="text-lg font-bold text-[#333]">{fmtWords(novel.wordCount)}</p>
                    <p className="text-xs text-[#888]">總字數</p>
                  </div>
                  <div>
                    <p className="text-lg font-bold text-[#333]">{novel.totalChapters} 章</p>
                    <p className="text-xs text-[#888]">章節數</p>
                  </div>
                </div>
                <p className="mt-4 whitespace-pre-line text-[15px] leading-relaxed text-[#333]">
                  {novel.description || '（作者還未填寫簡介）'}
                </p>
              </div>
            )}

            {tab === 'review' && (
              <div className="mt-4">
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setRating(s)}
                      aria-label={`${s} 星`}
                      className="cursor-pointer"
                    >
                      <Star
                        className={cn('h-5 w-5 transition-colors', s <= rating ? 'fill-[#f5a623] text-[#f5a623]' : 'text-[#ccc]')}
                      />
                    </button>
                  ))}
                  <span className="ml-2 text-sm text-[#888]">{rating > 0 ? `${rating}.0 分` : '點擊評分'}</span>
                </div>
                <textarea
                  placeholder="說點什麼吧…（演示模板，發表功能未開放）"
                  className="mt-3 h-24 w-full resize-none rounded-[3px] border border-black/15 p-2 text-sm text-[#333] outline-none focus:border-[#1f6cb2]"
                />
                <div className="mt-2 text-right">
                  <BlueBtn disabled>發表評論</BlueBtn>
                </div>
              </div>
            )}
          </MyBox>
        </div>

        {/* 右侧栏：本周最強 */}
        <aside className="w-full shrink-0 lg:w-[32%]">
          <MyBox>
            <SectionTitle>本週最強</SectionTitle>
            <div className="mt-3 flex gap-4 border-b border-black/10">
              {(
                [
                  { key: 'hot', label: '熱門' },
                  { key: 'finished', label: '完本' },
                ] as const
              ).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setSideTab(t.key)}
                  className={cn(
                    '-mb-px cursor-pointer border-b-2 pb-1.5 text-sm transition-colors',
                    sideTab === t.key
                      ? 'border-[#1f6cb2] font-bold text-[#1f6cb2]'
                      : 'border-transparent text-[#888] hover:text-[#333]',
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {sideList.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#888]">暫無數據</p>
            ) : (
              <div>
                {/* 第一条：大封面样式 */}
                <div
                  onClick={() => navigate({ name: 'book', novelId: sideList[0].id })}
                  className="group flex cursor-pointer gap-3 border-b border-black/10 py-3"
                >
                  <CoverFace
                    title={sideList[0].title}
                    cover={sideList[0].cover}
                    className="h-[120px] w-[90px] shrink-0 rounded-[3px]"
                    charClass="text-3xl"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 font-bold text-[#333] transition-colors group-hover:text-[#06c]">
                      {sideList[0].title}
                    </p>
                    <p className="mt-2 text-xs text-[#888]">{sideList[0].author}</p>
                    <p className="mt-1 text-xs text-[#757575]">
                      {sideList[0].categoryName} · {fmtWords(sideList[0].wordCount)}
                    </p>
                  </div>
                </div>
                {/* 其余纯文字行 */}
                {sideList.slice(1).map((n, i) => (
                  <div
                    key={n.id}
                    onClick={() => navigate({ name: 'book', novelId: n.id })}
                    className="group flex cursor-pointer items-center gap-2 border-b border-black/5 py-2.5 last:border-b-0"
                  >
                    <span className={cn('w-5 shrink-0 text-center text-sm font-bold', i < 2 ? 'text-[#e84118]' : 'text-[#888]')}>
                      {i + 2}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] text-[#333] transition-colors group-hover:text-[#06c]">{n.title}</p>
                      <p className="truncate text-xs text-[#888]">
                        {n.categoryName} · {n.author}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-[2px] px-1.5 py-0.5 text-[10px]',
                        n.status === 'finished' ? 'bg-[#e8f4ff] text-[#1f6cb2]' : 'border border-black/15 text-[#888]',
                      )}
                    >
                      {statusLabel(n.status)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </MyBox>
        </aside>
      </div>
    </Container>
  )
}

// ==================== Toc ====================

export function TocView({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isError, refetch } = useNovel(novelId)
  const { data: chapters, isLoading, isError: chError, refetch: refetchCh } = useChapters(novelId)
  const [asc, setAsc] = useState(true)
  /* 视图仅客户端挂载，惰性读 storage 恢复已存书签 */
  const [bookmark, setBookmark] = useState<{ chapterId: number; title: string } | null>(
    () => loadBookmarks()[String(novelId)] ?? null,
  )

  const [bmNovelId, setBmNovelId] = useState(novelId)

  if (bmNovelId !== novelId) {
    setBmNovelId(novelId)
    setBookmark(loadBookmarks()[String(novelId)] ?? null)
  }

  const err = isError || chError
  if (err) {
    return (
      <Container className="py-6">
        <ErrorRetry onRetry={() => { refetch(); refetchCh() }} />
      </Container>
    )
  }

  const list = asc ? (chapters ?? []) : [...(chapters ?? [])].reverse()

  return (
    <Container className="py-4">
      <MyBox className="min-h-[50vh]">
        {/* 标题行 + 正序/倒序切换 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => navigate({ name: 'book', novelId })}
              className="cursor-pointer text-left text-xl font-bold text-[#333] transition-colors hover:text-[#06c]"
            >
              {novel?.title ?? '目錄'}
            </button>
            <p className="mt-1 text-sm text-[#888]">
              {novel ? `${novel.author} · ${statusLabel(novel.status)} · 共 ${chapters?.length ?? novel.totalChapters} 章` : ''}
            </p>
          </div>
          <BlueBtn small onClick={() => setAsc((v) => !v)}>
            {asc ? <ArrowDownWideNarrow className="h-4 w-4" /> : <ArrowUpNarrowWide className="h-4 w-4" />}
            {asc ? '正序' : '倒序'}
          </BlueBtn>
        </div>

        {/* 書籤（阅读进度）节 */}
        {bookmark && (
          <>
            <h3 className="mt-5 flex items-center gap-2 border-l-4 border-[#1f6cb2] bg-[#f5f6f7] px-3 py-2 font-bold text-[#1f6cb2]">
              <Bookmark className="h-4 w-4" />
              我的書籤
            </h3>
            <button
              type="button"
              onClick={() => navigate({ name: 'chapter', chapterId: bookmark.chapterId })}
              className="flex w-full cursor-pointer items-center justify-between gap-3 border-b border-black/5 py-[15px] text-left"
            >
              <span className="truncate text-base text-[#1f6cb2] hover:text-[#06c]">{bookmark.title}</span>
              <span className="shrink-0 text-xs text-[#888]">繼續閱讀 →</span>
            </button>
          </>
        )}

        {/* 全部章节：蓝竖条节标题 + 三栏列表 */}
        <h3 className="mt-5 flex items-center gap-2 border-l-4 border-[#1f6cb2] bg-[#f5f6f7] px-3 py-2 font-bold text-[#1f6cb2]">
          全部章節（{chapters?.length ?? 0} 章）
        </h3>
        {isLoading ? (
          <div className="mt-2 grid gap-x-6 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="h-[22px] animate-pulse bg-[#e9ecef]" style={{ marginTop: 18 }} />
            ))}
          </div>
        ) : (
          <div className="grid gap-x-6 md:grid-cols-2 lg:grid-cols-3">
            {list.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
                className={cn(
                  'flex min-w-0 cursor-pointer items-center gap-2 border-b border-black/5 py-[15px] text-left text-base transition-colors hover:text-[#06c]',
                  bookmark?.chapterId === c.id ? 'font-bold text-[#1f6cb2]' : 'text-[#333]',
                )}
              >
                <span className="w-8 shrink-0 text-right text-xs text-[#888]">{c.idx}</span>
                <span className="truncate">{c.title}</span>
              </button>
            ))}
          </div>
        )}
      </MyBox>
    </Container>
  )
}

// ==================== Chapter（独立沉浸式阅读器） ====================

const BG_OPTIONS = [
  { key: 'white', color: '#ffffff', dark: false },
  { key: 'paper', color: '#f7f3e8', dark: false },
  { key: 'green', color: '#e8f0e4', dark: false },
  { key: 'blue', color: '#eaf1fa', dark: false },
  { key: 'night', color: '#202830', dark: true },
] as const

type BgKey = (typeof BG_OPTIONS)[number]['key']

const FONT_OPTIONS = [
  { key: 'default', label: '默認', stack: '' },
  { key: 'song', label: '宋體', stack: '"Songti SC", "SimSun", serif' },
  { key: 'hei', label: '黑體', stack: '"Heiti SC", "SimHei", sans-serif' },
] as const

type FontKey = (typeof FONT_OPTIONS)[number]['key']

export function ChapterView({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const { data: ch, isLoading, isError, refetch } = useChapter(chapterId)
  const [fontSize, setFontSize] = useState(16)
  const [bgKey, setBgKey] = useState<BgKey>('white')
  const [fontKey, setFontKey] = useState<FontKey>('default')
  const [panel, setPanel] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  const night = bgKey === 'night'

  useEffect(() => {
    if (!ch) return
    saveBookmark(ch.novelId, { chapterId: ch.id, title: ch.title })
  }, [ch])

  const flashSaved = () => {
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 1500)
  }

  const doSave = () => {
    if (!ch) return
    saveBookmark(ch.novelId, { chapterId: ch.id, title: ch.title })
    flashSaved()
  }

  if (isError) {
    return (
      <div className="min-h-screen" style={{ background: 'rgb(45,49,52)' }}>
        <div className="mx-auto max-w-[1112px] px-3 py-10 sm:px-4">
          <MyBox>
            <ErrorRetry onRetry={() => refetch()} />
          </MyBox>
        </div>
      </div>
    )
  }

  const bg = BG_OPTIONS.find((b) => b.key === bgKey)!
  const font = FONT_OPTIONS.find((f) => f.key === fontKey)!
  const paragraphs = (ch?.content ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  const toolCls =
    'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-[#4c5356] text-white transition-colors hover:bg-[#2f3538]'

  return (
    <div className="min-h-screen transition-colors" style={{ background: night ? 'rgb(45,49,52)' : '#f2f3f4' }}>
      <div className="mx-auto max-w-[1112px] px-2 pb-20 pt-3 sm:px-4 sm:pb-6 sm:pt-5">
        <section
          className="rounded-[3px] p-4 shadow-[0_1px_3px_rgba(0,0,0,.12),0_1px_2px_rgba(0,0,0,.24)] transition-colors sm:p-8"
          style={{ background: night ? 'rgb(32,40,46)' : bg.color }}
        >
          {/* 面包屑（≤sm 隐藏） */}
          <nav className="hidden items-center gap-1.5 text-sm sm:flex" style={{ color: night ? '#8a9199' : '#888' }}>
            <button
              type="button"
              onClick={() => navigate({ name: 'home' })}
              className="cursor-pointer text-[#1f6cb2] hover:text-[#06c]"
              style={night ? { color: '#6fa8d8' } : undefined}
            >
              首頁
            </button>
            <span>/</span>
            <button
              type="button"
              onClick={() => ch && navigate({ name: 'book', novelId: ch.novelId })}
              className="cursor-pointer text-[#1f6cb2] hover:text-[#06c]"
              style={night ? { color: '#6fa8d8' } : undefined}
            >
              {ch?.novelTitle ?? '…'}
            </button>
            <span>/</span>
            <span className="truncate">{ch?.title ?? ''}</span>
          </nav>

          {/* 工具行：右对齐深灰圆形按钮 */}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" title="書頁" className={toolCls} onClick={() => ch && navigate({ name: 'book', novelId: ch.novelId })}>
              <BookOpen className="h-4 w-4" />
            </button>
            <button type="button" title="收藏書籤" className={toolCls} onClick={doSave}>
              <Bookmark className={cn('h-4 w-4', savedFlash && 'fill-current')} />
            </button>
            <button type="button" title="目錄" className={toolCls} onClick={() => ch && navigate({ name: 'toc', novelId: ch.novelId })}>
              <List className="h-4 w-4" />
            </button>
            <button type="button" title="設置" className={cn(toolCls, panel && 'bg-[#1f6cb2]')} onClick={() => setPanel((v) => !v)}>
              <Settings2 className="h-4 w-4" />
            </button>
            <button type="button" title="黑夜模式" className={cn(toolCls, night && 'bg-[#1f6cb2]')} onClick={() => setBgKey(night ? 'white' : 'night')}>
              <Moon className="h-4 w-4" />
            </button>
          </div>

          {isLoading || !ch ? (
            <div className="py-10">
              <ChapterSkeleton />
            </div>
          ) : (
            <>
              {/* 居中标题 + 元信息 */}
              <h1 className="mt-3 text-center text-xl font-bold" style={{ color: night ? '#c8cdd2' : '#333' }}>
                {ch.title}
              </h1>
              <p className="mt-2 text-center text-sm" style={{ color: night ? '#8a9199' : '#888' }}>
                {ch.novelTitle} · {fmtWords(ch.wordCount)} · 第 {ch.idx} 章
              </p>
              <p className="mt-1 text-center text-xs" style={{ color: night ? '#8a9199' : '#888' }}>
                {savedFlash ? '✓ 書籤已保存' : '打開章節時自動記錄閱讀進度'}
              </p>

              {/* 正文：行高 2、段首两格缩进、字号可调 */}
              <article
                className="mt-6"
                style={{ fontSize, fontFamily: font.stack || undefined, lineHeight: 2, color: night ? 'rgb(153,153,153)' : '#333' }}
              >
                {paragraphs.length === 0 ? (
                  <p className="py-10 text-center text-sm" style={{ color: night ? '#8a9199' : '#999' }}>
                    本章內容為空，請返回目錄選擇其他章節。
                  </p>
                ) : (
                  paragraphs.map((p, i) => (
                    <p key={i} className="break-words" style={{ textIndent: '2em' }}>
                      {p}
                    </p>
                  ))
                )}
              </article>

              {/* 底部翻页条：4 等分按钮 */}
              <div
                className="mt-8 flex overflow-hidden rounded-[3px] border text-sm transition-colors"
                style={{
                  borderColor: night ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.12)',
                  background: night ? '#2a3238' : '#fafafa',
                }}
              >
                {[
                  {
                    label: '上一章',
                    disabled: !ch.prevId,
                    go: () => ch.prevId && navigate({ name: 'chapter', chapterId: ch.prevId }),
                  },
                  { label: savedFlash ? '✓ 已收藏' : '書籤', disabled: false, go: doSave },
                  { label: '目錄', disabled: false, go: () => navigate({ name: 'toc', novelId: ch.novelId }) },
                  {
                    label: '下一章',
                    disabled: !ch.nextId,
                    go: () => ch.nextId && navigate({ name: 'chapter', chapterId: ch.nextId }),
                  },
                ].map((b, i) => (
                  <button
                    key={b.label}
                    type="button"
                    disabled={b.disabled}
                    onClick={b.go}
                    className={cn(
                      'h-12 flex-1 cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      i < 3 && 'border-r',
                    )}
                    style={{
                      borderColor: night ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)',
                      color: night ? '#aeb6bd' : '#333',
                    }}
                    onMouseEnter={(e) => {
                      ;(e.currentTarget as HTMLButtonElement).style.background = night ? '#3a4247' : '#ffffff'
                    }}
                    onMouseLeave={(e) => {
                      ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                    }}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {/* 设置面板：底部弹出白色圆角面板 */}
      {panel && (
        <div className="fixed bottom-0 left-1/2 z-[70] w-[min(500px,94vw)] -translate-x-1/2 rounded-t-2xl bg-white p-5 shadow-[0_-6px_24px_rgba(0,0,0,.28)]">
          <div className="flex items-center justify-between">
            <p className="text-base font-bold text-[#333]">閱讀設置</p>
            <button
              type="button"
              aria-label="關閉"
              onClick={() => setPanel(false)}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[#888] hover:bg-[#f0f2f4]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* 背景色圆形色板（active 红描边） */}
          <div className="mt-4 flex items-center gap-3">
            <span className="w-14 shrink-0 text-sm text-[#666]">背景</span>
            {BG_OPTIONS.map((b) => (
              <button
                key={b.key}
                type="button"
                aria-label={b.key}
                onClick={() => setBgKey(b.key)}
                className={cn(
                  'h-8 w-8 cursor-pointer rounded-full border-2 transition-all',
                  bgKey === b.key ? 'scale-110' : 'border-black/15',
                )}
                style={{ background: b.color, borderColor: bgKey === b.key ? ACCENT_RED : undefined }}
              />
            ))}
            <span className="text-xs text-[#888]">{night ? '夜間' : '日間'}</span>
          </div>
          {/* 字体族选择 */}
          <div className="mt-3 flex items-center gap-2">
            <span className="w-14 shrink-0 text-sm text-[#666]">字體</span>
            {FONT_OPTIONS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFontKey(f.key)}
                className={cn(
                  'h-8 cursor-pointer rounded-[3px] px-3 text-sm transition-colors',
                  fontKey === f.key ? 'bg-[#1f6cb2] text-white' : 'bg-[#f0f2f4] text-[#333] hover:bg-[#e2e6ea]',
                )}
                style={f.key === 'song' ? { fontFamily: '"Songti SC","SimSun",serif' } : undefined}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* 字号加减 */}
          <div className="mt-3 flex items-center gap-2">
            <span className="w-14 shrink-0 text-sm text-[#666]">字號</span>
            <button
              type="button"
              onClick={() => setFontSize((s) => Math.max(14, s - 1))}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[3px] bg-[#f0f2f4] text-[#333] hover:bg-[#e2e6ea]"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-12 text-center text-sm text-[#333]">{fontSize}px</span>
            <button
              type="button"
              onClick={() => setFontSize((s) => Math.min(24, s + 1))}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[3px] bg-[#f0f2f4] text-[#333] hover:bg-[#e2e6ea]"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* 移动端底部固定深灰工具面板 */}
      <div className="fixed inset-x-0 bottom-0 z-[65] flex items-stretch justify-around bg-[#424e52] py-1.5 text-white sm:hidden">
        {[
          {
            label: '上一章',
            disabled: !ch?.prevId,
            go: () => ch?.prevId && navigate({ name: 'chapter', chapterId: ch.prevId }),
          },
          { label: '目錄', disabled: !ch, go: () => ch && navigate({ name: 'toc', novelId: ch.novelId }) },
          { label: '設置', disabled: false, go: () => setPanel((v) => !v) },
          { label: night ? '日間' : '夜間', disabled: false, go: () => setBgKey(night ? 'white' : 'night') },
          {
            label: '下一章',
            disabled: !ch?.nextId,
            go: () => ch?.nextId && navigate({ name: 'chapter', chapterId: ch.nextId }),
          },
        ].map((b) => (
          <button
            key={b.label}
            type="button"
            disabled={b.disabled}
            onClick={b.go}
            className="flex-1 cursor-pointer py-1.5 text-xs transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ==================== Search ====================

export function SearchView({ navigate, query }: ViewProps & { query: string }) {
  /* key=query：关键词变化时重挂载，重置输入框与页码 */
  return <SearchPanel key={query} navigate={navigate} query={query} />
}

function SearchPanel({ navigate, query }: { navigate: (v: ThemeView) => void; query: string }) {
  const [input, setInput] = useState(query)
  const [page, setPage] = useState(1)
  const { data: categories } = useCategories()
  const { data, isLoading, isError, refetch } = useNovels(
    query ? { q: query, page, pageSize: 20 } : { sort: 'clicks', pageSize: 12 },
  )

  const submit = (q: string) => navigate({ name: 'search', query: q.trim() })

  return (
    <Container className="space-y-4 py-4">
      {/* 门户搜索盒 */}
      <MyBox>
        <form
          className="flex h-[50px] items-center rounded-[25px] border border-[#dce9f5] bg-white px-5 shadow-[0_2px_10px_rgba(31,108,178,.18)]"
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={query ? `「${query}」· 換個關鍵字再搜一次` : '輸入書名 / 作者關鍵字'}
            className="h-full min-w-0 flex-1 bg-transparent text-base text-[#333] outline-none placeholder:text-[#b8c4cf]"
          />
          <button type="submit" aria-label="搜尋" className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#1f6cb2] transition-colors hover:bg-[#e8f4ff]">
            <Search className="h-5 w-5" />
          </button>
        </form>
        <p className="mt-3 text-sm text-[#888]">
          {query
            ? data
              ? `共 ${data.total} 條與「${query}」相關的結果`
              : '正在搜尋…'
            : '直接搜尋，或看看本週熱門推薦'}
        </p>
      </MyBox>

      <MyBox>
        <SectionTitle>{query ? '搜尋結果' : '熱門推薦'}</SectionTitle>
        <div className="mt-4">
          {isError ? (
            <ErrorRetry onRetry={() => refetch()} />
          ) : isLoading ? (
            <GridSkeleton count={12} />
          ) : data && data.list.length > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {data.list.map((n) => (
                  <CoverCard key={n.id} novel={n} onClick={() => navigate({ name: 'book', novelId: n.id })} />
                ))}
              </div>
              {query && <Pager page={data.page} totalPages={data.totalPages} onGo={setPage} />}
            </>
          ) : (
            <div className="py-10 text-center">
              <SearchX className="mx-auto h-9 w-9 text-[#bbb]" />
              <p className="mt-3 text-sm text-[#888]">沒有找到與「{query}」相關的小說</p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {(categories ?? []).slice(0, 10).map((c) => (
                  <BlueTag key={c.id} onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}>
                    {c.name}
                  </BlueTag>
                ))}
              </div>
            </div>
          )}
        </div>
      </MyBox>
    </Container>
  )
}
