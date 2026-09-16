'use client'

// ==================== 101kks 全站框架 ====================
// 固定宝蓝顶栏（75px / ≤lg 50px）+ 顶栏内嵌搜索 + 桌面横向菜单（hover 反白）；
// 移动端汉堡 → 左侧 300px 抽屉；域名公告条浅米黄；白底居中页脚。
// 正文页（chapter）隐藏顶栏与页脚，渲染独立沉浸式阅读容器。

import { useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  CheckCircle2,
  Clock3,
  Flame,
  Home,
  Library,
  Menu,
  Search,
  UserRound,
  X,
} from 'lucide-react'
import { useCategories } from '@/hooks/use-novel-data'
import { cn } from '@/lib/utils'
import type { ThemeLayoutProps, ThemeView } from '../types'
import { Container, setCategoryIntent } from './ui'

interface NavItem {
  label: string
  icon: React.ComponentType<{ className?: string }>
  go: (navigate: (v: ThemeView) => void) => void
}

const NAV: NavItem[] = [
  { label: '首頁', icon: Home, go: (nav) => nav({ name: 'home' }) },
  {
    label: '書庫',
    icon: Library,
    go: (nav) => {
      setCategoryIntent(null)
      nav({ name: 'category', page: 1 })
    },
  },
  {
    label: '排行',
    icon: Flame,
    go: (nav) => {
      setCategoryIntent({ sort: 'clicks' })
      nav({ name: 'category', page: 1 })
    },
  },
  {
    label: '完本',
    icon: CheckCircle2,
    go: (nav) => {
      setCategoryIntent({ status: 'finished' })
      nav({ name: 'category', page: 1 })
    },
  },
  {
    label: '最新',
    icon: Clock3,
    go: (nav) => {
      setCategoryIntent({ sort: 'latest' })
      nav({ name: 'category', page: 1 })
    },
  },
  { label: '搜尋', icon: Search, go: (nav) => nav({ name: 'search', query: '' }) },
]

