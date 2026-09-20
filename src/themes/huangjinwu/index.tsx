'use client'

import { useState } from 'react'
import { ChevronLeft, History, Languages, Menu, Search as SearchIcon, Star, X } from 'lucide-react'
import { useCategories, useSettings } from '@/hooks/use-novel-data'
import { HistoryPanel } from '@/components/theme-tools/HistoryPanel'
import { useFavoriteSite } from '@/components/theme-tools/FavoriteSite'
import { TradToggle } from '@/components/theme-tools/TradToggle'
import { cn } from '@/lib/utils'
import type { ThemeLayoutProps, ThemeModule, ThemeView, ViewProps } from '../types'
import { Category, Book, Chapter, Home, Search, Toc } from './views'

/* ==================== 全站框架：毛玻璃白导航条 + 页脚 ==================== */

interface MenuItem {
  label: string
  view: ThemeView
  active: boolean
}

function useMenuItems(view: ThemeView): MenuItem[] {
  const { data: cats } = useCategories()
  const items: MenuItem[] = [
    { label: '首页', view: { name: 'home' }, active: view.name === 'home' },
    {
      label: '书库',
      view: { name: 'category' },
      active: view.name === 'category' && view.categoryId == null,
    },
  ]
  for (const c of (cats ?? []).slice(0, 4)) {
    items.push({
      label: c.name,
      view: { name: 'category', categoryId: c.id, page: 1 },
      active: view.name === 'category' && view.categoryId === c.id,
    })
  }
  return items
}

function NavButton({
  item,
  navigate,
  className,
}: {
  item: MenuItem
  navigate: (v: ThemeView) => void
  className?: string
}) {
  return (
    <button
      onClick={() => navigate(item.view)}
      className={cn(
        'cursor-pointer rounded-lg px-3 py-2 text-[15px] transition-colors duration-200',
        item.active
          ? 'bg-[#e8f1ff] font-medium text-[#2563eb]'
          : 'text-[#1e293b] hover:bg-[#e8f1ff] hover:text-[#2563eb]',
        className,
      )}
    >
      {item.label}
    </button>
  )
}

