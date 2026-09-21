'use client'

import { useState } from 'react'
import { useCategories, useSettings } from '@/hooks/use-novel-data'
import { HistoryPanel } from '@/components/theme-tools/HistoryPanel'
import { useFavoriteSite } from '@/components/theme-tools/FavoriteSite'
import { TradToggle } from '@/components/theme-tools/TradToggle'
import { cn } from '@/lib/utils'
import type { ThemeLayoutProps, ThemeModule, ThemeView, ViewProps } from '../types'
import { Book, Category, Chapter, Home, Search, Toc } from './views'

/** 源站导航无背景 hover，仅 a:hover 变橙 #f50（active 同色加粗） */
const cnNavDesktop = (active: boolean) =>
  cn(
    'h-[50px] cursor-pointer text-center text-[14px] leading-[50px] text-white transition-colors duration-200',
    active ? 'font-bold text-[#f50]' : 'hover:text-[#f50]',
  )

/* ==================== 全站框架：青绿顶栏（桌面单行 / 移动两行） + 绿底页脚 ==================== */

function Layout({ view, children, navigate, siteName, notice }: ThemeLayoutProps) {
  const { data: cats } = useCategories()
  const { data: settings } = useSettings()
  const [histOpen, setHistOpen] = useState(false)
  const { promptFavorite, shortcut } = useFavoriteSite()
  const footerCfg = settings?.footer

  const items: { label: string; view: ThemeView; active: boolean }[] = [
    { label: '首页', view: { name: 'home' }, active: view.name === 'home' },
    {
      label: '全部小说',
      view: { name: 'category', page: 1 },
      active: view.name === 'category' && view.categoryId == null,
    },
    ...(cats ?? []).slice(0, 3).map((c) => ({
      label: c.name,
      view: { name: 'category', categoryId: c.id, page: 1 } as ThemeView,
      active: view.name === 'category' && view.categoryId === c.id,
    })),
  ]

  return (
    <div
      className="flex min-h-screen flex-col bg-[#f9f9f9] text-[15px] text-[#888]"
      style={{ fontFamily: '"Microsoft YaHei", "微软雅黑", simsun, arial, sans-serif' }}
    >
      {/* 青绿顶栏 50px */}
      <header className="mb-[10px] bg-[#1abc9c] shadow-[0_1px_1px_#1abc9c]">
        <div className="mx-auto flex h-[50px] w-[90%] max-w-[1200px] items-center justify-between">
          <button
            onClick={() => navigate({ name: 'home' })}
            className="cursor-pointer text-[18px] font-bold text-white"
            style={{ textShadow: '1px 1px 0 rgba(0,0,0,.4)' }}
          >
            {siteName}
          </button>
          <nav className="hidden h-[50px] items-stretch md:flex">
            {items.map((it) => (
              <button
                key={it.label}
                onClick={() => navigate(it.view)}
                className={cnNavDesktop(it.active)}
                style={{ textShadow: '1px 1px 1px #666' }}
              >
                {it.label}
              </button>
            ))}
          </nav>
          <div className="hidden items-center gap-2 text-[13px] text-white/85 md:flex">
            <button
              type="button"
              onClick={() => setHistOpen(true)}
              title="查看最近读过的章节"
              className="cursor-pointer transition-colors duration-200 hover:text-white"
            >
              阅读记录
            </button>
            <span className="opacity-50">|</span>
            <button
              type="button"
              onClick={promptFavorite}
              title={`按 ${shortcut} 也可收藏本站`}
              className="cursor-pointer transition-colors duration-200 hover:text-white"
            >
              收藏本站
            </button>
            <span className="opacity-50">|</span>
            <TradToggle className="hover:text-white" />
          </div>
        </div>
        {/* 移动端第二行导航（源站 header-nav 展开行：宽 20% 均分，上边线 #e9faff） */}
        <nav className="flex border-t border-[#e9faff] md:hidden">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => navigate(it.view)}
              className={cnNavDesktop(it.active)}
              style={{ flex: '1 1 0%', textShadow: '1px 1px 1px #666' }}
            >
              {it.label}
            </button>
          ))}
        </nav>
      </header>

      {/* 公告条 */}
      {notice ? (
        <div className="mx-auto mb-[10px] w-[90%] max-w-[1200px]">
          <p className="truncate rounded-[4px] border border-[#ccc] bg-[#cdf3eb] px-3 py-2 text-[13px] text-[#00886d]">
            公告：{notice}
          </p>
        </div>
      ) : null}

      <main className="min-w-0 flex-1">{children}</main>

      {/* 绿底页脚 */}
      <footer className="mt-5 bg-[#56ccb5] py-[10px] text-center text-[14px] leading-[22px] text-white shadow-[0_-1px_1px_rgba(0,0,0,0.06)]">
        <p className="flex flex-wrap items-center justify-center gap-x-3 px-4">
          <button
            type="button"
            onClick={() => setHistOpen(true)}
            className="cursor-pointer underline-offset-2 transition-colors hover:underline"
            title="查看最近读过的章节"
          >
            阅读记录
          </button>
          <span className="opacity-60">|</span>
          <button
            type="button"
            onClick={promptFavorite}
            className="cursor-pointer underline-offset-2 transition-colors hover:underline"
            title="把本站加入浏览器收藏夹"
          >
            收藏本站
          </button>
          <span className="opacity-60">|</span>
          <TradToggle className="underline-offset-2 hover:underline" />
        </p>
        <p className="hidden sm:block">{footerCfg?.extra || '本站为结构级主题模板演示，页面布局风格仿 ggd66.com，内容均为演示数据'}</p>
        <p className="hidden sm:block">
          {footerCfg?.text || `© ${new Date().getFullYear()} ${siteName} · 仅用于前端学习与技术交流`}
        </p>
        {(footerCfg?.links?.length ?? 0) > 0 && (
          <p className="flex flex-wrap items-center justify-center gap-x-3 px-4">
            {footerCfg?.links?.map((lk) => (
              <a key={`${lk.label}-${lk.href}`} href={lk.href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
                {lk.label}
              </a>
            ))}
          </p>
        )}
      </footer>

      <HistoryPanel
        open={histOpen}
        onClose={() => setHistOpen(false)}
        navigate={navigate}
        accent="#1abc9c"
      />
    </div>
  )
}

/* ==================== 主题模块 ==================== */

type BookViewProps = ViewProps & { novelId: number }

const theme: ThemeModule = {
  id: 'ggd66',
  name: '谷谷小说',
  source: 'ggd66.com',
  description: '经典老式小说站：青绿顶栏 + 灰白底 float 双栏 + 高密度虚线分隔文字列表，米黄纸感阅读页',
  swatch: ['#1abc9c', '#56ccb5'],
  Layout: (p: ThemeLayoutProps) => <Layout {...p} />,
  Home: (p: ViewProps) => <Home {...p} />,
  Category: (p: ViewProps & { categoryId?: number; page?: number }) => <Category {...p} />,
  Book: (p: BookViewProps) => <Book {...p} />,
  Toc: (p: BookViewProps) => <Toc {...p} />,
  Chapter: (p: ViewProps & { chapterId: number }) => <Chapter {...p} />,
  Search: (p: ViewProps & { query: string }) => <Search {...p} />,
}

export default theme
