'use client'

/**
 * 独立管理后台（hash 路由 #/admin）：
 * - 左侧固定侧边栏（桌面端）+ 右侧主区；移动端侧边栏收起为顶部横向滚动标签条
 * - useHashAdmin 负责 hash 路由同步（SSR 安全：初始 false，挂载后再读取）
 * - 区块 = 原 AdminDrawer 的七个面板（panels.tsx）+ 采集中心（ScrapeCenter）
 */

import { useEffect, useState } from 'react'
import {
  ArrowDownUp,
  ArrowLeft,
  BookOpen,
  Layers,
  Palette,
  RefreshCw,
  SearchCode,
  Settings,
  Sparkles,
} from 'lucide-react'
import { ThemesTab, NovelsTab, CategoriesTab, SeoTab, PseoTab, SettingsTab } from '@/components/admin/panels'
import ScrapeCenter from '@/components/admin/ScrapeCenter'
import { AuditTab } from '@/components/admin/AuditTab'

const SECTION_KEY = 'admin-section'

type AdminSection = 'themes' | 'novels' | 'categories' | 'seo' | 'scraper' | 'audit' | 'pseo' | 'settings'

const SECTIONS: { id: AdminSection; label: string; icon: typeof Palette }[] = [
  { id: 'themes', label: '主题', icon: Palette },
  { id: 'novels', label: '书籍', icon: BookOpen },
  { id: 'categories', label: '分类', icon: Layers },
  { id: 'seo', label: 'SEO', icon: SearchCode },
  { id: 'scraper', label: '采集中心', icon: RefreshCw },
  { id: 'audit', label: '目录体检', icon: ArrowDownUp },
  { id: 'pseo', label: 'PSEO', icon: Sparkles },
  { id: 'settings', label: '设置', icon: Settings },
]

/** hash 路由同步：#/admin 即管理后台；监听 hashchange 支持前进/后退/直达 */
export function useHashAdmin() {
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    const sync = () => setIsAdmin(window.location.hash === '#/admin')
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  return isAdmin
}

function NavButton({
  section,
  active,
  onClick,
  layout,
}: {
  section: (typeof SECTIONS)[number]
  active: boolean
  onClick: () => void
  layout: 'sidebar' | 'tabs'
}) {
  const Icon = section.icon
  const shape = layout === 'sidebar'
    ? 'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition'
    : 'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs transition'
  const state = active
    ? (layout === 'sidebar' ? 'bg-neutral-800 font-medium text-white' : 'bg-white font-medium text-neutral-900')
    : (layout === 'sidebar' ? 'text-neutral-400 hover:bg-neutral-800/60 hover:text-white' : 'text-neutral-400 hover:text-white')
  return (
    <button type="button" aria-current={active ? 'page' : undefined} onClick={onClick} className={`${shape} ${state}`}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {section.label}
    </button>
  )
}

function BackButton({ compact }: { compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => { window.location.hash = '' }}
      className={
        compact
          ? 'flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-xs text-neutral-300 transition hover:text-white'
          : 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-neutral-400 transition hover:bg-neutral-800/60 hover:text-white'
      }
    >
      <ArrowLeft className={compact ? 'h-3.5 w-3.5 shrink-0' : 'h-4 w-4 shrink-0'} aria-hidden />
      返回站点
    </button>
  )
}

function Brand() {
  return (
    <p className="flex items-center gap-2 text-sm font-semibold text-white">
      <Sparkles className="h-4 w-4 shrink-0" aria-hidden /> 站点管理控制台
    </p>
  )
}

export function AdminConsole() {
  // 上次所在区块记忆到 localStorage（AdminConsole 仅客户端挂载，初始值恒定可安全惰性读取）
  const [activeSection, setActiveSection] = useState<AdminSection>(() => {
    if (typeof window === 'undefined') return 'themes'
    try {
      const saved = window.localStorage.getItem(SECTION_KEY)
      if (saved && SECTIONS.some((s) => s.id === saved)) return saved as AdminSection
    } catch {
      /* 存储不可用时忽略 */
    }
    return 'themes'
  })

  useEffect(() => {
    document.title = `站点管理控制台 · ${SECTIONS.find((s) => s.id === activeSection)?.label ?? ''}`
  }, [activeSection])

  const select = (id: AdminSection) => {
    setActiveSection(id)
    try {
      window.localStorage.setItem(SECTION_KEY, id)
    } catch {
      /* 存储不可用时忽略 */
    }
  }

  const current = SECTIONS.find((s) => s.id === activeSection) ?? SECTIONS[0]

  return (
    <div className="flex min-h-screen flex-col bg-neutral-100 lg:flex-row">
      {/* 桌面端：左侧固定侧边栏 */}
      <aside className="hidden w-52 shrink-0 flex-col bg-neutral-900 lg:sticky lg:top-0 lg:flex lg:h-screen">
        <div className="border-b border-neutral-800 px-5 py-5">
          <Brand />
        </div>
        <nav aria-label="管理导航" className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {SECTIONS.map((s) => (
            <NavButton key={s.id} section={s} active={activeSection === s.id} onClick={() => select(s.id)} layout="sidebar" />
          ))}
        </nav>
        <div className="border-t border-neutral-800 p-3">
          <BackButton />
        </div>
      </aside>

      {/* 移动端：顶部标题条 + 横向滚动标签条 */}
      <div className="bg-neutral-900 lg:hidden">
        <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 py-3">
          <Brand />
          <BackButton compact />
        </div>
        <nav
          aria-label="管理导航"
          className="flex gap-1.5 overflow-x-auto p-2 [&::-webkit-scrollbar]:hidden"
          style={{ scrollbarWidth: 'none' }}
        >
          {SECTIONS.map((s) => (
            <NavButton key={s.id} section={s} active={activeSection === s.id} onClick={() => select(s.id)} layout="tabs" />
          ))}
        </nav>
      </div>

      {/* 主区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-neutral-200 bg-white px-4 py-3.5 sm:px-6">
          <h1 className="text-base font-semibold text-neutral-900">{current.label}</h1>
        </header>
        <main className="mx-auto w-full max-w-4xl flex-1 p-4 sm:p-6">
          {activeSection === 'themes' && <ThemesTab />}
          {activeSection === 'novels' && <NovelsTab />}
          {activeSection === 'categories' && <CategoriesTab />}
          {activeSection === 'seo' && <SeoTab />}
          {activeSection === 'scraper' && <ScrapeCenter />}
          {activeSection === 'audit' && <AuditTab />}
          {activeSection === 'pseo' && <PseoTab />}
          {activeSection === 'settings' && <SettingsTab />}
        </main>
      </div>
    </div>
  )
}
