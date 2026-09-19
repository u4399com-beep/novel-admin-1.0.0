'use client'

import { useEffect } from 'react'
import type { ThemeModule, ThemeView, ViewProps } from '@/themes/types'
import { getTheme } from '@/themes/registry'
import { useAppStore } from '@/lib/store'
import { usePseo, useSettings } from '@/hooks/use-novel-data'
import { coverBgClass } from '@/lib/covers'
import { formatWordCount } from '@/lib/format'
import { NovelCoverImg, isLocalCover } from '@/components/novel-cover'
import { SeoSync } from '@/components/SeoSync'
import { SiteToolsProvider } from '@/components/theme-tools/SiteToolsProvider'

/**
 * 书籍视图深链（约定 /?book={novelId}）：
 * SPA 视图为内存导航（无 /book/{id} 真实路由），服务器落地页（/pseo/[kw] 等）
 * 与后台需要真实 URL 跳到书页，挂载后一次性解析该参数切入书籍视图并清理 URL。
 */
function useBookDeepLink(navigate: (view: ThemeView) => void) {
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get('book'))
    if (!Number.isInteger(id) || id <= 0) return
    navigate({ name: 'book', novelId: id })
    // 清理查询参数：刷新/回退不再重复深链，URL 与当前视图保持一致
    window.history.replaceState(null, '', window.location.pathname)
  }, [navigate])
}

/** 根据激活主题渲染当前视图（含 Layout 框架 + 自动 SEO） */
export function ThemeRenderer() {
  const { data: settings, isLoading } = useSettings()
  const view = useAppStore((s) => s.view)
  const navigate = useAppStore((s) => s.navigate)
  useBookDeepLink(navigate)

  if (isLoading || !settings) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-neutral-200 border-t-neutral-700" />
          <p className="text-sm text-neutral-500">正在加载站点设置…</p>
        </div>
      </div>
    )
  }

  const theme = getTheme(settings.activeTheme)
  const common = { navigate, siteName: settings.siteName, notice: settings.notice }

  let content: React.ReactNode
  switch (view.name) {
    case 'home':
      content = <theme.Home {...common} />
      break
    case 'category':
      content = <theme.Category {...common} categoryId={view.categoryId} page={view.page} />
      break
    case 'book':
      content = <theme.Book {...common} novelId={view.novelId} />
      break
    case 'toc':
      content = <theme.Toc {...common} novelId={view.novelId} />
      break
    case 'chapter':
      content = <theme.Chapter {...common} chapterId={view.chapterId} />
      break
    case 'search':
      content = <theme.Search {...common} query={view.query} />
      break
    case 'pseo':
      content = <PseoView keyword={view.keyword} theme={theme} common={common} />
      break
    default:
      content = <theme.Home {...common} />
  }

  return (
    <SiteToolsProvider view={view}>
      <SeoSync />
      <theme.Layout {...common} view={view}>
        {content}
      </theme.Layout>
    </SiteToolsProvider>
  )
}

/** PSEO 聚合页（通用实现，与主题无关；用主题 Layout 承载） */
function PseoView({ keyword, theme, common }: { keyword: string; theme: ThemeModule; common: ViewProps }) {
  const { data, isLoading, isError, refetch } = usePseo(keyword)
  const navigate = common.navigate

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <div className="h-8 w-2/3 animate-pulse rounded bg-neutral-200" />
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg bg-neutral-200" />
          ))}
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="mx-auto max-w-3xl p-10 text-center">
        <p className="text-neutral-600">未找到与“{keyword}”相关的聚合页</p>
        <button onClick={() => refetch()} className="mt-4 rounded border px-4 py-2 text-sm hover:bg-neutral-50">
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900">关于“{data.keyword}”的小说推荐</h1>
        <p className="mt-2 text-sm text-neutral-500">{data.generatedDescription}</p>
      </header>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.novels.map((n) => (
          <article
            key={n.id}
            role="link"
            tabIndex={0}
            aria-label={`查看小说 ${n.title}`}
            onClick={() => navigate({ name: 'book', novelId: n.id })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                navigate({ name: 'book', novelId: n.id })
              }
            }}
            className="flex cursor-pointer gap-3 rounded-lg border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-md"
          >
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
      {data.novels.length === 0 && <p className="py-10 text-center text-neutral-500">暂无匹配书籍</p>}
    </div>
  )
}
