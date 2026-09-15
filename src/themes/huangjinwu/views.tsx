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
  BookTextCard,
  CardGridSkeleton,
  CatBadge,
  Cover,
  Crumb,
  EmptyBox,
  ErrorBox,
  GhostBadge,
  Pager,
  PillSkeleton,
  RankSkeleton,
  RankingModule,
  SectionTitle,
  Skel,
  SoftBadge,
  dedupMerge,
  fmtDate,
  fmtWords,
  fmtWan,
  statusLabel,
} from './ui'

type Nav = (v: ThemeView) => void

/* ==================== 首页 ==================== */

export function Home({ navigate }: ViewProps) {
  const { data, isPending, isError, refetch } = useHomeData()

  if (isPending) {
    return (
      <div className="mx-auto max-w-[1180px] space-y-10 px-4 py-8">
        {[0, 1, 2].map((s) => (
          <section key={s}>
            <Skel className="mb-5 h-7 w-40" />
            <CardGridSkeleton />
          </section>
        ))}
        <section>
          <Skel className="mb-5 h-7 w-40" />
          <PillSkeleton count={12} />
        </section>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="mx-auto max-w-[1180px] px-4 py-10">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  const rankModules = [
    { title: '点击排行榜', rows: data.rankings.clicks },
    { title: '更新速度榜', rows: data.rankings.updates },
    { title: '完本精选榜', rows: data.rankings.finished },
    { title: '人气热门榜', rows: data.hot },
    { title: '编辑精选榜', rows: data.featured },
    { title: '最新上架榜', rows: data.latest },
  ]
  const pillNovels = dedupMerge(
    [data.latest, data.featured, data.hot, data.rankings.clicks],
    24,
  )

  return (
    <div className="mx-auto max-w-[1180px] space-y-10 px-4 py-8">
      {/* 热门推荐 3×2 文字卡 */}
      <section>
        <SectionTitle title="热门推荐" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.hot.slice(0, 6).map((n) => (
            <BookTextCard key={n.id} novel={n} navigate={navigate} />
          ))}
        </div>
      </section>

      {/* 分类排行榜 3×2 榜单模块 */}
      <section>
        <SectionTitle title="分类排行榜" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rankModules.map((m) => (
            <RankingModule key={m.title} title={m.title} novels={m.rows} navigate={navigate} />
          ))}
        </div>
      </section>

      {/* 最新更新 文字卡流 */}
      <section>
        <SectionTitle title="最新更新" small="每日持续更新中" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.latest.slice(0, 18).map((n) => (
            <BookTextCard key={n.id} novel={n} navigate={navigate} />
          ))}
        </div>
      </section>

      {/* 最新电子书 胶囊栅格 */}
      <section>
        <SectionTitle title="最新电子书" />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
          {pillNovels.map((n) => (
            <button
              key={n.id}
              onClick={() => navigate({ name: 'book', novelId: n.id })}
              className="cursor-pointer truncate rounded-full border border-[#e6edf7] bg-white px-5 py-3 text-[14px] text-[#1e293b] shadow-[0_1px_3px_rgba(37,99,235,0.06)] transition-all duration-200 hover:border-[#2563eb]/40 hover:text-[#2563eb] hover:shadow-[0_4px_12px_rgba(37,99,235,0.12)]"
            >
              《{n.title}》
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

/* ==================== 分类 / 书库页 ==================== */

export function Category({
  navigate,
  categoryId,
  page = 1,
}: ViewProps & { categoryId?: number; page?: number }) {
  const cats = useCategories()
  const list = useNovels({ categoryId, page, pageSize: 20 })

  const catName = cats.data?.find((c) => c.id === categoryId)?.name

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6">
      <Crumb items={[{ label: '首页', view: { name: 'home' } }, { label: '小说书库' }]} navigate={navigate} />
      <h1 className="border-l-4 border-[#2563eb] pl-4 text-[24px] leading-8 font-semibold text-[#1e293b]">
        {catName ?? '小说书库'}
        {cats.data ? (
          <span className="ml-3 text-[13px] font-normal text-[#94a3b8]">
            {cats.data.find((c) => c.id === categoryId)?.novelCount ?? list.data?.total ?? ''}
          </span>
        ) : null}
      </h1>

      {/* 筛选条 */}
      <div className="flex flex-wrap gap-2 rounded-[10px] border border-[#e6edf7] bg-white p-4 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
        <button
          onClick={() => navigate({ name: 'category', page: 1 })}
          className={
            categoryId == null
              ? 'cursor-pointer rounded-full bg-[#2563eb] px-4 py-1.5 text-[13px] text-white transition-colors duration-200'
              : 'cursor-pointer rounded-full bg-[#f0f4fb] px-4 py-1.5 text-[13px] text-[#1e293b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]'
          }
        >
          全部
        </button>
        {(cats.data ?? []).map((c) => (
          <button
            key={c.id}
            onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
            className={
              categoryId === c.id
                ? 'cursor-pointer rounded-full bg-[#2563eb] px-4 py-1.5 text-[13px] text-white transition-colors duration-200'
                : 'cursor-pointer rounded-full bg-[#f0f4fb] px-4 py-1.5 text-[13px] text-[#1e293b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]'
            }
          >
            {c.name}
          </button>
        ))}
      </div>

      {list.isPending ? (
        <CardGridSkeleton count={6} />
      ) : list.isError ? (
        <ErrorBox onRetry={() => list.refetch()} />
      ) : (list.data?.list.length ?? 0) === 0 ? (
        <EmptyBox text="该分类下暂无收录小说" />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.data!.list.map((n) => (
              <BookTextCard key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
          <Pager
            page={list.data!.page}
            totalPages={list.data!.totalPages}
            onGo={(p) => navigate({ name: 'category', categoryId, page: p })}
          />
        </>
      )}
    </div>
  )
}

/* ==================== 书籍详情页（目录内嵌） ==================== */

function ChapterPills({
  chapters,
  navigate,
  showIndex = true,
}: {
  chapters: { id: number; idx: number; title: string }[]
  navigate: Nav
  showIndex?: boolean
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
      {chapters.map((c) => (
        <button
          key={c.id}
          onClick={() => navigate({ name: 'chapter', chapterId: c.id })}
          className="cursor-pointer truncate rounded-[10px] border border-[#e6edf7] bg-white px-4 py-2.5 text-left text-[14px] text-[#1e293b] shadow-[0_1px_2px_rgba(37,99,235,0.05)] transition-colors duration-200 hover:border-[#2563eb]/40 hover:bg-[#e8f1ff] hover:text-[#2563eb]"
        >
          {showIndex ? <span className="mr-1 text-[#94a3b8]">{c.idx}.</span> : null}
          {c.title}
        </button>
      ))}
    </div>
  )
}

export function Book({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel, isPending, isError, refetch } = useNovel(novelId)
  const chapters = useChapters(novelId)
  const [expanded, setExpanded] = useState(false)

  if (isPending) {
    return (
      <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6">
        <Skel className="h-4 w-64" />
        <div className="flex flex-col gap-6 rounded-[10px] border border-[#e6edf7] bg-white p-6 sm:flex-row">
          <Skel className="h-[250px] w-[180px] rounded-[10px]" />
          <div className="flex-1 space-y-4 py-2">
            <Skel className="h-8 w-1/2" />
            <Skel className="h-4 w-3/4" />
            <Skel className="h-4 w-2/3" />
            <Skel className="h-10 w-56 rounded-[10px]" />
          </div>
        </div>
        <CardGridSkeleton count={3} />
      </div>
    )
  }

  if (isError || !novel) {
    return (
      <div className="mx-auto max-w-[1180px] px-4 py-10">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  const fullChapters = chapters.data ?? []

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6">
      <Crumb
        items={[
          { label: '首页', view: { name: 'home' } },
          { label: novel.categoryName, view: { name: 'category', categoryId: novel.categoryId } },
          { label: novel.title },
        ]}
        navigate={navigate}
      />

      {/* 头部卡：封面 180×250 左置 */}
      <section className="flex flex-col gap-6 rounded-[10px] border border-[#e6edf7] bg-white p-6 shadow-[0_1px_3px_rgba(37,99,235,0.06)] sm:flex-row">
        <Cover
          token={novel.cover}
          title={novel.title}
          className="h-[250px] w-[180px] rounded-[10px]"
          charClassName="text-[56px]"
        />
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px] leading-9 font-semibold text-[#1e293b]">{novel.title}</h1>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-[#64748b]">
            <span>作者：{novel.author}</span>
            <button
              onClick={() => navigate({ name: 'category', categoryId: novel.categoryId })}
              className="cursor-pointer transition-colors duration-200 hover:text-[#2563eb]"
            >
              分类：{novel.categoryName}
            </button>
            <span>状态：{statusLabel(novel.status)}</span>
            <span>字数：{fmtWords(novel.wordCount)}</span>
            <span>点击：{fmtWan(novel.clicks)}</span>
            <span>共 {novel.totalChapters} 章</span>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              disabled={!novel.firstChapterId}
              onClick={() =>
                novel.firstChapterId && navigate({ name: 'chapter', chapterId: novel.firstChapterId })
              }
              className="min-w-[128px] cursor-pointer rounded-[10px] bg-[#2563eb] px-6 py-2.5 text-[14px] text-white transition-colors duration-200 hover:bg-[#1d4ed8] disabled:pointer-events-none disabled:opacity-40"
            >
              开始阅读
            </button>
            <button
              onClick={() => navigate({ name: 'toc', novelId: novel.id })}
              className="min-w-[128px] cursor-pointer rounded-[10px] border-[1.5px] border-[#dbe4f0] bg-white px-6 py-2.5 text-[14px] text-[#1e293b] transition-colors duration-200 hover:border-[#2563eb] hover:text-[#2563eb]"
            >
              章节目录
            </button>
          </div>
        </div>
      </section>

      {/* 作品简介 */}
      <section className="rounded-[10px] border border-[#e6edf7] bg-white p-6 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
        <SectionTitle title="作品简介" />
        <p
          className={
            expanded
              ? 'text-[15px] leading-[1.8] text-[#1e293b]'
              : 'line-clamp-4 text-[15px] leading-[1.8] text-[#1e293b]'
          }
        >
          {novel.description || '暂无简介'}
        </p>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 cursor-pointer text-[13px] text-[#2563eb] transition-colors duration-200 hover:text-[#1d4ed8]"
        >
          {expanded ? '收起' : '展开'}
        </button>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-[#94a3b8]">小说标签：</span>
          <CatBadge onClick={() => navigate({ name: 'category', categoryId: novel.categoryId })}>
            {novel.categoryName}
          </CatBadge>
          <SoftBadge>{statusLabel(novel.status)}</SoftBadge>
          <GhostBadge>{fmtWords(novel.wordCount)}</GhostBadge>
        </div>
      </section>

      {/* 最新章节（胶囊栅格） */}
      <section className="rounded-[10px] border border-[#e6edf7] bg-white p-6 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
        <SectionTitle
          title="最新章节"
          small={`共 ${novel.totalChapters} 章`}
          action={
            <button
              onClick={() => navigate({ name: 'toc', novelId: novel.id })}
              className="shrink-0 cursor-pointer text-[13px] text-[#2563eb] transition-colors duration-200 hover:text-[#1d4ed8]"
            >
              完整目录页 →
            </button>
          }
        />
        <ChapterPills chapters={novel.chapters.slice(0, 12)} navigate={navigate} />
      </section>

      {/* 章节目录（多列胶囊栅格内嵌） */}
      <section className="rounded-[10px] border border-[#e6edf7] bg-white p-6 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
        <SectionTitle title="章节目录" small={fullChapters.length ? `${fullChapters.length} 章` : undefined} />
        {chapters.isPending ? (
          <PillSkeleton count={12} />
        ) : chapters.isError ? (
          <ErrorBox msg="章节目录加载失败" onRetry={() => chapters.refetch()} />
        ) : fullChapters.length === 0 ? (
          <EmptyBox text="暂无章节" />
        ) : (
          <ChapterPills chapters={fullChapters} navigate={navigate} />
        )}
      </section>
    </div>
  )
}

/* ==================== 目录页（同风格完整列表） ==================== */

export function Toc({ navigate, novelId }: ViewProps & { novelId: number }) {
  const { data: novel } = useNovel(novelId)
  const { data: chapters, isPending, isError, refetch } = useChapters(novelId)

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6">
      <Crumb
        items={[
          { label: '首页', view: { name: 'home' } },
          { label: novel?.title ?? '…', view: { name: 'book', novelId } },
          { label: '章节目录' },
        ]}
        navigate={navigate}
      />
      <section className="rounded-[10px] border border-[#e6edf7] bg-white p-6 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
        <SectionTitle
          title={novel ? `${novel.title} · 章节目录` : '章节目录'}
          small={chapters ? `共 ${chapters.length} 章` : undefined}
          action={
            <button
              onClick={() => navigate({ name: 'book', novelId })}
              className="shrink-0 cursor-pointer rounded-[10px] border-[1.5px] border-[#dbe4f0] bg-white px-5 py-2 text-[13px] text-[#1e293b] transition-colors duration-200 hover:border-[#2563eb] hover:text-[#2563eb]"
            >
              返回书页
            </button>
          }
        />
        {isPending ? (
          <PillSkeleton count={16} />
        ) : isError ? (
          <ErrorBox onRetry={() => refetch()} />
        ) : (chapters?.length ?? 0) === 0 ? (
          <EmptyBox text="暂无章节" />
        ) : (
          <ChapterPills chapters={chapters!} navigate={navigate} />
        )}
      </section>
    </div>
  )
}

/* ==================== 章节正文页（900px 阅读容器） ==================== */

function AuthorWorks({
  author,
  excludeId,
  navigate,
}: {
  author: string
  excludeId: number
  navigate: Nav
}) {
  const q = useNovels({ q: author, pageSize: 6 })
  const rows: NovelListItem[] = (q.data?.list ?? []).filter((n) => n.id !== excludeId).slice(0, 3)
  if (rows.length === 0) return null
  return (
    <section>
      <SectionTitle title={`「${author}」的其他作品`} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((n) => (
          <BookTextCard key={n.id} novel={n} navigate={navigate} />
        ))}
      </div>
    </section>
  )
}

export function Chapter({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const { data: ch, isPending, isError, refetch } = useChapter(chapterId)
  const novel = useNovel(ch?.novelId)
  const [fontSize, setFontSize] = useState(20)
  const [lineHeight, setLineHeight] = useState(1.8)

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [chapterId])

  if (isPending) {
    return (
      <div className="mx-auto max-w-[900px] space-y-5 px-4 py-6">
        <Skel className="h-4 w-72" />
        <Skel className="h-16 rounded-[10px]" />
        <div className="rounded-[10px] border border-[#d8e3f0] bg-[#f8fafc] px-8 py-12">
          <Skel className="mx-auto h-6 w-1/2" />
          <div className="mx-auto mt-8 max-w-[800px] space-y-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skel key={i} className="h-4 w-full" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (isError || !ch) {
    return (
      <div className="mx-auto max-w-[900px] px-4 py-10">
        <ErrorBox onRetry={() => refetch()} />
      </div>
    )
  }

  const paragraphs = ch.content.split('\n').map((s) => s.trim()).filter(Boolean)

  return (
    <div className="mx-auto max-w-[900px] space-y-5 px-4 py-6">
      <Crumb
        items={[
          { label: '首页', view: { name: 'home' } },
          { label: ch.novelTitle, view: { name: 'book', novelId: ch.novelId } },
          { label: ch.title },
        ]}
        navigate={navigate}
      />

      {/* 阅读器头部卡：书名 + 字号/行距滑杆 */}
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-[10px] border border-[#e6edf7] bg-white p-4 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
        <button
          onClick={() => navigate({ name: 'book', novelId: ch.novelId })}
          className="cursor-pointer truncate text-[20px] font-semibold text-[#1e293b] transition-colors duration-200 hover:text-[#2563eb]"
        >
          {ch.novelTitle}
        </button>
        <div className="hidden items-center gap-6 sm:flex">
          <label className="flex items-center gap-2 text-[13px] text-[#64748b]">
            字号
            <input
              type="range"
              min={14}
              max={30}
              step={1}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-28 accent-[#2563eb]"
            />
            <span className="w-9 text-right">{fontSize}px</span>
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[#64748b]">
            行距
            <input
              type="range"
              min={1.4}
              max={3}
              step={0.1}
              value={lineHeight}
              onChange={(e) => setLineHeight(Number(e.target.value))}
              className="w-28 accent-[#2563eb]"
            />
            <span className="w-9 text-right">{lineHeight.toFixed(1)}</span>
          </label>
        </div>
      </section>

      {/* 正文卡 */}
      <article className="rounded-[10px] border border-[#d8e3f0] bg-[#f8fafc] px-6 py-10 sm:px-10">
        <h1 className="mb-10 text-center text-[24px] font-semibold text-[#1e293b]">
          {ch.title}
          <span className="mt-2 block text-[13px] font-normal text-[#94a3b8]">
            第 {ch.idx} 章 · 约 {fmtWan(ch.wordCount)} 字
          </span>
        </h1>
        <div style={{ fontSize: `${fontSize}px`, lineHeight }}>
          {paragraphs.length === 0 ? (
            <p className="mx-auto max-w-[800px] text-[#94a3b8]">本章内容为空</p>
          ) : (
            paragraphs.map((p, i) => (
              <p
                key={i}
                className="mx-auto mb-4 max-w-[800px] text-justify tracking-[0.2em] text-[#1e293b] indent-[2em]"
              >
                {p}
              </p>
            ))
          )}
        </div>
      </article>

      {/* 三段式章节导航：上一章 | 目录 | 下一章 */}
      <nav className="mx-auto flex max-w-[800px] flex-wrap items-center justify-between gap-3">
        <button
          disabled={!ch.prevId}
          onClick={() => ch.prevId && navigate({ name: 'chapter', chapterId: ch.prevId })}
          className="min-w-[128px] cursor-pointer rounded-[10px] border-[1.5px] border-[#dbe4f0] bg-white px-6 py-2.5 text-[14px] text-[#1e293b] transition-colors duration-200 hover:border-[#2563eb] hover:text-[#2563eb] disabled:pointer-events-none disabled:opacity-40"
        >
          上一章
        </button>
        <button
          onClick={() => navigate({ name: 'toc', novelId: ch.novelId })}
          className="min-w-[128px] cursor-pointer rounded-[10px] bg-[#2563eb] px-6 py-2.5 text-[14px] text-white transition-colors duration-200 hover:bg-[#1d4ed8]"
        >
          目录
        </button>
        <button
          disabled={!ch.nextId}
          onClick={() => ch.nextId && navigate({ name: 'chapter', chapterId: ch.nextId })}
          className="min-w-[128px] cursor-pointer rounded-[10px] bg-[#2563eb] px-6 py-2.5 text-[14px] text-white transition-colors duration-200 hover:bg-[#1d4ed8] disabled:pointer-events-none disabled:opacity-40"
        >
          下一章
        </button>
      </nav>

      {/* 同作者作品 */}
      {novel.data?.author ? (
        <AuthorWorks author={novel.data.author} excludeId={ch.novelId} navigate={navigate} />
      ) : null}

      <div className="pt-2 text-center text-[13px] text-[#94a3b8]">
        更新于 {fmtDate(novel.data?.updatedAt ?? '')} · 内容为演示数据
      </div>
    </div>
  )
}

/* ==================== 搜索页 ==================== */

export function Search({ navigate, query }: ViewProps & { query: string }) {
  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6">
      <Crumb items={[{ label: '首页', view: { name: 'home' } }, { label: '搜索' }]} navigate={navigate} />
      {/* key=query：关键词变化时重挂载，重置输入框与分页 */}
      <SearchPanel key={query} query={query} navigate={navigate} />
    </div>
  )
}

function SearchPanel({ query, navigate }: { query: string; navigate: Nav }) {
  const [input, setInput] = useState(query)
  const [page, setPage] = useState(1)
  const list = useNovels({ q: query || undefined, page, pageSize: 20 })

  const submit = () => {
    const kw = input.trim()
    if (kw) navigate({ name: 'search', query: kw })
  }

  return (
    <div className="space-y-5">
      <div className="flex gap-3 rounded-[10px] border border-[#e6edf7] bg-white p-4 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="输入书名 / 作者关键词"
          className="h-10 min-w-0 flex-1 rounded-[10px] border border-[#dbe4f0] bg-[#f0f4fb] px-4 text-[14px] text-[#1e293b] outline-none transition-colors duration-200 placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:bg-white"
        />
        <button
          onClick={submit}
          className="cursor-pointer rounded-[10px] bg-[#2563eb] px-8 text-[14px] text-white transition-colors duration-200 hover:bg-[#1d4ed8]"
        >
          搜索
        </button>
      </div>

      <SectionTitle
        title="搜索结果"
        small={query ? `“${query}” · ${list.data?.total ?? 0} 条` : '请输入关键词'}
      />

      {list.isPending ? (
        <CardGridSkeleton count={6} />
      ) : list.isError ? (
        <ErrorBox onRetry={() => list.refetch()} />
      ) : (list.data?.list.length ?? 0) === 0 ? (
        <EmptyBox text={`没有找到与“${query}”相关的小说，换个关键词试试`} />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.data!.list.map((n) => (
              <BookTextCard key={n.id} novel={n} navigate={navigate} />
            ))}
          </div>
          <Pager
            page={list.data!.page}
            totalPages={list.data!.totalPages}
            onGo={(p) => setPage(p)}
          />
        </>
      )}
    </div>
  )
}