export function KksLayout({ view, children, navigate, siteName, notice }: ThemeLayoutProps) {
  const [q, setQ] = useState('')
  const [drawer, setDrawer] = useState(false)
  const { data: categories } = useCategories()
  const drawerRef = useRef<HTMLDivElement>(null)

  const [lastView, setLastView] = useState(view)

  if (lastView !== view) {
    setLastView(view)
    if (drawer) setDrawer(false)
  }

  useEffect(() => {
    if (!drawer) return
    const onDown = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) setDrawer(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [drawer])

  // 正文页：独立沉浸式阅读容器（隐藏顶栏 / 公告条 / 页脚）
  if (view.name === 'chapter') return <>{children}</>

  const goCategory = (intent: Parameters<typeof setCategoryIntent>[0]) => {
    setCategoryIntent(intent)
    navigate({ name: 'category', page: 1 })
  }

  return (
    <div className="min-h-screen bg-[#f2f3f4] text-[#333]">
      {/* 固定宝蓝顶栏 */}
      <header className="fixed inset-x-0 top-0 z-50 h-[50px] bg-[#1f6cb2] text-white lg:h-[75px]">
        <div className="mx-auto flex h-full max-w-[1250px] items-center gap-2 px-3 sm:gap-3 lg:gap-5">
          {/* 汉堡（≤lg） */}
          <button
            type="button"
            aria-label="菜单"
            onClick={() => setDrawer(true)}
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[3px] transition-colors hover:bg-white/15 lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* Logo + 站名 */}
          <button
            type="button"
            onClick={() => navigate({ name: 'home' })}
            className="flex shrink-0 cursor-pointer items-center gap-2"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-[5px] bg-white/20 text-sm font-black lg:h-9 lg:w-9">
              看
            </span>
            <span className="text-lg font-bold tracking-wide lg:text-[25px]">{siteName}</span>
          </button>

          {/* 顶栏内嵌搜索：透明输入 + 白色竖线分隔的放大镜 */}
          <form
            className="mx-1 hidden min-w-0 flex-1 items-center sm:flex lg:mx-4"
            onSubmit={(e) => {
              e.preventDefault()
              navigate({ name: 'search', query: q.trim() })
            }}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜尋書名 / 作者"
              className="h-9 min-w-0 flex-1 border-0 bg-transparent px-2 text-sm text-white outline-none placeholder:text-white/65"
            />
            <span className="mx-1 h-5 w-px bg-white/40" />
            <button type="submit" aria-label="搜尋" className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[3px] transition-colors hover:bg-white/15">
              <Search className="h-4.5 w-4.5" />
            </button>
          </form>

          {/* 桌面横向菜单：hover 白底蓝字反色 */}
          <nav className="hidden h-full shrink-0 items-stretch lg:flex">
            {NAV.map((item) => {
              const Icon = item.icon
              const active =
                (item.label === '首頁' && view.name === 'home') ||
                (item.label === '搜尋' && view.name === 'search')
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => item.go(navigate)}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 px-3.5 text-[15px] transition-colors hover:bg-white hover:text-[#1f6cb2]',
                    active && 'bg-white/15',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              )
            })}
          </nav>

          {/* 头像 */}
          <span className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/20 lg:ml-0">
            <UserRound className="h-5 w-5" />
          </span>
        </div>
      </header>

      {/* 左侧抽屉（≤lg） */}
      {drawer && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <div ref={drawerRef} className="absolute inset-y-0 left-0 flex w-[300px] flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between bg-[#1f6cb2] px-4 py-4 text-white">
              <div className="flex items-center gap-2.5">
                <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-white/20">
                  <UserRound className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-base font-bold">{siteName}</p>
                  <p className="text-xs text-white/70">登入 / 註冊（演示未開放）</p>
                </div>
              </div>
              <button
                type="button"
                aria-label="關閉"
                onClick={() => setDrawer(false)}
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[3px] hover:bg-white/15"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="no-scrollbar flex-1 overflow-y-auto p-3">
              {NAV.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => item.go(navigate)}
                    className="flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-[3px] px-3 text-[15px] text-[#333] transition-colors hover:bg-[#e8f4ff] hover:text-[#1f6cb2]"
                  >
                    <Icon className="h-4 w-4 text-[#1f6cb2]" />
                    {item.label}
                  </button>
                )
              })}
              <div className="mt-3 border-t border-black/10 pt-3">
                <p className="px-3 pb-1 text-xs text-[#888]">小說分類</p>
                {(categories ?? []).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setCategoryIntent(null)
                      navigate({ name: 'category', categoryId: c.id, page: 1 })
                    }}
                    className="flex h-10 w-full cursor-pointer items-center justify-between rounded-[3px] px-3 text-sm text-[#333] transition-colors hover:bg-[#e8f4ff] hover:text-[#1f6cb2]"
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="text-[11px] text-[#888]">{c.novelCount}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 域名公告条：浅米黄通栏（位于固定顶栏下方、文档流内） */}
      <div className="pt-[50px] lg:pt-[75px]">
        {notice ? (
          <div className="flex h-[30px] items-center justify-center overflow-hidden bg-[#fff2df] px-3 text-xs text-[#8a6d3b] lg:h-[40px] lg:text-[13px]">
            <p className="truncate">
              <BookOpen className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
              {notice}
            </p>
          </div>
        ) : null}

        <main>{children}</main>
      </div>

      {/* 页脚：白底居中三行 */}
      <footer className="mt-8 bg-white py-6 text-center">
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-sm text-[#333]" style={{ lineHeight: 2 }}>
          <button type="button" onClick={() => goCategory({ sort: 'clicks' })} className="cursor-pointer hover:text-[#06c]">
            排行
          </button>
          <button type="button" onClick={() => goCategory({ sort: 'latest' })} className="cursor-pointer hover:text-[#06c]">
            最新
          </button>
          <button type="button" onClick={() => goCategory(null)} className="cursor-pointer hover:text-[#06c]">
            分類
          </button>
          <button type="button" onClick={() => navigate({ name: 'search', query: '' })} className="cursor-pointer hover:text-[#06c]">
            搜尋
          </button>
          <button type="button" onClick={() => navigate({ name: 'home' })} className="cursor-pointer hover:text-[#06c]">
            首頁
          </button>
        </div>
        <p className="mt-1 text-xs text-[#888]" style={{ lineHeight: 2 }}>
          © {new Date().getFullYear()} {siteName} · 界面结构级主题模板（仿 101kks 布局 / 原创实现）
        </p>
        <p className="mt-1 text-xs text-[#888]" style={{ lineHeight: 2 }}>
          友情連結
          <span className="mx-2 text-black/20">|</span>使用條款
          <span className="mx-2 text-black/20">|</span>隱私政策
        </p>
      </footer>
    </div>
  )
}
