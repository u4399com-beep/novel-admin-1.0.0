'use client'

import { useEffect, useState } from 'react'
import { TocChapters } from '@/components/toc-chapters'
import { BookSuggestLinks } from '@/components/book-suggest-links'
import {
  useCategories,
  useChapter,
  useChapters,
  useHomeData,
  useNovel,
  useNovels,
} from '@/hooks/use-novel-data'
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
import type { NovelListItem } from '@/lib/types'
import type { ThemeView, ViewProps } from '../types'
import {
  BlueTag,
  GH2,
  GCover,
  GEmptyBox,
  GErrorBox,
  GPager,
  GBoxSkeleton,
  GCoverSkeleton,
  GRowSkeleton,
  GBreadcrumb,
  GSkel,
  RedTag,
  dedupMerge,
  fmtDate,
  fmtWords,
  fmtWan,
  linkCls,
  statusLabel,
} from './ui'

type Nav = (v: ThemeView) => void

/** 容器：90% 宽、最大 1200px */
function Container({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`mx-auto w-[90%] max-w-[1200px] ${className ?? ''}`}>{children}</div>
}

/** 侧栏搜索框（2px 薄荷绿边、圆角 5px、输入 80% + 绿按钮 20%） */
function SearchBox({ navigate, initialValue = '' }: { navigate: Nav; initialValue?: string }) {
  const [kw, setKw] = useState(initialValue)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const q = kw.trim()
        if (q) navigate({ name: 'search', query: q })
      }}
      className="flex h-[38px] overflow-hidden rounded-[5px] border-2 border-[#56ccb5] bg-white"
    >
      <input
        value={kw}
        onChange={(e) => setKw(e.target.value)}
        placeholder="输入关键词"
        className="min-w-0 flex-[4] px-3 text-[14px] text-[#333] outline-none placeholder:text-[#bbb]"
      />
      <button
        type="submit"
        className="flex-[1] cursor-pointer bg-[#56ccb5] text-[13px] text-white transition-colors duration-200 hover:bg-[#48b9a2]"
      >
        搜索
      </button>
    </form>
  )
}

/** 榜单行：[分类] 书名 …… 右浮作者（28px 行高、虚线分隔） */
function RankRow({ novel, navigate }: { novel: NovelListItem; navigate: Nav }) {
  return (
    <div className="flex h-[28px] items-center gap-1 border-b border-dashed border-[#ccc] text-[13px]">
      <button
        onClick={() => navigate({ name: 'category', categoryId: novel.categoryId, page: 1 })}
        className="shrink-0 cursor-pointer text-[#00886d] transition-colors duration-200 hover:text-[#f50]"
      >
        [{novel.categoryName}]
      </button>
      <button
        onClick={() => navigate({ name: 'book', novelId: novel.id })}
        className="min-w-0 flex-1 cursor-pointer truncate text-left text-[#00886d] transition-colors duration-200 hover:text-[#f50]"
      >
        {novel.title}
      </button>
      <span className="shrink-0 text-[12px] text-[#999]">{novel.author}</span>
    </div>
  )
}

/** 最近更新五列字段行：分类 75px / 书名 165px / 最新章节 / 时间 90px / 作者 90px */
function UpdateRow({ novel, navigate }: { novel: NovelListItem; navigate: Nav }) {
  return (
    <div className="grid h-[28px] items-center border-b border-dashed border-[#ccc] text-[13px] grid-cols-[72px_minmax(0,1fr)_80px] md:grid-cols-[75px_165px_minmax(0,1fr)_85px] lg:grid-cols-[75px_165px_minmax(0,1fr)_85px_85px]">
      <button
        onClick={() => navigate({ name: 'category', categoryId: novel.categoryId, page: 1 })}
        className="cursor-pointer truncate pr-1 text-left text-[#00886d] transition-colors duration-200 hover:text-[#f50]"
      >
        {novel.categoryName}
      </button>
      <button
        onClick={() => navigate({ name: 'book', novelId: novel.id })}
        className="cursor-pointer truncate pr-1 text-left text-[#00886d] transition-colors duration-200 hover:text-[#f50]"
      >
        {novel.title}
      </button>
      <button
        onClick={() => navigate({ name: 'book', novelId: novel.id })}
        className="hidden cursor-pointer truncate pr-1 text-left text-[#00886d] transition-colors duration-200 hover:text-[#f50] md:block"
      >
        {novel.lastChapterTitle ?? '暂无章节'}
      </button>
      <span className="truncate text-right text-[#999]">{fmtDate(novel.updatedAt)}</span>
      <span className="hidden truncate text-right text-[#999] lg:block">{novel.author}</span>
    </div>
  )
}

