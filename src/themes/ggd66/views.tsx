'use client'

import { useEffect, useState } from 'react'
import {
  useCategories,
  useChapter,
  useChapters,
  useHomeData,
  useNovel,
  useNovels,
} from '@/hooks/use-novel-data'
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
    <div className="grid h-[28px] items-center border-b border-dashed border-[#ccc] text-[13px] grid-cols-[72px_1fr_80px] md:grid-cols-[75px_165px_1fr_85px] lg:grid-cols-[75px_165px_1fr_85px_85px]">
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
        <div className="grid gap-4 md:grid-cols-[73%_1fr]">
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
      <div className="grid gap-5 md:grid-cols-[73%_1fr] md:gap-[2%]">
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
          <ChapterDD
            chapters={full}
            navigate={navigate}
            cols="grid-cols-1 min-[468px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
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
        <div className="mt-2">
          {isPending ? (
            <GRowSkeleton count={16} />
          ) : isError ? (
            <GErrorBox onRetry={() => refetch()} />
          ) : (chapters?.length ?? 0) === 0 ? (
            <GEmptyBox text="暂无章节" />
          ) : (
            <ChapterDD
              chapters={chapters!}
              navigate={navigate}
              cols="grid-cols-1 min-[468px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
            />
          )}
        </div>
      </section>
    </Container>
  )
}

/* ==================== 章节正文页（米黄纸感 + 大字排版 + 三按钮翻页） ==================== */

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
  /* 书签按章记忆：换章后自动失效（无 effect setState） */
  const [mark, setMark] = useState<{ id: number; on: boolean }>({ id: 0, on: false })

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [chapterId])

  /* 键盘翻页：Enter 返回书目 / ← 上一章 / → 下一章 */
  useEffect(() => {
    if (!ch) return
    const onKey = (e: KeyboardEvent) => {
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

      {/* 阅读卡（米黄底） */}
      <article className="rounded-[4px] border border-[#ccc] bg-[#FBF4EC] p-3">
        <h1 className="px-2 py-3 text-center text-[20px] font-bold text-[#00886d] md:text-[26px]">
          {ch.title}
        </h1>
        <div className="pb-2 text-center">
          <button
            onClick={() => setMark({ id: ch.id, on: !(mark.id === ch.id && mark.on) })}
            className="cursor-pointer rounded-full border border-[#ffb0b4] bg-white/70 px-4 py-[3px] text-[12px] text-[#bf2c24] transition-colors duration-200 hover:border-[#f50] hover:text-[#f50]"
          >
            {mark.id === ch.id && mark.on ? '已加入书签 ✓' : '加入书签'}
          </button>
        </div>
        <div className="border-t border-[#ccc] px-3 py-2 text-[18px] leading-[180%] tracking-[0.1em] text-[#333] min-[468px]:text-[24px]">
          {paragraphs.length === 0 ? (
            <p className="my-[10px] text-[#999]">本章内容为空</p>
          ) : (
            paragraphs.map((p, i) => <p key={i} className="my-[10px]">{p}</p>)
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
