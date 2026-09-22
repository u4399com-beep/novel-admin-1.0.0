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
import {
  READER_FONTS,
  READER_INKS,
  READER_SCENES,
  readerFontStack,
  readerInk,
  setReaderPrefs,
  useReaderPrefs,
  type ReaderSceneColors,
} from '@/hooks/use-reader-prefs'
import { NovelTagsRow } from '@/components/novel-tags'
<<<<<<< HEAD
=======
import { CategoryFeaturedBlock, CategoryHotBlock, HomeCustomBlocks } from '@/components/theme-extras'
>>>>>>> b28bcb0 (e932611f-570d-4ee3-8bd8-b483d845a525)
import type { NovelDetail, NovelListItem } from '@/lib/types'
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
  PillSkeleton,
  RankRow,
  SectionTitle,
  Skel,
  SoftBadge,
  dedupMerge,
  fmtDate,
  fmtWords,
  fmtWan,
  statusLabel,
} from './ui'
import { useHistory } from '@/lib/reading-history'

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

  const pillNovels = dedupMerge(
    [data.latest, data.featured, data.hot, data.rankings.clicks],
    24,
  )
  /* 源站首页为 6 个分类排行榜模块卡（{分类}小说榜 × 每榜 10 条编号行） */
  const rankCats = (data.categories ?? []).slice(0, 6)

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

      {/* 后台可配置的首页自定义图文区块：置于「分类排行榜」上方（无配置时渲染 null） */}
      <HomeCustomBlocks navigate={navigate} />

      {/* 分类排行榜：源站为 6 个 ranking-module 卡片（3 列网格，榜内 10 条编号行，前三名蓝系徽章） */}
      <section>
        <SectionTitle title="分类排行榜" />
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {rankCats.map((c) => (
            <RankModule key={c.id} categoryId={c.id} catName={c.name} navigate={navigate} />
          ))}
          {rankCats.length === 0 &&
            Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="overflow-hidden rounded-[10px] border border-[#dbe4f0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_16px_rgba(37,99,235,0.06)]">
                <Skel className="h-12 rounded-none border-b border-[#dbe4f0] bg-[#f0f4fb]" />
                <div className="p-2">
                  {Array.from({ length: 5 }, (_, j) => (
                    <Skel key={j} className="mt-2 h-5 w-full" />
                  ))}
                </div>
              </div>
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
              className="cursor-pointer truncate rounded-[10px] border border-[#dbe4f0] bg-white px-5 py-3 text-[14px] text-[#1e293b] shadow-[0_1px_3px_rgba(37,99,235,0.06)] transition-all duration-200 hover:border-[#2563eb]/40 hover:text-[#2563eb] hover:shadow-[0_4px_12px_rgba(37,99,235,0.12)]"
            >
              《{n.title}》
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

/* ==================== 分类排行榜模块卡（源站 .ranking-module） ==================== */

function RankModule({
  categoryId,
  catName,
  navigate,
}: {
  categoryId: number
  catName: string
  navigate: Nav
}) {
  const q = useNovels({ categoryId, sort: 'clicks', page: 1, pageSize: 10 })
  const rows = q.data?.list ?? []
  return (
    <div className="overflow-hidden rounded-[10px] border border-[#dbe4f0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_16px_rgba(37,99,235,0.06)] transition-shadow duration-300 hover:shadow-[0_8px_24px_rgba(37,99,235,0.14),0_2px_8px_rgba(15,23,42,0.06)]">
      <div className="flex items-center gap-2 border-b border-[#dbe4f0] bg-[#f0f4fb] px-4 py-3 text-[18px] font-semibold text-[#1e293b]">
        <span className="h-4 w-[3px] rounded-sm bg-[#2563eb]" />
        {catName}小说榜
      </div>
      {q.isPending ? (
        <div className="p-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Skel key={i} className="mt-2 h-5" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[14px] text-[#94a3b8]">该分类暂无上榜小说</p>
      ) : (
        <ol className="py-1">
          {rows.map((n, i) => (
            <RankRow key={n.id} novel={n} index={i} navigate={navigate} />
          ))}
        </ol>
      )}
    </div>
  )
}

/* ==================== 分类 / 书库页 ==================== */

export function Category({ navigate, categoryId }: ViewProps & { categoryId?: number }) {
  const cats = useCategories()
  const list = useNovels({ categoryId, pageSize: 500 })

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

      {/* 图文推荐 / 热门书籍区块（无数据时自渲染 null） */}
      <CategoryFeaturedBlock navigate={navigate} categoryId={categoryId} />
      <CategoryHotBlock navigate={navigate} categoryId={categoryId} />

      {list.isPending ? (
        <CardGridSkeleton count={6} />
      ) : list.isError ? (
        <ErrorBox onRetry={() => list.refetch()} />
      ) : (list.data?.list.length ?? 0) === 0 ? (
        <EmptyBox text="该分类下暂无收录小说" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data!.list.map((n) => (
            <BookTextCard key={n.id} novel={n} navigate={navigate} />
          ))}
        </div>
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
  /* 源站书页头部有「已读到 x/y + 继续阅读」续读行（reading-progress），用共享阅读记录映射 */
  const history = useHistory()
  const lastRead = history.find((e) => e.novelId === novelId)

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
          <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.01em] text-[#1e293b]">{novel.title}</h1>
          {/* 源站 detail-meta：浅蓝底圆角盒 + 蓝点前缀 + 竖线分隔 */}
          <div className="mt-3 flex flex-wrap items-center gap-y-1 rounded-[10px] border border-[#dbe4f0] bg-[#f1f6fc] px-5 py-4 text-[15px] text-[#64748b]">
            {[
              `作者：${novel.author}`,
              `分类：${novel.categoryName}`,
              `状态：${statusLabel(novel.status)}`,
              `字数：${fmtWords(novel.wordCount)}`,
              `点击：${fmtWan(novel.clicks)}`,
              `更新时间：${fmtDate(novel.updatedAt)}`,
              `共 ${novel.totalChapters} 章`,
            ].map((label, i, arr) => (
              <span key={label} className="relative flex items-center pr-5">
                <span className="mr-2 inline-block size-2 shrink-0 rounded-full bg-[#2563eb]" />
                {label}
                {i < arr.length - 1 && (
                  <span className="absolute right-0 top-1/2 h-4 w-px -translate-y-1/2 bg-[#dbe4f0]" />
                )}
              </span>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {lastRead ? (
              <>
                <button
                  disabled={!lastRead.chapterId}
                  onClick={() =>
                    lastRead.chapterId && navigate({ name: 'chapter', chapterId: lastRead.chapterId })
                  }
                  className="min-w-[128px] cursor-pointer rounded-[10px] bg-[#2563eb] px-6 py-2.5 text-[14px] text-white transition-colors duration-200 hover:bg-[#1d4ed8] disabled:pointer-events-none disabled:opacity-40"
                >
                  继续阅读
                </button>
                <span className="text-[13px] text-[#94a3b8]">
                  已读到：<span className="text-[#64748b]">{lastRead.chapterTitle}</span>
                </span>
              </>
            ) : (
              <button
                disabled={!novel.firstChapterId}
                onClick={() =>
                  novel.firstChapterId && navigate({ name: 'chapter', chapterId: novel.firstChapterId })
                }
                className="min-w-[128px] cursor-pointer rounded-[10px] bg-[#2563eb] px-6 py-2.5 text-[14px] text-white transition-colors duration-200 hover:bg-[#1d4ed8] disabled:pointer-events-none disabled:opacity-40"
              >
                开始阅读
              </button>
            )}
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
        <NovelTagsRow tags={novel.tags ?? []} navigate={navigate} className="mt-3" />
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
        {chapters.isPending ? (
          <PillSkeleton count={12} />
        ) : chapters.isError ? (
          <ErrorBox msg="章节加载失败" onRetry={() => chapters.refetch()} />
        ) : fullChapters.length === 0 ? (
          <EmptyBox text="暂无章节" />
        ) : (
          /* 全量章节末 12 条倒序 = 最新 12 章（新→旧）；详情接口 chapters 是最早 12 章，不可直接用 */
          <ChapterPills chapters={[...fullChapters].slice(-12).reverse()} navigate={navigate} />
        )}
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

      {/* 源站书页底部：同作者小说 + {分类}热门小说 + 最新电子书（与源站书页尾部板块同构） */}
      {novel.author ? <AuthorWorks author={novel.author} excludeId={novel.id} navigate={navigate} /> : null}
      <CategoryPicks novel={novel} navigate={navigate} />
      <MoreEbooks navigate={navigate} />
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
      {/* 最新章节（全书倒数 12 章，新→旧） */}
      {chapters && chapters.length > 0 && (
        <section className="rounded-[10px] border border-[#e6edf7] bg-white p-6 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
          <SectionTitle
            title="最新章节"
            small="最近更新 12 章 · 新→旧"
            action={
              <button
                onClick={() => navigate({ name: 'book', novelId })}
                className="shrink-0 cursor-pointer rounded-[10px] border-[1.5px] border-[#dbe4f0] bg-white px-5 py-2 text-[13px] text-[#1e293b] transition-colors duration-200 hover:border-[#2563eb] hover:text-[#2563eb]"
              >
                返回书页
              </button>
            }
          />
          <ChapterPills chapters={[...chapters].slice(-12).reverse()} navigate={navigate} />
        </section>
      )}

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

/* 分类推荐文本榜（源站书页/章节页底部「{分类}热门小说 / {分类}最近更新」同构） */
function CatPicks({
  categoryId,
  title,
  sort,
  navigate,
}: {
  categoryId: number
  title: string
  sort: 'clicks' | 'latest'
  navigate: Nav
}) {
  const q = useNovels({ categoryId, sort, page: 1, pageSize: 8 })
  const rows = q.data?.list ?? []
  if (rows.length === 0) return null
  return (
    <section className="rounded-[10px] border border-[#e6edf7] bg-white p-6 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
      <SectionTitle title={title} />
      <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((n) => (
          <button
            key={n.id}
            onClick={() => navigate({ name: 'book', novelId: n.id })}
            className="flex h-9 cursor-pointer items-center justify-between gap-2 border-b border-[#eef2f9] px-1 text-left transition-colors duration-200 last:border-b-0 hover:bg-[#f5f9ff]"
          >
            <span className="min-w-0 flex-1 truncate text-[14px] text-[#1e293b] transition-colors duration-200 hover:text-[#2563eb]">
              《{n.title}》
            </span>
            <span className="shrink-0 text-[12px] text-[#94a3b8]">{n.author}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** 源站书页/章节页底部的两个分类推荐板块（数据为空时整块隐藏） */
function CategoryPicks({ novel, navigate }: { novel: NovelDetail; navigate: Nav }) {
  return (
    <>
      <CatPicks
        categoryId={novel.categoryId}
        title={`${novel.categoryName}热门小说`}
        sort="clicks"
        navigate={navigate}
      />
      <CatPicks
        categoryId={novel.categoryId}
        title={`${novel.categoryName}最近更新`}
        sort="latest"
        navigate={navigate}
      />
    </>
  )
}

/* 源站书页/章节页尾部「最新电子书」全站胶囊横排（.ebook-more-ebooks），数据为空时隐藏 */
function MoreEbooks({ navigate }: { navigate: Nav }) {
  const q = useNovels({ sort: 'latest', page: 1, pageSize: 16 })
  const rows = q.data?.list ?? []
  if (rows.length === 0) return null
  return (
    <section className="rounded-[10px] border border-[#e6edf7] bg-white p-6 shadow-[0_1px_3px_rgba(37,99,235,0.06)]">
      <SectionTitle title="最新电子书" small="全站最新入库" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
        {rows.map((n) => (
          <button
            key={n.id}
            onClick={() => navigate({ name: 'book', novelId: n.id })}
            className="cursor-pointer truncate rounded-[10px] border border-[#dbe4f0] bg-white px-5 py-3 text-[14px] text-[#1e293b] shadow-[0_1px_3px_rgba(37,99,235,0.06)] transition-all duration-200 hover:border-[#2563eb]/40 hover:text-[#2563eb] hover:shadow-[0_4px_12px_rgba(37,99,235,0.12)]"
          >
            《{n.title}》
          </button>
        ))}
      </div>
    </section>
  )
}

/* 场景配色：日间沿用蓝灰纸面，其余按语义键换肤 */
const SCENES: Record<string, ReaderSceneColors> = {
  day: { page: '', paper: '#f8fafc', ink: '#1e293b', muted: '#94a3b8', line: '#d8e3f0' },
  paper: { page: '#e6d9bd', paper: '#f8f0da', ink: '#4a3a24', muted: '#a89a80', line: '#d4c5a3' },
  green: { page: '#dcead8', paper: '#f0f6ec', ink: '#2f4030', muted: '#8fa590', line: '#bcd4bc' },
  blue: { page: '#d8e4ee', paper: '#eef4fa', ink: '#2d3c46', muted: '#8fa2b0', line: '#b8cede' },
  night: { page: '#1e2024', paper: '#26262b', ink: '#c0c0c6', muted: '#8a8a92', line: '#3a3a42' },
}

export function Chapter({ navigate, chapterId }: ViewProps & { chapterId: number }) {
  const { data: ch, isPending, isError, refetch } = useChapter(chapterId)
  const novel = useNovel(ch?.novelId)
  const [prefs] = useReaderPrefs()

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
  const scene = SCENES[prefs.scene] ?? SCENES.day

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

      {/* 阅读器头部卡：书名 + 字号/行距滑杆 + 背景/字体/字色（跨主题共享同一份偏好） */}
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-[10px] border p-4 shadow-[0_1px_3px_rgba(37,99,235,0.06)] transition-colors" style={{ background: scene.paper, borderColor: scene.line }}>
        <button
          onClick={() => navigate({ name: 'book', novelId: ch.novelId })}
          className="cursor-pointer truncate text-[20px] font-semibold transition-colors duration-200"
          style={{ color: scene.ink }}
        >
          {ch.novelTitle}
        </button>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-[13px]" style={{ color: scene.muted }}>
            字号
            <input
              type="range"
              min={14}
              max={28}
              step={1}
              value={prefs.fontSize}
              onChange={(e) => setReaderPrefs({ fontSize: Number(e.target.value) })}
              className="w-28 accent-[#2563eb]"
            />
            <span className="w-9 text-right">{prefs.fontSize}px</span>
          </label>
          <label className="flex items-center gap-2 text-[13px]" style={{ color: scene.muted }}>
            行距
            <input
              type="range"
              min={1.4}
              max={2.6}
              step={0.1}
              value={prefs.lineHeight}
              onChange={(e) => setReaderPrefs({ lineHeight: Number(e.target.value) })}
              className="w-28 accent-[#2563eb]"
            />
            <span className="w-9 text-right">{prefs.lineHeight.toFixed(1)}</span>
          </label>
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-[13px] sm:w-auto sm:border-t-0 sm:pt-0" style={{ borderColor: scene.line, color: scene.muted }}>
          <span className="flex items-center gap-1.5">
            背景
            {READER_SCENES.map((s) => (
              <button
                key={s.key}
                type="button"
                title={s.label}
                aria-label={`背景：${s.label}`}
                onClick={() => setReaderPrefs({ scene: s.key })}
                className={`h-5 w-5 cursor-pointer rounded-full border transition-all ${
                  prefs.scene === s.key ? 'scale-110 border-[#2563eb]' : 'border-black/25'
                }`}
                style={{ background: SCENES[s.key].paper }}
              />
            ))}
          </span>
          <label className="flex items-center gap-1.5">
            字体
            <select
              value={prefs.font}
              onChange={(e) => setReaderPrefs({ font: e.target.value as typeof prefs.font })}
              className="cursor-pointer rounded-[6px] border bg-white px-1.5 py-1 text-[13px] text-[#1e293b] outline-none"
              style={{ borderColor: scene.line }}
            >
              {READER_FONTS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            字色
            <select
              value={prefs.ink}
              onChange={(e) => setReaderPrefs({ ink: e.target.value })}
              aria-label="字色"
              className="cursor-pointer rounded-[6px] border bg-white px-1.5 py-1 text-[13px] text-[#1e293b] outline-none"
              style={{ borderColor: scene.line }}
            >
              {READER_INKS.map((c) => (
                <option key={c.k} value={c.v}>{c.k}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* 正文卡（源站 .reader-content padding 3.2rem / h1 上 3.2rem 下 4.8rem） */}
      <article className="rounded-[10px] border px-6 py-8 transition-colors sm:px-8" style={{ background: scene.paper, borderColor: scene.line }}>
        <h1 className="mb-12 mt-8 text-center text-[24px] font-semibold" style={{ color: scene.ink }}>
          {ch.title}
          <span className="mt-2 block text-[13px] font-normal" style={{ color: scene.muted }}>
            第 {ch.idx} 章 · 约 {fmtWan(ch.wordCount)} 字
          </span>
        </h1>
        <div
          className="break-words"
          style={{
            fontSize: `${prefs.fontSize}px`,
            lineHeight: prefs.lineHeight,
            fontFamily: readerFontStack(prefs.font),
          }}
        >
          {paragraphs.length === 0 ? (
            <p className="mx-auto max-w-[800px]" style={{ color: scene.muted }}>本章内容为空</p>
          ) : (
            paragraphs.map((p, i) => (
              <p
                key={i}
                className="mx-auto mb-[1.5em] max-w-[800px] text-justify tracking-[0.2em] indent-[2em]"
                style={{ color: readerInk(prefs, scene) }}
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

      {/* 同作者作品 + 分类推荐 + 最新电子书（源站章节页底部同构板块） */}
      {novel.data?.author ? (
        <AuthorWorks author={novel.data.author} excludeId={ch.novelId} navigate={navigate} />
      ) : null}
      {novel.data ? <CategoryPicks novel={novel.data} navigate={navigate} /> : null}
      <MoreEbooks navigate={navigate} />

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
      {/* key=query：关键词变化时重挂载，重置输入框 */}
      <SearchPanel key={query} query={query} navigate={navigate} />
    </div>
  )
}

function SearchPanel({ query, navigate }: { query: string; navigate: Nav }) {
  const [input, setInput] = useState(query)
  const list = useNovels({ q: query || undefined, pageSize: 500 })

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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.data!.list.map((n) => (
            <BookTextCard key={n.id} novel={n} navigate={navigate} />
          ))}
        </div>
      )}
    </div>
  )
}
