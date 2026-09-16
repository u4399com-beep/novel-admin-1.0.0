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
import './ddyueshu.css'

/* ==================== 页脚 ==================== */

function Footer({ navigate, siteName }: { navigate: (v: ThemeView) => void; siteName: string }) {
  const cats = useCategories()
  return (
    <footer className="bg-white pb-10 pt-3">
      <div className="mx-auto w-[92%] border-b-2 border-[#88c6e5] pb-2">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[13px]">
          <button className="dd-greenlink" onClick={() => navigate({ name: 'home' })}>
            网站首页
          </button>
          <button className="dd-greenlink" onClick={() => navigate({ name: 'category', page: 1 })}>
            全部小说
          </button>
          <button className="dd-greenlink" onClick={() => navigate({ name: 'search', query: '' })}>
            站内搜索
          </button>
          {(cats.data ?? []).slice(0, 8).map((c) => (
            <button
              key={c.id}
              className="dd-greenlink"
              onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
            >
              {c.name}小说
            </button>
          ))}
        </div>
      </div>
      <p className="mt-3 px-4 text-center text-[12px] leading-[20px] text-[#b2b2b2]">
        本站为小说站主题演示项目，全部书籍与章节内容仅用于技术学习与界面还原测试。
      </p>
      <p className="px-4 text-center text-[12px] leading-[20px] text-[#b2b2b2]">
        Copyright © {new Date().getFullYear()} {siteName} · 主题版式致敬经典笔趣阁
      </p>
    </footer>
  )
}

/* ==================== 全站 Layout ==================== */

