'use client'

import { useState } from 'react'
import { useCategories } from '@/hooks/use-novel-data'
import type { ThemeLayoutProps, ThemeModule, ThemeView } from '../types'
import Home from './Home'
import Category from './Category'
import Book from './Book'
import Toc from './Toc'
import Chapter from './Chapter'
import Search from './Search'
import './aijjxs.css'

/* ==================== 固定顶条：深酒红毛玻璃 + 横向滚动分类 ==================== */

function TopBar({
  view,
  navigate,
  siteName,
}: {
  view: ThemeView
  navigate: (v: ThemeView) => void
  siteName: string
}) {
  const cats = useCategories()
  const [open, setOpen] = useState(false)
  const curCat = view.name === 'category' ? view.categoryId : undefined

  return (
    <div className="aj-topbar fixed inset-x-0 top-0 z-40">
      <div className="mx-auto flex h-[58px] w-full max-w-[1220px] items-center gap-1.5 px-3 sm:px-4">
        <button
          onClick={() => navigate({ name: 'home' })}
          className="aj-toplink flex-none text-[15px] font-bold tracking-wide"
        >
          {siteName}
        </button>
        {/* 桌面：横向滚动分类链接 */}
        <nav className="hidden min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] lg:block" aria-label="分类导航">
          <div className="flex items-center gap-1 py-3">
            <button
              className="aj-toplink"
              data-active={view.name === 'home'}
              onClick={() => navigate({ name: 'home' })}
            >
              首页
            </button>
            {cats.data?.map((c) => (
              <button
                key={c.id}
                className="aj-toplink"
                data-active={curCat === c.id}
                onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
              >
                {c.name}
              </button>
            ))}
            <button
              className="aj-toplink"
              data-active={view.name === 'category' && curCat == null}
              onClick={() => navigate({ name: 'category', page: 1 })}
            >
              全部小说
            </button>
          </div>
        </nav>
        {/* 移动端：搜索 + 抽屉菜单 */}
        <button
          onClick={() => navigate({ name: 'search', query: '' })}
          className="aj-toplink ml-auto flex-none lg:hidden"
          aria-label="搜索"
        >
          搜索
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="aj-toplink flex-none"
          aria-label="菜单"
          data-active={open}
        >
          ≡ 菜单
        </button>
        <button
          onClick={() => navigate({ name: 'search', query: '' })}
          className="aj-toplink hidden flex-none lg:inline-flex"
          data-active={view.name === 'search'}
        >
          搜索
        </button>
      </div>
      {/* ≤680px 深色两列抽屉 */}
      {open && (
        <div className="max-h-[70vh] overflow-y-auto border-t border-white/10 bg-[rgba(52,6,16,0.97)] px-4 py-3 lg:hidden">
          <div className="grid grid-cols-2 gap-1.5">
            <button
              className="aj-toplink justify-center"
              onClick={() => {
                setOpen(false)
                navigate({ name: 'home' })
              }}
            >
              首页
            </button>
            {cats.data?.map((c) => (
              <button
                key={c.id}
                className="aj-toplink justify-center"
                onClick={() => {
                  setOpen(false)
                  navigate({ name: 'category', categoryId: c.id, page: 1 })
                }}
              >
                {c.name}
              </button>
            ))}
            <button
              className="aj-toplink justify-center"
              onClick={() => {
                setOpen(false)
                navigate({ name: 'category', page: 1 })
              }}
            >
              全部小说
            </button>
            <button
              className="aj-toplink justify-center"
              onClick={() => {
                setOpen(false)
                navigate({ name: 'search', query: '' })
              }}
            >
              搜索全站
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ==================== 头部卡片：站名 + 全站搜索框 ==================== */

function HeaderCard({
  navigate,
  siteName,
  notice,
}: {
  navigate: (v: ThemeView) => void
  siteName: string
  notice?: string
}) {
  const [kw, setKw] = useState('')
  const submit = () => {
    navigate({ name: 'search', query: kw.trim() })
  }
  return (
    <header className="mt-4">
      <div className="aj-card px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <button onClick={() => navigate({ name: 'home' })} className="block text-left">
              <span className="aj-logo block text-[26px] leading-[1.15] sm:text-[30px]">{siteName}</span>
              <span className="aj-logo-underline mt-1 block w-[9em] max-w-full" aria-hidden />
            </button>
            <p className="mt-1.5 text-xs text-[#6b7280]">全站小说在线阅读 · 章节即时更新 · 支持TXT下载</p>
          </div>
          <form
            className="flex w-full items-center gap-2 sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜索书名 / 作者，回车直达"
              className="h-[44px] w-full min-w-0 flex-1 rounded-[10px] border border-[#e5dccd] bg-white px-4 text-[14px] text-[#1f2937] outline-none transition-colors placeholder:text-[#b7ac97] focus:border-[#0f766e] sm:w-[320px] sm:flex-none"
            />
            <button type="submit" className="aj-btn aj-btn-teal w-[128px] flex-none">
              搜索全站
            </button>
          </form>
        </div>
      </div>
      {notice ? (
        <div className="aj-card mt-3 flex items-center gap-2 px-4 py-2.5 text-[13px] text-[#8a6d3b]">
          <span className="aj-badge">公告</span>
          <p className="min-w-0 flex-1 truncate">{notice}</p>
        </div>
      ) : null}
    </header>
  )
}

/* ==================== 页脚 ==================== */

function Footer({ navigate, siteName }: { navigate: (v: ThemeView) => void; siteName: string }) {
  const cats = useCategories()
  return (
    <footer className="border-t border-[#e5dccd] bg-[#efe9dc]/60 py-6">
      <div className="mx-auto max-w-[1220px] px-4 text-center">
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-[13px] text-[#6b7280]">
          <button className="transition-colors hover:text-[#0f766e] hover:underline" onClick={() => navigate({ name: 'home' })}>
            网站首页
          </button>
          <button className="transition-colors hover:text-[#0f766e] hover:underline" onClick={() => navigate({ name: 'category', page: 1 })}>
            全部小说
          </button>
          <button className="transition-colors hover:text-[#0f766e] hover:underline" onClick={() => navigate({ name: 'search', query: '' })}>
            站内搜索
          </button>
          {cats.data?.slice(0, 6).map((c) => (
            <button
              key={c.id}
              className="transition-colors hover:text-[#0f766e] hover:underline"
              onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
            >
              {c.name}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs leading-5 text-[#9aa1a9]">
          Copyright © {new Date().getFullYear()} {siteName} · 本站为小说系统演示站点，所有内容仅用于技术学习交流。
        </p>
        <p className="text-xs leading-5 text-[#9aa1a9]">免责声明：本站书籍均来自网络收集，版权归原作者所有，如有侵权请联系删除。</p>
      </div>
    </footer>
  )
}

/* ==================== 全站 Layout ==================== */

function Layout({ view, children, navigate, siteName, notice }: ThemeLayoutProps) {
  const isChapter = view.name === 'chapter'
  return (
    <div className="aj-root flex min-h-screen flex-col">
      <TopBar view={view} navigate={navigate} siteName={siteName} />
      <div className="flex min-w-0 flex-1 flex-col pt-[58px]">
        {/* 正文页收起头部卡片与公告，仅保留顶条 */}
        {!isChapter && (
          <div className="mx-auto w-full max-w-[1220px] px-3 sm:px-4">
            <HeaderCard navigate={navigate} siteName={siteName} notice={notice} />
          </div>
        )}
        <main className={!isChapter ? 'mx-auto w-full max-w-[1220px] px-3 pb-12 pt-4 sm:px-4' : undefined}>
          {children}
        </main>
        <div className="mt-auto">
          <Footer navigate={navigate} siteName={siteName} />
        </div>
      </div>
    </div>
  )
}

/* ==================== 主题模块导出 ==================== */

const theme: ThemeModule = {
  id: 'aijjxs',
  name: '爱尚小说',
  source: 'aijjxs.com',
  description: '奶油纸感现代卡片风：青绿×琥珀双色、圆角阴影面板、sticky 热榜侧栏与暖纸阅读器（6 背景色 / 5 档字号 / 4 字体）。',
  swatch: ['#0f766e', '#b45309'],
  Layout,
  Home,
  Category,
  Book,
  Toc,
  Chapter,
  Search,
}

export default theme