function SearchForm({
  navigate,
  autoFocus,
  onDone,
  className,
}: {
  navigate: (v: ThemeView) => void
  autoFocus?: boolean
  onDone?: () => void
  className?: string
}) {
  const [kw, setKw] = useState('')
  const submit = () => {
    const q = kw.trim()
    if (!q) return
    navigate({ name: 'search', query: q })
    setKw('')
    onDone?.()
  }
  return (
    <div className={cn('relative', className)}>
      <input
        value={kw}
        autoFocus={autoFocus}
        onChange={(e) => setKw(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="搜索书名 / 作者"
        className="h-9 w-full rounded-[10px] border border-[#dbe4f0] bg-[#f0f4fb] pr-9 pl-3 text-[14px] text-[#1e293b] outline-none transition-colors duration-200 placeholder:text-[#94a3b8] focus:border-[#2563eb] focus:bg-white"
      />
      <button
        aria-label="搜索"
        onClick={submit}
        className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded-md p-1.5 text-[#64748b] transition-colors duration-200 hover:text-[#2563eb]"
      >
        <SearchIcon size={16} />
      </button>
    </div>
  )
}

function Layout({ view, children, navigate, siteName, notice }: ThemeLayoutProps) {
  const [drawer, setDrawer] = useState(false)
  const [histOpen, setHistOpen] = useState(false)
  const menu = useMenuItems(view)
  const { data: settings } = useSettings()
  const { promptFavorite } = useFavoriteSite()
  const footerCfg = settings?.footer
  const isHome = view.name === 'home'

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#f5f8ff] to-[#eef3fb] text-[16px] text-[#1e293b]">
      {/* 顶部毛玻璃导航条 */}
      <header className="sticky top-0 z-40 border-b border-[#dbe4f0] bg-white/90 backdrop-blur-[12px]">
        <div className="mx-auto flex h-16 max-w-[1180px] items-center gap-3 px-4">
          {/* 子页返回按钮 */}
          {!isHome && (
            <button
              aria-label="返回首页"
              onClick={() => navigate({ name: 'home' })}
              className="cursor-pointer rounded-lg p-2 text-[#64748b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]"
            >
              <ChevronLeft size={20} />
            </button>
          )}

          {/* 文字 Logo */}
          <button
            onClick={() => navigate({ name: 'home' })}
            className="flex shrink-0 cursor-pointer items-center gap-2"
          >
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#2563eb] text-[15px] font-bold text-white">
              {siteName.slice(0, 1)}
            </span>
            <span className="text-[20px] font-semibold text-[#1d4ed8]">{siteName}</span>
          </button>

          {/* 横向菜单 */}
          <nav className="ml-4 hidden items-center gap-0.5 lg:flex">
            {menu.map((it) => (
              <NavButton key={it.label} item={it} navigate={navigate} />
            ))}
          </nav>

          {/* 搜索框 */}
          <div className="ml-auto hidden sm:block">
            <SearchForm navigate={navigate} className="w-[220px] lg:w-[250px]" />
          </div>

          {/* 站点工具（阅读/收藏/简繁） */}
          <div className="hidden items-center gap-0.5 md:flex">
            <button
              aria-label="阅读记录"
              title="阅读记录：查看最近读过的章节"
              onClick={() => setHistOpen(true)}
              className="cursor-pointer rounded-lg p-2 text-[#64748b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]"
            >
              <History size={19} />
            </button>
            <button
              aria-label="收藏本站"
              title="把本站加入浏览器收藏夹"
              onClick={promptFavorite}
              className="cursor-pointer rounded-lg p-2 text-[#64748b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]"
            >
              <Star size={19} />
            </button>
            <div
              title="全站简繁切换"
              className="flex cursor-pointer items-center rounded-lg p-2 text-[13px] text-[#64748b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]"
            >
              <Languages size={19} />
              <TradToggle className="ml-1" />
            </div>
          </div>

          {/* 移动端汉堡 */}
          <button
            aria-label="打开菜单"
            onClick={() => setDrawer(true)}
            className="ml-auto cursor-pointer rounded-lg p-2 text-[#1e293b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb] lg:hidden"
          >
            <Menu size={22} />
          </button>
        </div>

        {notice ? (
          <div className="border-t border-[#dbe4f0]/70 bg-[#e8f1ff]/70">
            <p className="mx-auto max-w-[1180px] truncate px-4 py-2 text-[13px] text-[#2563eb]">
              公告：{notice}
            </p>
          </div>
        ) : null}
      </header>

      <main className="min-w-0 flex-1">{children}</main>

      {/* 页脚 */}
      <footer className="mt-12 border-t border-[#dbe4f0] bg-[#e2eaf5] py-10 text-[14px] text-[#64748b]">
        <div className="mx-auto max-w-[1180px] space-y-3 px-4 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[#1e293b]">
            {menu.map((it, i) => (
              <span key={it.label} className="flex items-center gap-2">
                {i > 0 && <span className="text-[#94a3b8]">|</span>}
                <button
                  onClick={() => navigate(it.view)}
                  className="cursor-pointer transition-colors duration-200 hover:text-[#2563eb]"
                >
                  {it.label}
                </button>
              </span>
            ))}
            <span className="flex items-center gap-2">
              <span className="text-[#94a3b8]">|</span>
              <button
                onClick={() => setHistOpen(true)}
                className="cursor-pointer transition-colors duration-200 hover:text-[#2563eb]"
                title="查看最近读过的章节"
              >
                阅读记录
              </button>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-[#94a3b8]">|</span>
              <button
                onClick={promptFavorite}
                className="cursor-pointer transition-colors duration-200 hover:text-[#2563eb]"
                title="把本站加入浏览器收藏夹"
              >
                收藏本站
              </button>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-[#94a3b8]">|</span>
              <TradToggle className="hover:text-[#2563eb]" />
            </span>
            {(footerCfg?.links ?? []).map((lk) => (
              <span key={`${lk.label}-${lk.href}`} className="flex items-center gap-2">
                <span className="text-[#94a3b8]">|</span>
                <a href={lk.href} target="_blank" rel="noopener noreferrer" className="transition-colors duration-200 hover:text-[#2563eb]">
                  {lk.label}
                </a>
              </span>
            ))}
          </div>
          <p>{footerCfg?.text || `© ${new Date().getFullYear()} ${siteName} · 结构级主题模板演示，布局风格仿 huangjinwu.org`}</p>
          <p>{footerCfg?.extra || '本站所有小说与章节均为演示数据，仅用于前端效果展示。'}</p>
        </div>
      </footer>

      {/* 移动端左侧抽屉 */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-[#0f172a]/40" onClick={() => setDrawer(false)} />
          <aside className="no-scrollbar absolute top-0 left-0 h-full w-[270px] overflow-y-auto bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-[18px] font-semibold text-[#1d4ed8]">{siteName}</span>
              <button
                aria-label="关闭菜单"
                onClick={() => setDrawer(false)}
                className="cursor-pointer rounded-lg p-2 text-[#64748b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]"
              >
                <X size={20} />
              </button>
            </div>
            <SearchForm navigate={navigate} autoFocus onDone={() => setDrawer(false)} className="mt-4" />
            <nav className="mt-4 flex flex-col gap-1">
              {menu.map((it) => (
                <NavButton
                  key={it.label}
                  item={it}
                  navigate={(v) => {
                    navigate(v)
                    setDrawer(false)
                  }}
                  className="w-full text-left"
                />
              ))}
              <div className="mt-2 flex flex-col gap-1 border-t border-[#dbe4f0] pt-2">
                <button
                  onClick={() => {
                    setDrawer(false)
                    setHistOpen(true)
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] text-[#1e293b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]"
                >
                  <History size={18} className="text-[#2563eb]" />
                  阅读记录
                </button>
                <button
                  onClick={() => {
                    setDrawer(false)
                    promptFavorite()
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] text-[#1e293b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]"
                >
                  <Star size={18} className="text-[#2563eb]" />
                  收藏本站
                </button>
                <div className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] text-[#1e293b] transition-colors duration-200 hover:bg-[#e8f1ff] hover:text-[#2563eb]">
                  <Languages size={18} className="text-[#2563eb]" />
                  <TradToggle />
                </div>
              </div>
            </nav>
          </aside>
        </div>
      )}

      <HistoryPanel
        open={histOpen}
        onClose={() => setHistOpen(false)}
        navigate={navigate}
        accent="#2563eb"
      />
    </div>
  )
}

/* ==================== 主题模块 ==================== */

type BookViewProps = ViewProps & { novelId: number }

const theme: ThemeModule = {
  id: 'huangjinwu',
  name: '黄金屋',
  source: 'huangjinwu.org',
  description: '现代扁平卡片流：浅蓝灰底 + 白色大圆角卡片 + 蓝色强调，文字卡片与榜单模块为主',
  swatch: ['#2563eb', '#f0f4fb'],
  Layout: (p: ThemeLayoutProps) => <Layout {...p} />,
  Home: (p: ViewProps) => <Home {...p} />,
  Category: (p: ViewProps & { categoryId?: number; page?: number }) => <Category {...p} />,
  Book: (p: BookViewProps) => <Book {...p} />,
  Toc: (p: BookViewProps) => <Toc {...p} />,
  Chapter: (p: ViewProps & { chapterId: number }) => <Chapter {...p} />,
  Search: (p: ViewProps & { query: string }) => <Search {...p} />,
}

export default theme