function Layout({ view, children, navigate, siteName, notice }: ThemeLayoutProps) {
  const cats = useCategories()
  const isChapter = view.name === 'chapter'
  const [kw, setKw] = useState('')
  const [loginMsg, setLoginMsg] = useState('')
  const curCat = view.name === 'category' ? view.categoryId : undefined
  const goSearch = () => {
    const q = kw.trim()
    if (q) navigate({ name: 'search', query: q })
  }

  return (
    <div className="dd-root flex min-h-screen flex-col">
      {!isChapter && (
        <>
          {/* ① 欢迎条 28px：左功能 / 右内联登录表单（演示站点，仅样式） */}
          <div className="border-b border-[#a6d3e8] bg-[#e1eced]">
            <div className="mx-auto flex h-[28px] w-full max-w-[980px] items-center justify-between gap-2 px-2 text-[12px] text-[#777]">
              <div className="flex flex-none items-center gap-2">
                <button className="cursor-pointer hover:text-[#459df5] hover:underline" title="演示站点，功能未开放">
                  设为首页
                </button>
                <span className="text-[#ccc]">|</span>
                <button className="cursor-pointer hover:text-[#459df5] hover:underline" title="演示站点，功能未开放">
                  收藏本站
                </button>
                <span className="hidden text-[#b3b3b3] sm:inline">欢迎光临，本站每日更新小说！</span>
              </div>
              <div className="flex min-w-0 items-center gap-1">
                <input placeholder="账号" className="dd-input w-[64px]" />
                <input placeholder="密码" type="password" className="dd-input w-[64px]" />
                <button
                  onClick={() => setLoginMsg('演示站点未开放登录')}
                  className="h-[20px] flex-none cursor-pointer bg-[#88c6e5] px-2 text-[12px] text-white transition-colors hover:bg-[#459df5]"
                >
                  登陆
                </button>
                <button className="dd-link flex-none" onClick={() => setLoginMsg('演示站点未开放注册')}>
                  用户注册
                </button>
                {loginMsg && <span className="dd-hottext flex-none">{loginMsg}</span>}
              </div>
            </div>
          </div>

          {/* ② 头部 61px：Logo + 450px 搜索表单 + 分享面板 */}
          <div className="mx-auto flex w-full max-w-[980px] flex-wrap items-center gap-x-4 gap-y-2 px-2 py-[10px]">
            <button
              onClick={() => navigate({ name: 'home' })}
              className="dd-hei flex-none text-[26px] font-bold leading-[40px] tracking-wide text-[#2f6f9f] transition-colors hover:text-[#459df5]"
            >
              {siteName}
            </button>
            <form
              className="order-3 w-full min-w-0 md:order-none md:w-auto md:flex-1 md:flex md:justify-center"
              onSubmit={(e) => {
                e.preventDefault()
                goSearch()
              }}
            >
              <div className="flex h-[30px] w-full max-w-[450px] border-2 border-[#88c6e5] bg-white">
                <input
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                  placeholder="搜书名 / 搜作者"
                  className="min-w-0 flex-1 px-2 text-[13px] outline-none"
                />
                <button
                  type="submit"
                  className="w-[100px] flex-none cursor-pointer bg-[#88c6e5] text-[16px] text-white transition-colors hover:bg-[#459df5]"
                >
                  搜 索
                </button>
              </div>
            </form>
            <div className="hidden w-[220px] flex-none border border-dashed border-[#ccc] px-2 py-[5px] leading-[18px] text-[#999] xl:block">
              分享到：
              {['新浪', 'QQ', '微信', '豆瓣'].map((s) => (
                <button key={s} className="dd-link mr-1 text-[12px]" title="演示站点，分享未开放">
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* ③ 主导航 40px 天蓝横条 */}
          <div className="bg-[#88c6e5]">
            <nav
              className="mx-auto flex w-full max-w-[980px] items-stretch overflow-x-auto px-2 [scrollbar-width:none]"
              aria-label="主导航"
            >
              <button
                className="dd-nav-item"
                data-active={view.name === 'home'}
                onClick={() => navigate({ name: 'home' })}
              >
                首页
              </button>
              {(cats.data ?? []).slice(0, 8).map((c) => (
                <button
                  key={c.id}
                  className="dd-nav-item"
                  data-active={curCat === c.id}
                  onClick={() => navigate({ name: 'category', categoryId: c.id, page: 1 })}
                >
                  {c.name}
                </button>
              ))}
              <button
                className="dd-nav-item"
                data-active={view.name === 'category' && curCat == null}
                onClick={() => navigate({ name: 'category', page: 1 })}
              >
                全部小说
              </button>
            </nav>
          </div>

          {/* 公告条 */}
          {notice && (
            <div className="mx-auto w-full max-w-[980px] px-2 pt-1.5 text-[12px]">
              <span className="dd-hottext font-bold">公告：</span>
              <span className="text-[#667788]">{notice}</span>
            </div>
          )}
        </>
      )}

      {/* 正文页简化顶条：Logo + 返回首页 + 紧凑搜索 */}
      {isChapter && (
        <div className="border-b-2 border-[#88c6e5] bg-white">
          <div className="mx-auto flex h-[46px] w-full max-w-[980px] items-center justify-between gap-3 px-2">
            <button
              onClick={() => navigate({ name: 'home' })}
              className="dd-hei flex-none text-[20px] font-bold text-[#2f6f9f] transition-colors hover:text-[#459df5]"
            >
              {siteName}
            </button>
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              <button className="dd-greenlink flex-none" onClick={() => navigate({ name: 'home' })}>
                返回首页
              </button>
              <form
                className="flex min-w-0"
                onSubmit={(e) => {
                  e.preventDefault()
                  goSearch()
                }}
              >
                <input
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                  placeholder="搜书名/作者"
                  className="dd-input h-[24px] min-w-0 flex-1 border-2 border-[#88c6e5]"
                />
                <button
                  type="submit"
                  className="h-[24px] flex-none cursor-pointer bg-[#88c6e5] px-2 text-[12px] text-white transition-colors hover:bg-[#459df5]"
                >
                  搜索
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* 980px 定宽主体 */}
      <main className="mx-auto w-full max-w-[980px] flex-1 px-2 pb-6 pt-2">{children}</main>
      <Footer navigate={navigate} siteName={siteName} />
    </div>
  )
}

/* ==================== 主题模块导出 ==================== */

const theme: ThemeModule = {
  id: 'ddyueshu',
  name: '顶点小说',
  source: 'ddyueshu.cc',
  description: '经典笔趣阁版式：天蓝导航 + 米黄区块、980px 定宽直角描边、宋体高密度列表与 19pt 阅读正文。',
  swatch: ['#88C6E5', '#FEF9EF'],
  Layout,
  Home,
  Category,
  Book,
  Toc,
  Chapter,
  Search,
}

export default theme
