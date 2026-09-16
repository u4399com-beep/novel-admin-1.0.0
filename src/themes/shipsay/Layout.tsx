'use client'

import { useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronUp,
  CircleCheckBig,
  Compass,
  Footprints,
  Home as HomeIcon,
  Search,
} from 'lucide-react'
import { useCategories } from '@/hooks/use-novel-data'
import type { ThemeLayoutProps } from '../types'

const FONT = '"Microsoft Yahei", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", Arial, sans-serif'

function QuickEntry({
  icon,
  label,
  onClick,
  title,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  title?: string
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex cursor-pointer flex-col items-center gap-1 text-[#555] transition-colors hover:text-[#BF2C24]"
    >
      {icon}
      <span className="text-[12px] leading-none">{label}</span>
    </button>
  )
}

/* 右侧边缘固定“回顶部 / 回底部”箭头：灰色，hover 主题红 */
function ScrollButtons() {
  return (
    <div className="fixed right-3 top-1/2 z-40 hidden -translate-y-1/2 flex-col border border-[#E6E6E6] bg-white shadow-sm min-[960px]:flex">
      <button
        title="回顶部"
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className="cursor-pointer p-2 text-[#999] transition-colors hover:text-[#BF2C24]"
      >
        <ChevronUp size={16} />
      </button>
      <button
        title="回底部"
        onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })}
        className="cursor-pointer border-t border-[#E6E6E6] p-2 text-[#999] transition-colors hover:text-[#BF2C24]"
      >
        <ChevronDown size={16} />
      </button>
    </div>
  )
}

/**
 * 全站框架：白/透明页头（文字 Logo + 搜索框 + 快捷入口）
 * + 深灰 #3E3D43 导航条 + 内容区 + 深灰页脚
 */
export default function Layout({ children, navigate, siteName }: ThemeLayoutProps) {
  const { data: categories } = useCategories()
  const [kw, setKw] = useState('')

  const submitSearch = () => {
    const q = kw.trim()
    if (q) navigate({ name: 'search', query: q })
  }

  const navLink =
    'flex h-full cursor-pointer items-center whitespace-nowrap border-t-2 border-transparent px-5 text-[14px] text-[#FBFBFB] transition-colors hover:border-[#ED4259] hover:bg-[#252428]'

  return (
    <div className="min-h-screen bg-[#F4F4F4] text-[#333]" style={{ fontFamily: FONT }}>
      {/* 页头 */}
      <header className="mx-auto w-full max-w-[960px] px-2">
        <div className="flex items-center gap-4 py-4">
          <button
            onClick={() => navigate({ name: 'home' })}
            className="shrink-0 cursor-pointer text-left leading-tight max-[639px]:hidden"
          >
            <span className="block text-[22px] font-bold text-[#3E3D43]">{siteName}</span>
            <span className="block text-[12px] text-[#BF2C24]">demo.shipsay.com · 红白灰主题</span>
          </button>
          <div className="flex min-w-0 flex-1 justify-center">
            <div className="flex w-full max-w-[344px]">
              <input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitSearch()}
                placeholder="输入书名 / 作者，回车搜索"
                className="h-[36px] min-w-0 flex-1 rounded-l-[3px] border border-r-0 border-[#E6E6E6] bg-white px-3 text-[13px] text-[#333] outline-none placeholder:text-[#C0C4CC] focus:border-[#BF2C24]"
              />
              <button
                onClick={submitSearch}
                title="搜索"
                className="flex h-[36px] w-[44px] cursor-pointer items-center justify-center rounded-r-[3px] bg-[#BF2C24] text-white transition-colors hover:bg-[#ED4259]"
              >
                <Search size={16} />
              </button>
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-4">
            <QuickEntry icon={<HomeIcon size={18} />} label="首页" onClick={() => navigate({ name: 'home' })} />
            <QuickEntry
              icon={<Compass size={18} />}
              label="书库"
              onClick={() => navigate({ name: 'category' })}
            />
            <QuickEntry
              icon={<CircleCheckBig size={18} />}
              label="完本"
              title="进入书库后勾选「只看全本」"
              onClick={() => navigate({ name: 'category' })}
            />
            <QuickEntry
              icon={<Footprints size={18} />}
              label="足迹"
              title="演示模板：阅读足迹未实现"
              onClick={() => undefined}
            />
          </div>
        </div>
      </header>

      {/* 主导航条：深灰 41px，hover 上边框高亮红 */}
      <nav className="h-[41px] bg-[#3E3D43] max-[767px]:hidden">
        <div className="mx-auto flex h-full max-w-[960px] items-stretch overflow-x-auto px-2">
          <button onClick={() => navigate({ name: 'home' })} className={navLink}>
            首页
          </button>
          {(categories ?? []).slice(0, 8).map((c) => (
            <button key={c.id} onClick={() => navigate({ name: 'category', categoryId: c.id })} className={navLink}>
              {c.name}
            </button>
          ))}
          <button onClick={() => navigate({ name: 'category' })} className={navLink}>
            全部分类
          </button>
          <span className="ml-auto flex items-center gap-2 pl-4 text-[13px] text-[#FBFBFB]/60">
            <span className="cursor-pointer transition-colors hover:text-[#ED4259]" title="演示模板：登录未实现">
              登录
            </span>
            <span className="text-[#FBFBFB]/30">|</span>
            <span className="cursor-pointer transition-colors hover:text-[#ED4259]" title="演示模板：注册未实现">
              注册
            </span>
          </span>
        </div>
      </nav>

      <main>{children}</main>

      {/* 页脚：深灰两行 */}
      <footer className="bg-[#3E3D43] text-[#FBFBFB]">
        <div className="mx-auto w-full max-w-[960px] px-2 py-5 text-center text-[12px] leading-[22px]">
          <p>{siteName} · 找书读书一站直达，每日更新不断档</p>
          <p className="mt-1">
            <span className="font-medium">简体版</span>
            <span className="mx-2 text-[#FBFBFB]/40">·</span>
            <span
              className="cursor-pointer text-[#FBFBFB]/60 transition-colors hover:text-[#ED4259]"
              title="演示模板：繁体切换未实现"
            >
              繁體版
            </span>
            <span className="ml-3 text-[#FBFBFB]/40">© demo.shipsay.com</span>
          </p>
        </div>
      </footer>

      <ScrollButtons />
    </div>
  )
}
