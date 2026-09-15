'use client'

// ==================== 23qb 全站框架 ====================
// 固定 70px 顶栏：首页悬浮透明、滚动/非首页为 #eaedf1 + 毛玻璃；
// 横向分类导航（选中项 35% 宽 4px 红橙渐变短条）+ 右侧「全部分类」下拉网格；
// 页脚浅灰 #f3f5f7、12px 次要色。正文页框架正常渲染。

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, LayoutGrid, Menu, X } from 'lucide-react'
import { useCategories } from '@/hooks/use-novel-data'
import { cn } from '@/lib/utils'
import type { ThemeLayoutProps } from '../types'
import { Container } from './ui'

export function QBLayout({ view, children, navigate, siteName }: ThemeLayoutProps) {
  const [scrolled, setScrolled] = useState(false)
  const [allOpen, setAllOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { data: categories } = useCategories()
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // 点击外部关闭「全部分类」弹层
  useEffect(() => {
    if (!allOpen) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setAllOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [allOpen])

  const isHome = view.name === 'home'
  const activeCatId = view.name === 'category' ? view.categoryId : undefined
  const cats = categories ?? []
  const navCats = cats.slice(0, 10)
  const solid = scrolled || !isHome

  return (
    <div className="min-h-screen bg-[#f8f9f9] text-[#282828]">
      <header
        className={cn(
          'fixed inset-x-0 top-0 z-50 transition-[background-color,box-shadow] duration-300',
          solid
            ? 'bg-[#eaedf1]/95 shadow-[0_2px_12px_rgba(149,157,165,.18)] backdrop-blur-[10px]'
            : 'bg-transparent',
        )}
      >
        <Container className="flex h-[70px] items-center gap-4 md:gap-8">
          {/* Logo（原创文字标） */}
          <button
            type="button"
            onClick={() => navigate({ name: 'home' })}
            className="flex shrink-0 cursor-pointer items-center gap-2"
          >
            <span
              className="flex h-8 w-8 items-center justify-center rounded-[10px] text-base font-black italic text-white"
              style={{ backgroundImage: 'linear-gradient(135deg, #ff9800, #ff2a14)' }}
            >
              笔
            </span>
            <span className="text-lg font-bold tracking-wide text-[#282828]">
              {siteName}
              <span className="ml-1 hidden text-xs font-medium text-black/40 sm:inline">结构演示主题</span>
            </span>
          </button>

          {/* 横向分类导航（桌面） */}
          <nav className="hidden min-w-0 flex-1 items-center gap-6 lg:flex xl:gap-7">
            {navCats.map((c) => {
              const active = activeCatId === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
                  className={cn(
                    'relative shrink-0 cursor-pointer py-2 text-base font-bold transition-colors',
                    active ? 'text-[#ff2a14]' : 'text-[#282828] hover:text-[#ff2a14]',
                  )}
                >
                  {c.name}
                  {active && (
                    <span
                      className="absolute inset-x-1/2 bottom-0 h-1 w-[35%] -translate-x-1/2 rounded-full"
                      style={{ backgroundImage: 'linear-gradient(90deg, #ff9800, #ff2a14)' }}
                    />
                  )}
                </button>
              )
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 lg:ml-0">
            {/* 全部分类下拉 */}
            <div className="relative" ref={boxRef}>
              <button
                type="button"
                onClick={() => setAllOpen((v) => !v)}
                className={cn(
                  'hidden h-9 cursor-pointer items-center gap-1 rounded-[10px] px-3 text-sm font-medium transition-colors sm:flex',
                  allOpen ? 'bg-white text-[#ff2a14]' : 'text-[#282828] hover:text-[#ff2a14]',
                  solid ? 'hover:bg-white/70' : 'hover:bg-white/60',
                )}
              >
                <LayoutGrid className="h-4 w-4" />
                全部分类
                <ChevronDown className={cn('h-4 w-4 transition-transform', allOpen && 'rotate-180')} />
              </button>
              {allOpen && (
                <div className="absolute right-0 top-[calc(100%+10px)] z-50 w-[275px] rounded-[14px] bg-white p-3 shadow-[0_12px_30px_rgba(149,157,165,.3)]">
                  <div className="grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setAllOpen(false)
                        navigate({ name: 'category', page: 1 })
                      }}
                      className="flex h-10 cursor-pointer items-center rounded-[10px] px-3 text-sm font-bold text-[#ff2a14] transition-colors hover:bg-[#f3f5f7]"
                    >
                      全部小说
                    </button>
                    {cats.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setAllOpen(false)
                          navigate({ name: 'category', categoryId: c.id, page: 1 })
                        }}
                        className="flex h-10 cursor-pointer items-center justify-between rounded-[10px] px-3 text-sm text-[#282828] transition-colors hover:bg-[#f3f5f7] hover:text-[#ff2a14]"
                      >
                        <span className="truncate">{c.name}</span>
                        <span className="text-[11px] text-black/30">{c.novelCount}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 移动端汉堡 */}
            <button
              type="button"
              aria-label="菜单"
              onClick={() => setMobileOpen(true)}
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[10px] text-[#282828] transition-colors hover:bg-white/70 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </Container>
      </header>

      {/* 移动端分类抽屉 */}
      {mobileOpen && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-[280px] flex-col bg-white shadow-2xl">
            <div className="flex h-[70px] shrink-0 items-center justify-between border-b border-[#eaedf1] px-4">
              <span className="font-bold">全部分类</span>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setMobileOpen(false)}
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-black/50 hover:bg-[#f3f5f7]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <button
                type="button"
                onClick={() => {
                  setMobileOpen(false)
                  navigate({ name: 'category', page: 1 })
                }}
                className="flex h-11 w-full cursor-pointer items-center rounded-[10px] px-3 text-sm font-bold text-[#ff2a14] hover:bg-[#f3f5f7]"
              >
                全部小说
              </button>
              {cats.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setMobileOpen(false)
                    navigate({ name: 'category', categoryId: c.id, page: 1 })
                  }}
                  className={cn(
                    'flex h-11 w-full cursor-pointer items-center justify-between rounded-[10px] px-3 text-sm hover:bg-[#f3f5f7] hover:text-[#ff2a14]',
                    activeCatId === c.id && 'font-bold text-[#ff2a14]',
                  )}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="text-[11px] text-black/30">{c.novelCount}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 首页顶栏悬浮在头图上：无占位 padding */}
      <main className={cn(!isHome && 'pt-[70px]')}>{children}</main>

      <footer className="mt-12 bg-[#f3f5f7]">
        <Container className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4 text-xs text-black/50">
          <p>
            © {new Date().getFullYear()} {siteName} · 界面结构级主题模板（仿 23qb 布局 / 原创实现）
          </p>
          <p className="flex items-center gap-3">
            <span>RSS</span>
            <span className="text-black/20">|</span>
            <span>Google</span>
            <span className="text-black/20">|</span>
            <span>Bing</span>
          </p>
        </Container>
      </footer>
    </div>
  )
}
