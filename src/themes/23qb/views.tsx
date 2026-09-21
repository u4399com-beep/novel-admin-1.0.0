'use client'

// ==================== 23qb 六视图 ====================
// Home：搜索 Hero + 热门封面榜 + 分类热度文字榜单（通栏单列卡流）
// Category：药丸筛选 + 封面网格 + 分页
// Book：白盒左右分区（封面在右）+ 最新章节盒 + 相关作品
// Toc：白盒头部 + 阅读进度 + 单列斑马章节行
// Chapter：680px 阅读栏 + 18px/1.6 正文 + 底部胶囊翻页条
// Search：同款搜索框 + 封面结果网格

import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Bookmark, SearchX, ThumbsUp } from 'lucide-react'
import { useCategories, useChapter, useChapters, useHomeData, useNovel, useNovels } from '@/hooks/use-novel-data'
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
import { coverBgClass } from '@/lib/covers'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'
import { NovelTagsRow } from '@/components/novel-tags'
import { cn } from '@/lib/utils'
import type { NovelListItem } from '@/lib/types'
import type { ThemeView, ViewProps } from '../types'
import {
  BigBtn,
  BookSkeleton,
  Card,
  ChapterRow,
  ChapterSkeleton,
  Container,
  CoverCard,
  ErrorRetry,
  GRADIENT_ACCENT,
  GRADIENT_GREEN,
  GridSkeleton,
  HeroSearch,
  HomeSkeleton,
  Pager,
  Pill,
  RankCover,
  TextRankCard,
  fmtDate,
  fmtWords,
  loadBookmarks,
  saveBookmark,
} from './ui'

// ---------- 书架（localStorage） ----------

const SHELF_KEY = '23qb.shelf'

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
  const arr = loadShelf()
  const has = arr.includes(id)
  const next = has ? arr.filter((x) => x !== id) : [...arr, id]
  window.localStorage.setItem(SHELF_KEY, JSON.stringify(next))
  return !has
}

// ==================== Home ====================

export function HomeView({ navigate, siteName }: ViewProps) {
  const { data, isLoading, isError, refetch } = useHomeData()
  // 宽口径列表：用于按分类聚合出「分类热度榜单」
  const broad = useNovels({ page: 1, pageSize: 60 })

  const hotCovers = useMemo(() => {
    if (!data) return []
    const seen = new Set<number>()
    const out: NovelListItem[] = []
    for (const n of [...data.hot, ...data.featured, ...data.latest]) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      out.push(n)
      if (out.length >= 12) break
    }
    return out
  }, [data])

  const rankCards = useMemo(() => {
    if (!data) return []
    const all = broad.data?.list ?? []
    return data.categories.map((c) => ({
      ...c,
      items: all.filter((n) => n.categoryId === c.id).sort((a, b) => b.clicks - a.clicks),
    }))
  }, [data, broad.data])

  if (isError) return <Container className="pt-[70px]"><ErrorRetry onRetry={() => refetch()} /></Container>
  if (isLoading || !data) return <HomeSkeleton />

  const pick = (n: NovelListItem) => navigate({ name: 'book', novelId: n.id })

  return (
    <div>
      {/* 搜索 Hero：负外边距顶到透明顶栏之下，暖色渐变代替整幅头图 */}
      <div className="-mt-[70px] bg-gradient-to-b from-[#ffeee4] via-[#fdf2ec] to-[#f8f9f9] pb-10 pt-[70px]">
        <div className="mx-auto max-w-[680px] px-4">
          <div className="flex h-[150px] items-center justify-center">
            <h1 className="text-4xl font-black tracking-widest text-[#282828] md:text-[42px]">
              {siteName}
              <span className="ml-3 align-middle text-sm font-medium tracking-normal text-black/40">
                好书一找即达
              </span>
            </h1>
          </div>
          <HeroSearch navigate={navigate} hotItems={data.hot} />
          <p className="mt-4 text-center text-xs text-black/40">
            收录 {data.stats.novelCount} 部小说 · {data.stats.chapterCount} 章 · 今日更新 {data.stats.todayUpdates} 章
          </p>
        </div>
      </div>

      <Container>
        {/* 热门封面榜（源站区块名：热门推荐） */}
        <Card className="p-5 md:p-7">
          <div className="mb-6 flex items-center gap-2">
            <span className="h-5 w-[3px] rounded-full" style={{ backgroundImage: GRADIENT_ACCENT }} aria-hidden />
            <h2 className="text-[20px] font-bold text-[#282828] md:text-[22px]">热门推荐</h2>
          </div>
          <div className="flex flex-wrap justify-center gap-x-5 gap-y-7">
            {hotCovers.map((n, i) => (
              <RankCover key={n.id} novel={n} rank={i + 1} onClick={() => pick(n)} />
            ))}
          </div>
        </Card>

        {/* 分类热度榜单（源站 1280px 实测 4 列 260px 卡片；≤899 两列 / 中屏三列近似） */}
        <div className="mt-7 grid gap-7 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rankCards.map((c) => (
            <TextRankCard key={c.id} title={c.name} items={c.items} onPick={pick} />
          ))}
        </div>
      </Container>
    </div>
  )
}