/** 首页推荐项：左 120×150 封面 + 右 dl（书名/作者 点线分隔 + 缩进简介） */
function HotItem({ novel, navigate }: { novel: NovelListItem; navigate: Nav }) {
  return (
    <article className="flex gap-3">
      <button
        onClick={() => navigate({ name: 'book', novelId: novel.id })}
        className="h-[150px] w-[120px] shrink-0 cursor-pointer border border-[#ccc] bg-white p-[1px] transition-opacity duration-200 hover:opacity-90"
      >
        <GCover
          token={novel.cover}
          title={novel.title}
          className="h-full w-full"
          charClassName="text-[30px]"
        />
      </button>
      <dl className="min-w-0 flex-1">
        <dt className="flex h-[25px] items-center justify-between gap-2 border-b border-dotted border-[#ccc]">
          <button
            onClick={() => navigate({ name: 'book', novelId: novel.id })}
            className="min-w-0 flex-1 cursor-pointer truncate text-left text-[15px] font-bold text-[#00886d] transition-colors duration-200 hover:text-[#f50]"
          >
            {novel.title}
          </button>
          <span className="shrink-0 text-[12px] font-normal text-[#888]">{novel.author}</span>
        </dt>
        <dd
          onClick={() => navigate({ name: 'book', novelId: novel.id })}
          className="mt-2 h-[110px] cursor-pointer overflow-hidden text-[13px] leading-[22px] text-[#888] indent-[2em]"
        >
          {novel.description || '暂无简介'}
        </dd>
      </dl>
    </article>
  )
}

/** 分类/搜索列表格：虚线边框盒 + 左上角序号徽章 + 右侧“阅读”描边按钮 */
function BookBoxItem({
  novel,
  index,
  navigate,
}: {
  novel: NovelListItem
  index: number
  navigate: Nav
}) {
  return (
    <div
      onClick={() => navigate({ name: 'book', novelId: novel.id })}
      className="group relative flex cursor-pointer items-center gap-3 rounded-[4px] border border-dashed border-[#ccc] p-[10px] transition-colors duration-200 hover:border-[#f50]"
    >
      <span className="absolute -top-[8px] -left-[8px] grid h-[22px] w-[22px] place-items-center rounded-[4px] bg-[#56ccb5] text-[12px] text-white transition-colors duration-200 group-hover:bg-[#f50]">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-[15px] font-bold text-[#00886d] transition-colors duration-200 group-hover:text-[#f50]">
          {novel.title}
        </h4>
        <p className="mt-1 truncate text-[12px] text-[#999]">
          作者：{novel.author} · {fmtWords(novel.wordCount)} · 点击 {fmtWan(novel.clicks)}
        </p>
        <p className="mt-0.5 truncate text-[12px] text-[#999]">
          更新到：
          <span className="text-[#00886d]">{novel.lastChapterTitle ?? '暂无章节'}</span>
        </p>
        <p className="mt-1 line-clamp-2 text-[13px] text-[#888]">{novel.description || '暂无简介'}</p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          navigate({ name: 'book', novelId: novel.id })
        }}
        className="shrink-0 cursor-pointer rounded-[4px] border border-[#56ccb5] px-3 py-2 text-[13px] text-[#00886d] transition-colors duration-200 hover:border-[#f50] hover:text-[#f50]"
      >
        阅读
      </button>
    </div>
  )
}

/* ==================== 首页（宽主栏 + 窄侧栏 双行双栏） ==================== */

