import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getGeneratedPseoPage } from '@/lib/pseo'
import { sanitizeKeyword } from '@/lib/suggest'
import { coverBgClass } from '@/lib/covers'
import { formatWordCount } from '@/lib/format'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'

/**
 * PSEO 聚合页服务端落地路由（/pseo/{keyword}）：
 * 前台 SPA 的 pseo 视图（ThemeRenderer.PseoView）不产生 URL，搜索引擎无法触达；
 * 本路由为已生成（status='generated'）的关键词提供真实可收录的静态页，
 * sitemap.ts 据此列出 /pseo/{encodeURIComponent(keyword)}。
 * 未生成/不存在/关键词非法 → 404（不实时兜底，避免任意关键词产生薄内容页）。
 * 绑定词页（采集自动取词）书单首位即绑定书，渲染为「最佳匹配」高亮卡；
 * 卡片「继续阅读」链 /?book={id}（SPA 书籍视图的深链约定，ThemeRenderer 挂载时解析）。
 */

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ kw: string }> }

/** URL 参数 → 站内关键词（畸形转义用原文，清洗后为空直接判死） */
async function resolveKeyword(rawKw: string): Promise<string> {
  let decoded = rawKw
  try {
    decoded = decodeURIComponent(rawKw)
  } catch {
    /* 畸形转义序列按原文处理 */
  }
  return sanitizeKeyword(decoded)
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { kw } = await params
  const keyword = await resolveKeyword(kw)
  const page = keyword ? await getGeneratedPseoPage(keyword) : null
  if (!page) return { title: '聚合页不存在' }
  return {
    title: page.generatedTitle,
    description: page.generatedDescription,
    keywords: page.generatedKeywords,
  }
}

export default async function PseoLandingPage({ params }: Props) {
  const { kw } = await params
  const keyword = await resolveKeyword(kw)
  const page = keyword ? await getGeneratedPseoPage(keyword) : null
  if (!page) notFound()

  // 绑定书（采集自动取词时 novelIds[0]）排第一，单独渲染「最佳匹配」高亮卡；其余进网格
  const [best, ...rest] = page.novels

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900">关于“{page.keyword}”的小说推荐</h1>
        <p className="mt-2 text-sm text-neutral-500">{page.generatedDescription}</p>
      </header>
      {best && (
        <article className="mb-6 flex gap-4 rounded-lg border border-neutral-300 bg-white p-4 shadow-sm sm:p-5">
          <div className={`relative flex h-36 w-24 shrink-0 items-center justify-center overflow-hidden rounded sm:h-44 sm:w-32 ${coverBgClass(best.cover)}`}>
            <NovelCoverImg novel={best} />
            {!isLocalCover(best.cover) && <span className="text-4xl font-bold text-white">{best.title.slice(0, 1)}</span>}
          </div>
          <div className="min-w-0 flex-1">
            <span className="inline-block rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">
              与“{page.keyword}”最相关
            </span>
            <h2 className="mt-1.5 truncate text-lg font-bold text-neutral-900">
              <Link href={`/?book=${best.id}`} className="hover:underline">
                {best.title}
              </Link>
            </h2>
            <p className="mt-0.5 text-sm text-neutral-500">
              {best.author} · {best.categoryName} · {formatWordCount(best.wordCount)} · {best.status === 'finished' ? '已完结' : '连载中'}
            </p>
            <p className="mt-1 line-clamp-2 text-sm text-neutral-600">{best.description}</p>
            <p className="mt-1.5 truncate text-xs text-neutral-500">最新章节：{best.lastChapterTitle ?? '暂无'}</p>
            <Link
              href={`/?book=${best.id}`}
              className="mt-3 inline-flex h-9 items-center rounded-md bg-neutral-900 px-4 text-sm text-white transition-colors hover:bg-neutral-700"
            >
              继续阅读 →
            </Link>
          </div>
        </article>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rest.map((n) => (
          <article key={n.id} className="flex gap-3 rounded-lg border border-neutral-200 bg-white p-4">
            <div className={`relative flex h-24 w-16 shrink-0 items-center justify-center overflow-hidden rounded ${coverBgClass(n.cover)}`}>
              <NovelCoverImg novel={n} />
              {!isLocalCover(n.cover) && <span className="text-xl font-bold text-white">{n.title.slice(0, 1)}</span>}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-semibold text-neutral-900">{n.title}</h3>
              <p className="mt-0.5 text-xs text-neutral-500">
                {n.author} · {n.categoryName} · {formatWordCount(n.wordCount)}
              </p>
              <p className="mt-1 line-clamp-2 text-xs text-neutral-600">{n.description}</p>
            </div>
          </article>
        ))}
      </div>
      {page.novels.length === 0 && <p className="py-10 text-center text-neutral-500">暂无匹配书籍</p>}
      <footer className="mt-8 border-t pt-4 text-sm">
        <Link href="/" className="text-neutral-600 hover:text-neutral-900 hover:underline">
          前往站内阅读更多小说 →
        </Link>
      </footer>
    </main>
  )
}