// ==================== Category ====================

type SortKey = 'latest' | 'clicks' | 'words' | 'featured'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'latest', label: '最新更新' },
  { key: 'clicks', label: '最多点击' },
  { key: 'words', label: '字数最多' },
  { key: 'featured', label: '编辑推荐' },
]

export function CategoryView({
  navigate,
  categoryId,
  page = 1,
}: ViewProps & { categoryId?: number; page?: number }) {
  const { data: categories } = useCategories()
  const [sort, setSort] = useState<SortKey>('latest')
  const [status, setStatus] = useState<'serial' | 'finished' | undefined>(undefined)
  const { data, isLoading, isError, refetch } = useNovels({
    categoryId,
    page,
    pageSize: 20,
    sort,
    status,
  })

  const catName = categories?.find((c) => c.id === categoryId)?.name ?? '全部'
  const applyFilter = (fn: () => void) => {
    fn()
    if (page !== 1) navigate({ name: 'category', categoryId, page: 1 })
  }

  return (
    <Container className="space-y-6 py-6">
      {/* 筛选区 */}
      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-bold text-black/45">分类</span>
          <Pill active={!categoryId} onClick={() => applyFilter(() => navigate({ name: 'category', page: 1 }))}>
            全部
          </Pill>
          {(categories ?? []).map((c) => (
            <Pill
              key={c.id}
              active={categoryId === c.id}
              onClick={() => applyFilter(() => navigate({ name: 'category', categoryId: c.id, page: 1 }))}
            >
              {c.name}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-bold text-black/45">排序</span>
          {SORT_OPTIONS.map((o) => (
            <Pill key={o.key} active={sort === o.key} onClick={() => applyFilter(() => setSort(o.key))}>
              {o.label}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-bold text-black/45">进度</span>
          <Pill active={!status} onClick={() => applyFilter(() => setStatus(undefined))}>
            全部
          </Pill>
          <Pill active={status === 'serial'} onClick={() => applyFilter(() => setStatus('serial'))}>
            连载
          </Pill>
          <Pill active={status === 'finished'} onClick={() => applyFilter(() => setStatus('finished'))}>
            完本
          </Pill>
        </div>
        <h1 className="pt-1 text-lg font-bold text-[#282828]">
          {catName}小说
          <span className="ml-2 text-sm font-medium text-black/40">
            {data ? `共 ${data.total} 部 · 第 ${data.page}/${data.totalPages} 页` : '加载中…'}
          </span>
        </h1>
      </Card>

      {/* 书籍网格 */}
      <Card className="p-5 md:p-7">
        {isError ? (
          <ErrorRetry onRetry={() => refetch()} />
        ) : isLoading ? (
          <GridSkeleton />
        ) : data && data.list.length > 0 ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
            {data.list.map((n) => (
              <CoverCard
                key={n.id}
                novel={n}
                onClick={() => navigate({ name: 'book', novelId: n.id })}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center py-16 text-black/40">
            <SearchX className="h-10 w-10" />
            <p className="mt-3 text-sm">该筛选条件下暂无收录，换个条件试试</p>
          </div>
        )}
        {data && data.list.length > 0 && (
          <Pager page={data.page} totalPages={data.totalPages} onGo={(p) => navigate({ name: 'category', categoryId, page: p })} />
        )}
      </Card>
    </Container>
  )
}

// ==================== Book ====================

export function BookView({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isLoading, isError, refetch } = useNovel(novelId)
  /* 最新章节需从全量章节取末 12 条（详情接口的 chapters 是最早 12 章，不能直接用） */
  const chaptersQ = useChapters(novelId)
  const latest12 = chaptersQ.data ? [...chaptersQ.data].slice(-12).reverse() : null
  const related = useNovels({ categoryId: novel?.categoryId, pageSize: 12, sort: 'clicks', enabled: novel != null })
  const [onShelf, setOnShelf] = useState(() => loadShelf().includes(novelId))
  const [rec, setRec] = useState(false)
  const [shelfNovelId, setShelfNovelId] = useState(novelId)

  if (shelfNovelId !== novelId) {
    setShelfNovelId(novelId)
    setOnShelf(loadShelf().includes(novelId))
    setRec(false)
  }

  if (isError) return <Container className="pt-[70px]"><ErrorRetry onRetry={() => refetch()} /></Container>
  if (isLoading || !novel) return <Container className="pt-[70px]"><BookSkeleton /></Container>

  const relatedList = (related.data?.list ?? []).filter((n) => n.id !== novel.id).slice(0, 12)

  return (
    <Container className="space-y-6 py-6">
      {/* 信息白盒：信息在左、封面在右 */}
      <Card className="p-6 md:p-8">
        <div className="flex flex-col-reverse gap-7 md:flex-row md:gap-10">
          <div className="min-w-0 flex-1">
            <h1 className="text-[30px] font-extrabold leading-tight text-[#282828] md:text-[38px]">{novel.title}</h1>
            {/* 元信息药丸行 */}
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex h-[30px] items-center rounded-[10px] bg-[#fef0e5] px-3 text-[#c25705]">
                作者：{novel.author}
              </span>
              <button
                type="button"
                onClick={() => navigate({ name: 'category', categoryId: novel.categoryId, page: 1 })}
                className="inline-flex h-[30px] cursor-pointer items-center rounded-[10px] bg-[#eaedf1] px-3 text-black/60 transition-colors hover:text-[#ff2a14]"
              >
                {novel.categoryName}
              </button>
              <span className="inline-flex h-[30px] items-center rounded-[10px] bg-[#eaedf1] px-3 text-black/60">
                {fmtWords(novel.wordCount)}
              </span>
              <span className="inline-flex h-[30px] items-center rounded-[10px] bg-[#eaedf1] px-3 text-black/60">
                {novel.status === 'finished' ? '完本' : '连载中'}
              </span>
              <span className="inline-flex h-[30px] items-center rounded-[10px] bg-[#eaedf1] px-3 text-black/60">
                {novel.totalChapters} 章
              </span>
            </div>
            <p className="mt-5 whitespace-pre-line text-[15px] leading-7 text-black/68">
              {novel.description || '（作者还未填写简介）'}
            </p>
            <NovelTagsRow tags={novel.tags ?? []} navigate={navigate} className="mt-3" />
            {/* 按钮行 */}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <BigBtn
                tone="accent"
                disabled={novel.firstChapterId == null}
                onClick={() => novel.firstChapterId != null && navigate({ name: 'chapter', chapterId: novel.firstChapterId })}
              >
                <BookOpen className="h-4 w-4" />
                开始阅读
              </BigBtn>
              <BigBtn tone="ghost" onClick={() => setOnShelf(toggleShelf(novel.id))}>
                <Bookmark className={cn('h-4 w-4', onShelf && 'fill-current')} />
                {onShelf ? '已在书架' : '收藏'}
              </BigBtn>
              <BigBtn tone="green" onClick={() => setRec(true)}>
                <ThumbsUp className="h-4 w-4" />
                {rec ? '已推荐 · 感谢支持' : '推荐本书'}
              </BigBtn>
            </div>
          </div>
          {/* 封面在右 */}
          <div className="mx-auto w-[170px] shrink-0 md:w-[200px]">
            <CoverBox novel={novel} big />
          </div>
        </div>
      </Card>

      {/* 最新章节盒 */}
      <Card className="p-6 md:p-8">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[22px] font-bold text-[#282828] md:text-[26px]">最新章节</h2>
          <span className="text-xs text-black/40">更新于 {fmtDate(novel.updatedAt)}</span>
        </div>
        <div className="mt-4 flex flex-col">
          {chaptersQ.isPending ? (
            <>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="mb-2 h-10 animate-pulse rounded-[10px] bg-[#f0f1f3]" />
              ))}
            </>
          ) : chaptersQ.isError ? (
            <div className="flex items-center justify-center gap-3 py-8 text-sm text-black/45">
              章节加载失败
              <button
                type="button"
                onClick={() => chaptersQ.refetch()}
                className="inline-flex h-9 cursor-pointer items-center rounded-[50px] px-5 text-white transition-opacity hover:opacity-90"
                style={{ backgroundImage: GRADIENT_ACCENT }}
              >
                重新加载
              </button>
            </div>
          ) : !latest12 || latest12.length === 0 ? (
            <p className="py-8 text-center text-sm text-black/40">本书暂无章节</p>
          ) : (
            latest12.map((c) => (
              <ChapterRow key={c.id} chapter={c} onClick={() => navigate({ name: 'chapter', chapterId: c.id })} />
            ))
          )}
        </div>
        <div className="mt-5 border-t border-[#f5f5f5] pt-5 text-center">
          <button
            type="button"
            onClick={() => navigate({ name: 'toc', novelId: novel.id })}
            className="inline-flex h-10 cursor-pointer items-center rounded-[50px] px-8 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundImage: GRADIENT_GREEN }}
          >
            完整目录（{novel.totalChapters} 章）
          </button>
        </div>
      </Card>

      {/* 相关作品盒（源站书页底部为同分类作品链接行，此处以封面网格承载） */}
      <Card className="p-6 md:p-8">
        <h2 className="text-[22px] font-bold text-[#282828] md:text-[26px]">相关作品</h2>
        {relatedList.length > 0 ? (
          <div className="mt-5 grid grid-cols-3 gap-x-5 gap-y-7 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-12">
            {relatedList.map((n) => (
              <CoverCard key={n.id} novel={n} onClick={() => navigate({ name: 'book', novelId: n.id })} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-black/40">暂无同分类推荐</p>
        )}
      </Card>
    </Container>
  )
}

/** 封面渐变体：coverBgClass + 书名首字；采集到本地 webp 封面时渲染图片 */
function CoverBox({ novel, big }: { novel: { title: string; cover: string }; big?: boolean }) {
  return (
    <div
      className={cn(
        'relative flex aspect-[5/7] items-center justify-center overflow-hidden rounded-[10px] shadow-[0_10px_26px_rgba(149,157,165,.4)]',
        coverBgClass(novel.cover),
      )}
    >
      <NovelCoverImg novel={novel} />
      {!isLocalCover(novel.cover) && (
        <span className={cn('font-bold text-white/90 drop-shadow-md', big ? 'text-6xl' : 'text-5xl')}>
          {novel.title.slice(0, 1)}
        </span>
      )}
    </div>
  )
}

// ==================== Toc ====================

export function TocView({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isError, refetch } = useNovel(novelId)
  const { data: chapters, isLoading, isError: chError, refetch: refetchCh } = useChapters(novelId)
  const [bookmark, setBookmark] = useState<{ chapterId: number; title: string } | null>(
    () => loadBookmarks()[String(novelId)] ?? null
  )
  const [bmNovelId, setBmNovelId] = useState(novelId)

  if (bmNovelId !== novelId) {
    setBmNovelId(novelId)
    setBookmark(loadBookmarks()[String(novelId)] ?? null)
  }

  const err = isError || chError
  if (err) {
    return (
      <Container className="pt-[70px]">
        <ErrorRetry onRetry={() => { refetch(); refetchCh() }} />
      </Container>
    )
  }

  return (
    <Container className="space-y-6 py-6">
      <Card className="p-6 md:p-8">
        <button
          type="button"
          onClick={() => navigate({ name: 'book', novelId })}
          className="cursor-pointer text-left text-[30px] font-extrabold leading-tight text-[#282828] transition-colors hover:text-[#ff2a14] md:text-[38px]"
        >
          {novel?.title ?? '目录'}
        </button>
        <p className="mt-2 text-sm text-black/45">
          {novel ? `作者：${novel.author} · 更新于 ${fmtDate(novel.updatedAt)} · 共 ${chapters?.length ?? novel.totalChapters} 章` : ''}
        </p>

        {/* 阅读进度（书签）块 */}
        <div className="mt-5 flex items-center justify-between gap-3 rounded-[10px] bg-[#f7f8f9] px-4 py-3">
          {bookmark ? (
            <>
              <p className="min-w-0 flex-1 truncate text-sm text-black/60">
                阅读进度：{bookmark.title}
              </p>
              <button
                type="button"
                onClick={() => navigate({ name: 'chapter', chapterId: bookmark.chapterId })}
                className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-[50px] px-5 text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ backgroundImage: GRADIENT_GREEN }}
              >
                继续阅读
              </button>
            </>
          ) : (
            <p className="text-sm text-black/40">暂无阅读进度 —— 打开任意章节后会自动记录书签</p>
          )}
        </div>
      </Card>

      {/* 最新章节（全书倒数 12 章，新→旧，置顶快达） */}
      {chapters && chapters.length > 0 && (
        <Card className="p-6 md:p-8">
          <h2 className="text-[22px] font-bold text-[#282828] md:text-[26px]">最新章节</h2>
          <p className="mt-1 text-sm text-black/45">全书最近更新 12 章 · 新→旧</p>
          <div className="mt-4 grid gap-x-8 md:grid-cols-2">
            {[...chapters].slice(-12).reverse().map((c) => (
              <ChapterRow
                key={`latest-${c.id}`}
                chapter={c}
                active={bookmark?.chapterId === c.id}
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
              />
            ))}
          </div>
        </Card>
      )}

      <Card className="p-6 md:p-8">
        <h2 className="text-[22px] font-bold text-[#282828] md:text-[26px]">正文 · 全部章节</h2>
        {isLoading ? (
          <div className="mt-4 space-y-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded-[10px] bg-[#f0f1f3]" />
            ))}
          </div>
        ) : (
          <div className="mt-4 flex flex-col">
            {(chapters ?? []).map((c) => (
              <ChapterRow
                key={c.id}
                chapter={c}
                active={bookmark?.chapterId === c.id}
                onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
              />
            ))}
          </div>
        )}
      </Card>
    </Container>
  )
}

// ==================== Chapter ====================

/* 场景配色：日间白纸，其余按语义键换肤 */
const SCENES: Record<string, ReaderSceneColors> = {
  day: { page: '', paper: '#ffffff', ink: '#282828', muted: '#999999', line: '#f5f5f5' },
  paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#e2d5b8' },
  green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', muted: '#8fa590', line: '#d4e2d0' },
  blue: { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', muted: '#8fa2b0', line: '#d5e2ee' },
  night: { page: '#17191d', paper: '#1f2328', ink: '#c0c0c6', muted: '#8a8a92', line: '#32363c' },
}

/** 阅读设置条：字号 A± / 行距 / 字体 / 字色 / 背景（跨主题共享同一份偏好，localStorage 持久化） */
function ReaderBar() {
  const [prefs] = useReaderPrefs()
  const btn =
    'inline-flex h-7 min-w-[28px] cursor-pointer items-center justify-center rounded-[8px] bg-[#f3f5f7] px-2 text-xs text-[#282828] transition-colors'
  const on = 'bg-[#282828] text-white'
  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-[12px] bg-[#fafafa] px-3 py-2.5 text-xs text-black/45">
      <span className="flex items-center gap-1">
        字号
        <button type="button" title="减小字号" className={btn} onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, -1) })}>
          A-
        </button>
        <span className="w-[34px] text-center">{prefs.fontSize}px</span>
        <button type="button" title="增大字号" className={btn} onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, 1) })}>
          A+
        </button>
      </span>
      <span className="flex items-center gap-1">
        行距
        {READER_LINE_HEIGHTS.map((lh) => (
          <button key={lh} type="button" className={`${btn} ${prefs.lineHeight === lh ? on : ''}`} onClick={() => setReaderPrefs({ lineHeight: lh })}>
            {lh.toFixed(1)}
          </button>
        ))}
      </span>
      <span className="flex items-center gap-1">
        字体
        <select
          value={prefs.font}
          onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
          className="h-7 cursor-pointer rounded-[8px] border-0 bg-[#f3f5f7] px-2 text-xs text-[#282828] outline-none"
        >
          <option value="default">默认</option>
          <option value="song">宋体</option>
          <option value="hei">黑体</option>
          <option value="kai">楷体</option>
        </select>
      </span>
      <span className="flex items-center gap-1">
        字色
        <select
          value={prefs.ink}
          onChange={(e) => setReaderPrefs({ ink: e.target.value })}
          aria-label="字色"
          className="h-7 cursor-pointer rounded-[8px] border-0 bg-[#f3f5f7] px-2 text-xs text-[#282828] outline-none"
        >
          {READER_INKS.map((c) => (
            <option key={c.k} value={c.v}>{c.k}</option>
          ))}
        </select>
      </span>
      <span className="flex items-center gap-1.5">
        背景
        {READER_SCENES.map((s) => (
          <button
            key={s.key}
            type="button"
            title={s.label}
            aria-label={`背景：${s.label}`}
            onClick={() => setReaderPrefs({ scene: s.key })}
            className={`h-4 w-4 cursor-pointer rounded-full border transition-all ${
              prefs.scene === s.key ? 'scale-110 border-[#ff2a14]' : 'border-black/20'
            }`}
            style={{ background: SCENES[s.key].paper }}
          />
        ))}
      </span>
      <button type="button" className="cursor-pointer text-xs text-black/35 hover:text-[#ff2a14]" onClick={resetReaderPrefs}>
        恢复默认
      </button>
    </div>
  )
}