export function Home({ navigate }: ViewProps) {
  const home = useHomeData()
  const updates = useNovels({ sort: 'latest', page: 1, pageSize: 30 })

  if (home.isPending || updates.isPending) {
    return (
      <Container className="mt-2">
        <div className="grid gap-4 md:grid-cols-[minmax(0,73%)_minmax(0,1fr)]">
          <div>
            <GSkel className="mb-2 h-6 w-40" />
            <GCoverSkeleton count={4} />
          </div>
          <div>
            <GSkel className="mb-2 h-10 w-full" />
            <GSkel className="mb-2 h-6 w-32" />
            <GRowSkeleton count={10} />
          </div>
        </div>
      </Container>
    )
  }

  if (home.isError || !home.data) {
    return (
      <Container className="mt-4">
        <GErrorBox onRetry={() => home.refetch()} />
      </Container>
    )
  }
  if (updates.isError) {
    return (
      <Container className="mt-4">
        <GErrorBox onRetry={() => updates.refetch()} />
      </Container>
    )
  }

  const d = home.data
  const hotItems = d.hot.slice(0, 6)
  const clickRank = d.rankings.clicks.slice(0, 12)
  const updateRows = (updates.data?.list ?? []).slice(0, 30)
  const sideNews = dedupMerge(
    [d.featured, d.hot, d.rankings.clicks, d.rankings.updates, d.rankings.finished],
    30,
  )

  return (
    <Container className="mt-1">
      <div className="grid gap-5 md:grid-cols-[minmax(0,73%)_minmax(0,1fr)] md:gap-[2%]">
        {/* 第一行左：热门小说推荐（2 列封面简介卡） */}
        <section>
          <GH2>热门小说推荐</GH2>
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
            {hotItems.map((n) => (
              <HotItem key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
        </section>

        {/* 第一行右：搜索框 + 阅读排行榜 */}
        <aside>
          <SearchBox navigate={navigate} />
          <GH2 className="mt-4">阅读排行榜</GH2>
          <div>
            {clickRank.map((n) => (
              <RankRow key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
        </aside>

        {/* 第二行左：最近更新（五列字段表） */}
        <section>
          <GH2>最近更新</GH2>
          <div>
            {updateRows.map((n) => (
              <UpdateRow key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
        </section>

        {/* 第二行右：最新小说（两字段行榜单） */}
        <aside>
          <GH2>最新小说</GH2>
          <div>
            {sideNews.map((n) => (
              <RankRow key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
        </aside>
      </div>
    </Container>
  )
}

/* ==================== 分类页（分类导航条 + 3 列虚线盒 + 数字分页） ==================== */

export function Category({
  navigate,
  categoryId,
  page = 1,
}: ViewProps & { categoryId?: number; page?: number }) {
  const cats = useCategories()
  const list = useNovels({ categoryId, page, pageSize: 20 })
  const catName = cats.data?.find((c) => c.id === categoryId)?.name

  const navCls = (active: boolean) =>
    active
      ? 'grid place-items-center h-[38px] rounded-[3px] bg-[#56ccb5] text-[15px] text-white transition-colors duration-200 cursor-pointer'
      : 'grid place-items-center h-[38px] cursor-pointer rounded-[3px] text-[15px] text-[#00886d] transition-colors duration-200 hover:bg-[#cdf3eb] hover:text-[#f50]'

  return (
    <Container className="mt-1">
      {/* 分类导航条 */}
      <nav className="mb-3 grid grid-cols-3 gap-1 rounded-[4px] border border-[#ccc] bg-white p-1 sm:grid-cols-4 md:grid-cols-8">
        <button
          onClick={() => navigate({ name: 'category', page: 1 })}
          className={navCls(categoryId == null)}
        >
          全部
        </button>
        {(cats.data ?? []).map((c) => (
          <button
            key={c.id}
            onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
            className={navCls(categoryId === c.id)}
          >
            {c.name}
          </button>
        ))}
      </nav>

      {/* 书籍列表 */}
      <section className="rounded-[4px] border border-[#ccc] bg-white p-3">
        <GH2 className="text-center">
          {catName ?? '全部小说'}
          {list.data ? <span className="ml-2 text-[13px] font-normal text-[#999]">共 {list.data.total} 本</span> : null}
        </GH2>

        {list.isPending ? (
          <GBoxSkeleton count={6} />
        ) : list.isError ? (
          <GErrorBox onRetry={() => list.refetch()} />
        ) : (list.data?.list.length ?? 0) === 0 ? (
          <GEmptyBox text="该分类下暂无收录小说" />
        ) : (
          <>
            <div className="grid gap-4 pt-2 sm:grid-cols-2 lg:grid-cols-3">
              {list.data!.list.map((n, i) => (
                <BookBoxItem
                  key={n.id}
                  novel={n}
                  index={(list.data!.page - 1) * (list.data!.pageSize ?? 20) + i + 1}
                  navigate={navigate}
                />
              ))}
            </div>
            <GPager
              page={list.data!.page}
              totalPages={list.data!.totalPages}
              onGo={(p) => navigate({ name: 'category', categoryId, page: p })}
            />
          </>
        )}
      </section>
    </Container>
  )
}

/* ==================== 书籍详情页（目录内嵌：最新 12 条 + 全部 4 列） ==================== */

function ChapterDD({
  chapters,
  navigate,
  cols,
}: {
  chapters: { id: number; idx: number; title: string }[]
  navigate: Nav
  cols: string
}) {
  return (
    <div className={`grid gap-x-3 ${cols}`}>
      {chapters.map((c) => (
        <button
          key={c.id}
          onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
          className="h-[28px] cursor-pointer truncate border-b border-dashed border-[#ccc] px-1 text-left text-[13px] text-[#00886d] transition-colors duration-200 hover:text-[#f50]"
        >
          {c.title}
        </button>
      ))}
    </div>
  )
}

export function Book({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isPending, isError, refetch } = useNovel(novelId)
  const chapters = useChapters(novelId)
  const [showAll, setShowAll] = useState(false)

  if (isPending) {
    return (
      <Container className="mt-1">
        <GSkel className="mb-3 h-10 w-full" />
        <div className="rounded-[4px] border border-[#ccc] bg-white p-4">
          <div className="flex gap-4">
            <GSkel className="hidden h-[190px] w-[160px] sm:block" />
            <div className="flex-1 space-y-3">
              <GSkel className="h-6 w-1/2" />
              <GSkel className="h-4 w-3/4" />
              <GSkel className="h-3 w-full" />
              <GSkel className="h-3 w-5/6" />
              <GSkel className="h-9 w-48" />
            </div>
          </div>
        </div>
      </Container>
    )
  }

  if (isError || !novel) {
    return (
      <Container className="mt-4">
        <GErrorBox onRetry={() => refetch()} />
      </Container>
    )
  }

  const full = chapters.data ?? []
  const latest12 = full.slice(-12).reverse()

  return (
    <Container className="mt-1">
      <GBreadcrumb
        items={[
          { label: '首页', view: { name: 'home' } },
          { label: novel.categoryName, view: { name: 'category', categoryId: novel.categoryId, page: 1 } },
          { label: novel.title },
        ]}
        navigate={navigate}
      />

      {/* 头部信息卡 */}
      <section className="rounded-[4px] border border-[#ccc] bg-white p-4 shadow-sm">
        <div className="flex gap-4">
          <div className="hidden w-[160px] shrink-0 sm:block">
            <div className="rounded-[4px] border border-[#ddd] bg-white p-[4px]">
              <GCover
                token={novel.cover}
                title={novel.title}
                className="h-[180px] w-full"
                charClassName="text-[40px]"
              />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-bold text-[#56ccb5]">{novel.title}</h1>
            <div className="mt-2 flex flex-wrap gap-2">
              <RedTag onClick={() => navigate({ name: 'search', query: novel.author })}>
                作者：{novel.author}
              </RedTag>
              <BlueTag>字数：{fmtWords(novel.wordCount)}</BlueTag>
              <BlueTag>阅读：{fmtWan(novel.clicks)}人次</BlueTag>
              <RedTag>{statusLabel(novel.status)}</RedTag>
            </div>
            <p className="mt-3 h-[110px] overflow-hidden text-[14px] leading-[1.7] text-[#888]">
              {novel.description || '暂无简介'}
            </p>
            <p className="mt-2 text-[13px] text-[#888]">
              最新章节：
              {novel.lastChapterId ? (
                <button
                  onClick={() => navigate({ name: 'chapter', chapterId: novel.lastChapterId! })}
                  className={linkCls}
                >
                  {novel.lastChapterTitle ?? '查看'}
                </button>
              ) : (
                <span className="text-[#999]">暂无章节</span>
              )}
            </p>
            <p className="mt-1 text-[13px] text-[#999]">更新时间：{fmtDate(novel.updatedAt)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                disabled={!novel.firstChapterId}
                onClick={() =>
                  novel.firstChapterId && navigate({ name: 'chapter', chapterId: novel.firstChapterId })
                }
                className="cursor-pointer rounded-[4px] bg-[#56ccb5] px-5 py-2 text-[14px] text-white transition-colors duration-200 hover:bg-[#48b9a2] disabled:pointer-events-none disabled:opacity-40"
              >
                开始阅读
              </button>
              <button
                onClick={() => navigate({ name: 'toc', novelId: novel.id })}
                className="cursor-pointer rounded-[4px] bg-[#56ccb5] px-5 py-2 text-[14px] text-white transition-colors duration-200 hover:bg-[#48b9a2]"
              >
                章节目录
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 相关搜索：绑定下拉词 → PSEO 落地页内链（无词时组件不渲染，不留空卡） */}
      <BookSuggestLinks keywords={novel.suggestKeywords} className="mt-3 rounded-[4px] border border-[#ccc] bg-white p-3" />

      {/* 最新章节（4 列虚线行） */}
      <section className="mt-3 rounded-[4px] border border-[#ccc] bg-white p-3">
        <GH2>最新章节</GH2>
        {chapters.isPending ? (
          <GRowSkeleton count={6} />
        ) : chapters.isError ? (
          <GErrorBox msg="章节加载失败" onRetry={() => chapters.refetch()} />
        ) : latest12.length === 0 ? (
          <GEmptyBox text="暂无章节" />
        ) : (
          <ChapterDD
            chapters={latest12}
            navigate={navigate}
            cols="grid-cols-1 min-[468px]:grid-cols-2 md:grid-cols-4"
          />
        )}
        <button
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 w-full cursor-pointer rounded-[4px] border border-[#56ccb5] py-2 text-[13px] text-[#00886d] transition-colors duration-200 hover:border-[#f50] hover:text-[#f50] md:hidden"
        >
          查看全部章节 {showAll ? '↑' : '↓'}
        </button>
      </section>

      {/* 全部章节目录（移动端默认折叠） */}
      <section
        className={`mt-3 rounded-[4px] border border-[#ccc] bg-white p-3 ${showAll ? '' : 'hidden md:block'}`}
      >
        <GH2>全部章节目录（共 {full.length || novel.totalChapters} 章）</GH2>
        {chapters.isPending ? (
          <GRowSkeleton count={12} />
        ) : chapters.isError ? (
          <GErrorBox msg="目录加载失败" onRetry={() => chapters.refetch()} />
        ) : full.length === 0 ? (
          <GEmptyBox text="暂无章节" />
        ) : (
          /* 列优先分栏（columns）：阅读顺序自上而下；有分卷数据时按卷分组渲染 */
          <TocChapters
            chapters={full}
            navigate={navigate}
            columnsClassName="columns-1 gap-x-3 min-[468px]:columns-2 md:columns-3 lg:columns-4"
            itemClassName="h-[28px] border-b border-dashed border-[#ccc] px-1 text-[13px] text-[#00886d] transition-colors duration-200 hover:text-[#f50]"
            volumeClassName="border-b border-[#56ccb5]/60 bg-[#eafaf6] px-1 py-1.5 text-[13px] font-bold text-[#00886d]"
            countClassName="text-[11px] text-[#999]"
          />
        )}
      </section>
    </Container>
  )
}

/* ==================== 目录页（同风格完整列表页） ==================== */

export function Toc({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel } = useNovel(novelId)
  const { data: chapters, isPending, isError, refetch } = useChapters(novelId)

  return (
    <Container className="mt-1">
      <GBreadcrumb
        items={[
          { label: '首页', view: { name: 'home' } },
          { label: novel?.title ?? '…', view: { name: 'book', novelId } },
          { label: '全部章节目录' },
        ]}
        navigate={navigate}
      />
      <section className="rounded-[4px] border border-[#ccc] bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <GH2 className="mb-0 flex-1">
            {novel ? `${novel.title} · 全部章节目录` : '全部章节目录'}
            {chapters ? (
              <span className="ml-2 text-[13px] font-normal text-[#999]">共 {chapters.length} 章</span>
            ) : null}
          </GH2>
          <button
            onClick={() => navigate({ name: 'book', novelId })}
            className="cursor-pointer rounded-[4px] border border-[#ccc] bg-white px-4 py-1.5 text-[13px] text-[#333] transition-colors duration-200 hover:border-[#56ccb5] hover:text-[#56ccb5]"
          >
            返回书页
          </button>
        </div>
        {/* 最新章节（全书倒数 12 章，新→旧） */}
        {chapters && chapters.length > 0 && (
          <div className="mb-2 border-b border-[#ccc] pb-3">
            <GH2>
              最新章节
              <span className="ml-2 text-[13px] font-normal text-[#999]">最近更新 12 章 · 新→旧</span>
            </GH2>
            <ChapterDD
              chapters={[...chapters].slice(-12).reverse()}
              navigate={navigate}
              cols="grid-cols-1 min-[468px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
            />
          </div>
        )}
        <div className="mt-2">
          {isPending ? (
            <GRowSkeleton count={16} />
          ) : isError ? (
            <GErrorBox onRetry={() => refetch()} />
          ) : (chapters?.length ?? 0) === 0 ? (
            <GEmptyBox text="暂无章节" />
          ) : (
            /* 列优先分栏（columns）：阅读顺序自上而下；有分卷数据时按卷分组渲染 */
            <TocChapters
              chapters={chapters!}
              navigate={navigate}
              columnsClassName="columns-1 gap-x-3 min-[468px]:columns-2 md:columns-3 lg:columns-4"
              itemClassName="h-[28px] border-b border-dashed border-[#ccc] px-1 text-[13px] text-[#00886d] transition-colors duration-200 hover:text-[#f50]"
              volumeClassName="border-b border-[#56ccb5]/60 bg-[#eafaf6] px-1 py-1.5 text-[13px] font-bold text-[#00886d]"
              countClassName="text-[11px] text-[#999]"
            />
          )}
        </div>
      </section>
    </Container>
  )
}

/* ==================== 章节正文页（米黄纸感 + 大字排版 + 三按钮翻页 + 阅读设置） ==================== */

/* 场景配色：日间沿用米黄纸面，其余按语义键换肤 */
const SCENES: Record<string, ReaderSceneColors> = {
  day: { page: '', paper: '#FBF4EC', ink: '#333333', muted: '#999999', line: '#ccc' },
  paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#d4c5a3' },
  green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', muted: '#8fa590', line: '#bcd4bc' },
  blue: { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', muted: '#8fa2b0', line: '#b8cede' },
  night: { page: '#1e2024', paper: '#26262b', ink: '#c0c0c6', muted: '#8a8a92', line: '#3a3a42' },
}

/** 阅读设置条：字号 A± / 行距 / 字体 / 字色 / 背景（跨主题共享同一份偏好，localStorage 持久化） */
function SettingsBar() {
  const [prefs] = useReaderPrefs()
  const btn =
    'h-[24px] min-w-[28px] cursor-pointer border border-[#ccc] bg-white px-1.5 text-[12px] leading-[22px] text-[#333] transition-colors duration-200 hover:border-[#56ccb5] hover:text-[#00886d]'
  const on = 'border-[#56ccb5] bg-[#eafaf6] text-[#00886d]'
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-b border-[#ccc] px-2 py-2 text-[12px] text-[#888]">
      <span className="flex items-center gap-1">
        字号
        <button type="button" title="减小字号" className={btn} onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, -1) })}>
          A-
        </button>
        <button type="button" title="增大字号" className={btn} onClick={() => setReaderPrefs({ fontSize: stepFontSize(prefs.fontSize, 1) })}>
          A+
        </button>
        <span className="w-[32px] text-right">{prefs.fontSize}px</span>
      </span>
      <span className="flex items-center gap-1">
        行距
        {READER_LINE_HEIGHTS.map((lh) => (
          <button key={lh} type="button" className={`${btn} ${prefs.lineHeight === lh ? on : ''}`} onClick={() => setReaderPrefs({ lineHeight: lh })}>
            {lh.toFixed(1)}
          </button>
        ))}
      </span>
      <label className="flex items-center gap-1">
        字体
        <select
          value={prefs.font}
          onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
          className="h-[24px] cursor-pointer border border-[#ccc] bg-white px-1 text-[12px] text-[#333] outline-none"
        >
          <option value="default">默认</option>
          <option value="song">宋体</option>
          <option value="hei">黑体</option>
          <option value="kai">楷体</option>
        </select>
      </label>
      <label className="flex items-center gap-1">
        字色
        <select
          value={prefs.ink}
          onChange={(e) => setReaderPrefs({ ink: e.target.value })}
          aria-label="字色"
          className="h-[24px] cursor-pointer border border-[#ccc] bg-white px-1 text-[12px] text-[#333] outline-none"
        >
          {READER_INKS.map((c) => (
            <option key={c.k} value={c.v}>{c.k}</option>
          ))}
        </select>
      </label>
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
              prefs.scene === s.key ? 'scale-110 border-[#00886d]' : 'border-black/25'
            }`}
            style={{ background: SCENES[s.key].paper }}
          />
        ))}
      </span>
      <button type="button" className="cursor-pointer text-[11px] text-[#999] hover:text-[#f50]" onClick={resetReaderPrefs}>
        恢复默认
      </button>
    </div>
  )
}

function RelatedBooks({ categoryId, excludeId, navigate }: { categoryId: number; excludeId: number; navigate: Nav }) {
  const q = useNovels({ categoryId, page: 1, pageSize: 12 })
  const rows = (q.data?.list ?? []).filter((n) => n.id !== excludeId).slice(0, 10)
  if (rows.length === 0) return null
  return (
    <section className="mt-3 rounded-[4px] border border-[#ccc] bg-white p-3 text-[13px]">
      <strong className="text-[#333]">相关阅读：</strong>
      <span className="ml-1 inline-flex flex-wrap gap-x-[10px] gap-y-1 align-baseline">
        {rows.map((n) => (
          <button
            key={n.id}
            onClick={() => navigate({ name: 'book', novelId: n.id })}
            className={linkCls}
          >
            {n.title}
          </button>
        ))}
      </span>
    </section>
  )
}

export function Chapter({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const { data: ch, isPending, isError, refetch } = useChapter(chapterId)
  const novel = useNovel(ch?.novelId)
  const [prefs] = useReaderPrefs()

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [chapterId])

  /* 键盘翻页：Enter 返回书目 / ← 上一章 / → 下一章（焦点在输入框/下拉/按钮上时不触发，避免误触与双重导航） */
  useEffect(() => {
    if (!ch) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable)) return
      if (e.key === 'Enter') {
        navigate({ name: 'toc', novelId: ch.novelId })
      } else if (e.key === 'ArrowLeft' && ch.prevId) {
        navigate({ name: 'chapter', chapterId: ch.prevId })
      } else if (e.key === 'ArrowRight' && ch.nextId) {
        navigate({ name: 'chapter', chapterId: ch.nextId })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ch, navigate])

  if (isPending) {
    return (
      <Container className="mt-1">
        <GSkel className="mb-3 h-10 w-full" />
        <div className="rounded-[4px] border border-[#ccc] bg-[#FBF4EC] p-4">
          <GSkel className="mx-auto h-7 w-1/2" />
          <div className="mt-6 space-y-4">
            {Array.from({ length: 9 }, (_, i) => (
              <GSkel key={i} className="h-5 w-full" />
            ))}
          </div>
        </div>
      </Container>
    )
  }

  if (isError || !ch) {
    return (
      <Container className="mt-4">
        <GErrorBox onRetry={() => refetch()} />
      </Container>
    )
  }

  const paragraphs = ch.content.split('\n').map((s) => s.trim()).filter(Boolean)
  const scene = SCENES[prefs.scene] ?? SCENES.day

  const navBtnCls =
    'cursor-pointer rounded-[4px] border border-[#ccc] bg-white py-2 text-[15px] text-[#333] transition-colors duration-200 hover:border-[#56ccb5] hover:text-[#00886d] disabled:pointer-events-none disabled:opacity-40'

  return (
    <Container className="mt-1">
      <GBreadcrumb
        items={[
          { label: '首页', view: { name: 'home' } },
          ...(novel.data
            ? [
                {
                  label: novel.data.categoryName,
                  view: {
                    name: 'category' as const,
                    categoryId: novel.data.categoryId,
                    page: 1,
                  },
                },
              ]
            : []),
          { label: ch.novelTitle, view: { name: 'book', novelId: ch.novelId } },
          { label: ch.title },
        ]}
        navigate={navigate}
      />

      {/* 阅读卡（米黄底，阅读场景换肤） */}
      <article className="rounded-[4px] border p-3 transition-colors" style={{ background: scene.paper, borderColor: scene.line }}>
        <h1 className="px-2 py-3 text-center text-[20px] font-bold md:text-[26px]" style={{ color: scene.ink }}>
          {ch.title}
        </h1>
        <div className="pb-2 text-center">
          <MarkButton key={`${ch.novelId}-${ch.id}`} novelId={ch.novelId} chapterId={ch.id} />
        </div>
        <SettingsBar />
        <div
          className="break-words border-t px-3 py-2 tracking-[0.1em]"
          style={{
            borderColor: scene.line,
            fontSize: prefs.fontSize,
            lineHeight: prefs.lineHeight,
            fontFamily: readerFontStack(prefs.font),
            color: readerInk(prefs, scene),
          }}
        >
          {paragraphs.length === 0 ? (
            <p className="my-[10px]" style={{ color: scene.muted }}>本章内容为空</p>
          ) : (
            paragraphs.map((p, i) => (
              <p key={i} className="my-[10px] indent-[2em]">
                {p}
              </p>
            ))
          )}
        </div>

        {/* 翻页导航：上一章 / 书页目录 / 下一章（移动端换行堆叠） */}
        <div className="flex flex-wrap justify-center gap-2 px-2 pt-3 pb-1">
          <button
            disabled={!ch.prevId}
            onClick={() => ch.prevId && navigate({ name: 'chapter', chapterId: ch.prevId })}
            className={`${navBtnCls} w-[46%] md:w-[30%]`}
          >
            上一章
          </button>
          <button
            onClick={() => navigate({ name: 'toc', novelId: ch.novelId })}
            className={`${navBtnCls} w-[46%] md:w-[30%]`}
          >
            书页目录
          </button>
          <button
            disabled={!ch.nextId}
            onClick={() => ch.nextId && navigate({ name: 'chapter', chapterId: ch.nextId })}
            className={`${navBtnCls} w-[94%] md:w-[30%]`}
          >
            下一章
          </button>
        </div>
        <p className="hidden pb-1 text-center text-[12px] text-[#999] md:block">
          键盘操作：Enter 返回书目 · ← 上一章 · → 下一章
        </p>
      </article>

      {/* 相关阅读 */}
      {novel.data ? (
        <RelatedBooks
          categoryId={novel.data.categoryId}
          excludeId={ch.novelId}
          navigate={navigate}
        />
      ) : null}
    </Container>
  )
}

/* ==================== 书签（localStorage 按书分组持久化，与其他主题行为一致） ==================== */

function loadMarks(novelId: number): number[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(window.localStorage.getItem(`ggd66-marks-${novelId}`) ?? '[]') as number[]
  } catch {
    return []
  }
}

function toggleMark(novelId: number, chapterId: number): boolean {
  if (typeof window === 'undefined') return false
  try {
    const arr = loadMarks(novelId)
    const has = arr.includes(chapterId)
    window.localStorage.setItem(
      `ggd66-marks-${novelId}`,
      JSON.stringify(has ? arr.filter((x) => x !== chapterId) : [...arr.slice(-199), chapterId]),
    )
    return !has
  } catch {
    return false
  }
}

function MarkButton({ novelId, chapterId }: { novelId: number; chapterId: number }) {
  /* 视图仅客户端挂载，惰性读 storage 恢复已存书签 */
  const [marked, setMarked] = useState(() => loadMarks(novelId).includes(chapterId))
  return (
    <button
      onClick={() => setMarked(toggleMark(novelId, chapterId))}
      className="cursor-pointer rounded-full border border-[#ffb0b4] bg-white/70 px-4 py-[3px] text-[12px] text-[#bf2c24] transition-colors duration-200 hover:border-[#f50] hover:text-[#f50]"
    >
      {marked ? '已加入书签 ✓' : '加入书签'}
    </button>
  )
}

/* ==================== 搜索页 ==================== */

export function Search({ navigate, query }: ViewProps & { query: string }) {
  return (
    <Container className="mt-1">
      <GBreadcrumb
        items={[{ label: '首页', view: { name: 'home' } }, { label: '搜索' }]}
        navigate={navigate}
      />
      <section className="rounded-[4px] border border-[#ccc] bg-white p-3">
        {/* key=query：关键词变化时重挂载，重置输入框与分页 */}
        <SearchPanel key={query} query={query} navigate={navigate} />
      </section>
    </Container>
  )
}

function SearchPanel({ query, navigate }: { query: string; navigate: Nav }) {
  const [input, setInput] = useState(query)
  const [page, setPage] = useState(1)
  const list = useNovels({ q: query || undefined, page, pageSize: 20 })

  return (
    <>
      <SearchBox navigate={navigate} initialValue={query} />
      <GH2 className="mt-3">
        {query ? (
          <>
            搜索“{query}”
            {list.data ? (
              <span className="ml-2 text-[13px] font-normal text-[#999]">共 {list.data.total} 条</span>
            ) : null}
          </>
        ) : (
          '输入关键词开始搜索'
        )}
      </GH2>

      {list.isPending ? (
        <GBoxSkeleton count={6} />
      ) : list.isError ? (
        <GErrorBox onRetry={() => list.refetch()} />
      ) : (list.data?.list.length ?? 0) === 0 ? (
        <GEmptyBox text={`没有找到与“${query}”相关的小说，换个关键词试试`} />
      ) : (
        <>
          <div className="grid gap-4 pt-1 sm:grid-cols-2 lg:grid-cols-3">
            {list.data!.list.map((n, i) => (
              <BookBoxItem
                key={n.id}
                novel={n}
                index={(list.data!.page - 1) * (list.data!.pageSize ?? 20) + i + 1}
                navigate={navigate}
              />
            ))}
          </div>
          <GPager
            page={list.data!.page}
            totalPages={list.data!.totalPages}
            onGo={(p) => setPage(p)}
          />
        </>
      )}
    </>
  )
}