export function ChapterView({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const { data: ch, isLoading, isError, refetch } = useChapter(chapterId)
  const [prefs] = useReaderPrefs()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!ch) return
    saveBookmark(ch.novelId, { chapterId: ch.id, title: ch.title })
  }, [ch])

  if (isError) {
    return (
      <div className="mx-auto max-w-[680px] px-4 pb-24 pt-8">
        <ErrorRetry onRetry={() => refetch()} />
      </div>
    )
  }

  const paragraphs = (ch?.content ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  const scene = SCENES[prefs.scene] ?? SCENES.day

  return (
    <div className="mx-auto max-w-[680px] px-4 pb-28 pt-6">
      {/* 顶部搜索框（与首页同款） */}
      <HeroSearch navigate={navigate} size="sm" />

      <Card className="mt-6 p-6 md:p-10" style={{ background: scene.paper }}>
        {isLoading || !ch ? (
          <ChapterSkeleton />
        ) : (
          <>
            {/* 面包屑 */}
            <nav className="flex flex-wrap items-center gap-1.5 text-xs md:text-sm" style={{ color: scene.muted }}>
              <button type="button" onClick={() => navigate({ name: 'home' })} className="cursor-pointer hover:text-[#ff2a14]">
                首页
              </button>
              <span>/</span>
              <button
                type="button"
                onClick={() => navigate({ name: 'book', novelId: ch.novelId })}
                className="cursor-pointer hover:text-[#ff2a14]"
              >
                {ch.novelTitle}
              </button>
              <span>/</span>
              <span className="truncate">正文</span>
            </nav>
            <h1 className="mt-4 text-[30px] font-extrabold leading-tight md:text-[44px]" style={{ color: scene.ink }}>
              {ch.title}
            </h1>
            <p className="mt-2 text-sm" style={{ color: scene.muted }}>
              {ch.novelTitle} · {fmtWords(ch.wordCount)}
            </p>

            {/* 阅读设置 */}
            <ReaderBar />

            {/* 正文：字号/行距/字体/背景可调 */}
            <article className="mt-6 border-t pt-8" style={{ borderColor: scene.line }}>
              {paragraphs.length === 0 ? (
                <p className="py-10 text-sm" style={{ color: scene.muted }}>本章内容为空，请返回目录选择其他章节。</p>
              ) : (
                paragraphs.map((p, i) => (
                  <p
                    key={i}
                    className="mb-[0.825rem] break-words"
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
            </article>
          </>
        )}
      </Card>

      {/* 底部翻页条：限宽 768px、高 70px 四段药丸 */}
      <div className="mx-auto mt-10 max-w-[768px]">
        <div className="flex h-[70px] items-stretch overflow-hidden rounded-[50px] bg-[#f3f5f7] text-sm text-[#282828] shadow-[0_4px_14px_rgba(149,157,165,.18)]">
          <button
            type="button"
            disabled={!ch?.prevId}
            onClick={() => ch?.prevId && navigate({ name: 'chapter', chapterId: ch.prevId })}
            className="flex-1 cursor-pointer rounded-l-[50px] px-2 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:text-black/30 disabled:hover:bg-transparent"
          >
            上一章
          </button>
          <button
            type="button"
            onClick={() => {
              if (!ch) return
              saveBookmark(ch.novelId, { chapterId: ch.id, title: ch.title })
              setSaved(true)
              window.setTimeout(() => setSaved(false), 1600)
            }}
            className="mx-0.5 my-3 flex-[0.8] cursor-pointer rounded-[5px] transition-colors hover:bg-white"
          >
            {saved ? '已存书签' : '书签'}
          </button>
          <button
            type="button"
            disabled={!ch}
            onClick={() => ch && navigate({ name: 'toc', novelId: ch.novelId })}
            className="mx-0.5 my-3 flex-[0.8] cursor-pointer rounded-[5px] transition-colors hover:bg-white disabled:cursor-not-allowed"
          >
            目录
          </button>
          <button
            type="button"
            disabled={!ch?.nextId}
            onClick={() => ch?.nextId && navigate({ name: 'chapter', chapterId: ch.nextId })}
            className="flex-1 cursor-pointer rounded-r-[50px] px-2 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:text-black/30 disabled:hover:bg-transparent"
          >
            下一章
          </button>
        </div>
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
    query ? { q: query, page, pageSize: 20 } : { sort: 'clicks', pageSize: 10 },
  )

  const submit = (q: string) => navigate({ name: 'search', query: q.trim() })

  return (
    <Container className="space-y-6 py-6">
      <Card className="p-5 md:p-7">
        <div className="flex h-14 items-center rounded-[10px] bg-[#f3f5f7]">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit(input)}
              placeholder="搜索书名 / 作者 / 简介"
              className="h-full min-w-0 flex-1 bg-transparent px-4 text-base text-[#282828] outline-none placeholder:text-black/30"
            />
            <button
              type="button"
              onClick={() => submit(input)}
              className="mr-1 inline-flex h-11 cursor-pointer items-center rounded-[10px] px-6 text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundImage: 'linear-gradient(90deg, #ff9800, #ff2a14)' }}
            >
              搜索
            </button>
        </div>
        {query ? (
          <p className="mt-3 text-sm text-black/45">
            {data ? `共 ${data.total} 条与「${query}」相关的结果` : '正在搜索…'}
          </p>
        ) : (
          <p className="mt-3 text-sm text-black/45">输入关键词搜索，或看看大家都在读什么</p>
        )}
      </Card>

      <Card className="p-5 md:p-7">
        {isError ? (
          <ErrorRetry onRetry={() => refetch()} />
        ) : isLoading ? (
          <GridSkeleton count={10} />
        ) : data && data.list.length > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
              {data.list.map((n) => (
                <CoverCard key={n.id} novel={n} onClick={() => navigate({ name: 'book', novelId: n.id })} />
              ))}
            </div>
            {query && (
              <Pager page={data.page} totalPages={data.totalPages} onGo={setPage} />
            )}
          </>
        ) : (
          <div className="py-10 text-center">
            <SearchX className="mx-auto h-10 w-10 text-black/25" />
            <p className="mt-3 text-sm text-black/45">没有找到与「{query}」相关的小说</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {(categories ?? []).slice(0, 8).map((c) => (
                <Pill key={c.id} onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}>
                  {c.name}
                </Pill>
              ))}
            </div>
          </div>
        )}
        {data && data.list.length > 0 && !query && (
          <p className="mt-6 text-center text-xs text-black/35">—— 热门点击推荐 ——</p>
        )}
      </Card>
    </Container>
  )
}
