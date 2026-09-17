'use client'

import { useState } from 'react'
import { Search as SearchIcon } from 'lucide-react'
import { useCategories, useSettings } from '@/hooks/use-novel-data'
import type { CategoryDto } from '@/lib/types'
import type { Nav } from './parts'
import { XLink } from './parts'
import type { ThemeLayoutProps } from '../types'

const FONT = '"Microsoft Yahei", "SimSun", "PingFang SC", "Hiragino Sans GB", sans-serif'

/* ---------- 完整页头 .m_head：左 Logo 180 + 右工具行/搜索组 ---------- */

function FullHeader({ navigate, siteName }: { navigate: Nav; siteName: string }) {
  const [kw, setKw] = useState('')
  const submit = () => {
    const q = kw.trim()
    if (q) navigate({ name: 'search', query: q })
  }

  return (
    <header className="mx-auto flex h-[60px] w-full max-w-[960px] items-center">
      <button
        onClick={() => navigate({ name: 'home' })}
        className="w-[180px] shrink-0 cursor-pointer text-left leading-tight"
      >
        <span className="block text-[20px] font-bold text-[#2F468F]">{siteName}</span>
        <span className="block text-[11px] text-[#FF6600]">x2552.com · 杰奇经典模板</span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col items-end gap-[6px]">
        <div className="flex flex-wrap items-center justify-end gap-2 text-[12px] text-[#999]">
          <span className="cursor-pointer hover:text-[#FF6600]" title="演示模板：语言切换未实现">
            简体中文
          </span>
          <span className="text-[#DDD]">|</span>
          <span className="cursor-pointer hover:text-[#FF6600]" title="演示模板：语言切换未实现">
            繁體版
          </span>
          <span className="text-[#DDD]">|</span>
          <span className="cursor-pointer hover:text-[#FF6600]" title="演示模板">加入收藏</span>
          <span className="text-[#DDD]">|</span>
          <span className="cursor-pointer hover:text-[#FF6600]" title="演示模板">联系我们</span>
        </div>
        <div className="hidden items-center gap-1 min-[720px]:flex">
          <SearchIcon size={13} className="text-[#999]" />
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="输入书名或作者"
            className="h-[28px] w-[260px] max-w-full border border-[#CCCCCC] px-1 text-[12px] text-[#333] outline-none placeholder:text-[#BBB] focus:border-[#FF6600]"
          />
          <button
            onClick={submit}
            className="h-[30px] w-[70px] cursor-pointer border border-[#E88B00] bg-gradient-to-b from-[#FFB34D] to-[#FF6F08] text-[12px] font-bold text-white transition hover:brightness-105"
          >
            搜书名
          </button>
          <button
            onClick={submit}
            className="h-[30px] w-[70px] cursor-pointer border border-[#0578BB] bg-gradient-to-b from-[#73B7EE] to-[#0578BB] text-[12px] font-bold text-white transition hover:brightness-105"
          >
            搜作者
          </button>
          <span className="ml-2 text-[12px]">
            <span className="cursor-pointer text-[#2F468F] hover:text-[#FF6600]" title="演示模板：登录未实现">
              登录
            </span>
            <span className="mx-1 text-[#DDD]">|</span>
            <span className="cursor-pointer text-[#2F468F] hover:text-[#FF6600]" title="演示模板：注册未实现">
              注册
            </span>
          </span>
        </div>
      </div>
    </header>
  )
}

/* ---------- 主导航 .m_menu：浅灰渐变 40px，右绝对定位书架按钮 ---------- */

function NavBar({ navigate, categories }: { navigate: Nav; categories: CategoryDto[] }) {
  return (
    <nav className="no-scrollbar relative mx-auto flex h-[40px] w-full max-w-[960px] items-center overflow-x-auto border border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] pr-[110px]">
      <XLink onClick={() => navigate({ name: 'home' })} className="px-3 text-[14px] font-bold">
        首页
      </XLink>
      {categories.slice(0, 10).map((c) => (
        <XLink key={c.id} onClick={() => navigate({ name: 'category', categoryId: c.id })} className="px-3 text-[14px] font-bold">
          {c.name}
        </XLink>
      ))}
      <XLink onClick={() => navigate({ name: 'category' })} title="进入全部分类" className="px-3 text-[14px] font-bold">
        全本
      </XLink>
      <button
        title="演示模板：书架未实现"
        className="absolute right-2 top-[5px] h-[30px] w-[100px] cursor-pointer bg-[#666666] text-[12px] font-bold text-white transition-colors hover:bg-[#FF6600]"
      >
        我的书架
      </button>
    </nav>
  )
}

/* ---------- 目录/正文页专用紧凑顶栏 #a_head：30px 高渐变条 + 小搜索框 ---------- */

function CompactHeader({ navigate, categories }: { navigate: Nav; categories: CategoryDto[] }) {
  const [kw, setKw] = useState('')
  const submit = () => {
    const q = kw.trim()
    if (q) navigate({ name: 'search', query: q })
  }

  return (
    <div className="no-scrollbar mx-auto flex h-[30px] w-full max-w-[960px] items-center gap-1 overflow-x-auto border border-[#E4E4E4] bg-gradient-to-b from-[#FDFDFD] to-[#E4E4E4] px-1 text-[12px]">
      <XLink onClick={() => navigate({ name: 'home' })} className="px-1.5 text-[#666666]">
        首页
      </XLink>
      {categories.slice(0, 10).map((c) => (
        <XLink
          key={c.id}
          onClick={() => navigate({ name: 'category', categoryId: c.id })}
          className="px-1.5 text-[#666666]"
        >
          {c.name}
        </XLink>
      ))}
      <XLink onClick={() => navigate({ name: 'category' })} title="进入全部分类" className="px-1.5 text-[#666666]">
        全本
      </XLink>
      <span className="ml-auto flex items-center gap-1">
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="搜书名/作者"
          className="h-[20px] w-[120px] border border-[#CCCCCC] px-1 text-[12px] text-[#333] outline-none placeholder:text-[#BBB] focus:border-[#FF6600]"
        />
        <button
          onClick={submit}
          className="h-[20px] cursor-pointer border border-[#CCCCCC] bg-white px-1.5 text-[12px] text-[#666] transition-colors hover:border-[#FF6600] hover:text-[#FF6600]"
        >
          搜索
        </button>
      </span>
    </div>
  )
}

/* ---------- 页脚：频道页 .footer（浅蓝顶条 + 白渐变） / 书页 #a_footer（顶线 + 网站地图） ---------- */

function SiteFooter({ siteName }: { siteName: string }) {
  const { data: settings } = useSettings()
  const cfg = settings?.footer
  return (
    <footer className="mx-auto mt-2 w-full max-w-[960px]">
      <div className="h-[2px] border-b border-[#33CCFF] bg-[#D9EDFF]" />
      <div className="bg-gradient-to-b from-white to-[#EDEDED] py-3 text-center text-[12px] leading-[20px] text-[#666666]">
        <p>{cfg?.text || `${siteName}（x2552.com）—— 杰奇 CMS 经典结构主题演示`}</p>
        <p>{cfg?.extra || '本页面为前端结构级主题模板演示，所有数据均来自本地演示库'}</p>
        {(cfg?.links?.length ?? 0) > 0 && (
          <p>
            {cfg?.links?.map((lk) => (
              <a
                key={`${lk.label}-${lk.href}`}
                href={lk.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mx-1 text-[#666666] hover:text-[#FF6600] hover:underline"
              >
                [{lk.label}]
              </a>
            ))}
          </p>
        )}
      </div>
    </footer>
  )
}

function AFooter({ navigate, siteName }: { navigate: Nav; siteName: string }) {
  const { data: settings } = useSettings()
  const cfg = settings?.footer
  return (
    <footer className="mx-auto mt-3 w-full max-w-[960px] border-t border-[#E4E4E4] py-3 text-center text-[12px] text-[#666666]">
      <p>
        网站地图：
        {Array.from({ length: 10 }).map((_, i) => (
          <XLink key={i} onClick={() => navigate({ name: 'category', page: i + 1 })} className="mx-0.5">
            [{i + 1}]
          </XLink>
        ))}
        {(cfg?.links ?? []).map((lk) => (
          <a
            key={`${lk.label}-${lk.href}`}
            href={lk.href}
            target="_blank"
            rel="noopener noreferrer"
            className="mx-0.5 hover:text-[#FF6600] hover:underline"
          >
            [{lk.label}]
          </a>
        ))}
      </p>
      <p className="mt-1">{cfg?.text || `© ${siteName}（x2552.com）· 目录/正文页精简页脚`}</p>
    </footer>
  )
}

/**
 * 全站框架：
 * 首页/分类/详情/搜索 = 完整页头 + 导航 + 公告条 + .footer
 * 目录/正文 = #a_head 紧凑顶栏 + #a_footer（正文页 body 淡蓝 #E6F3FF）
 * 定宽 960px（min-w 760 保证移动端横向滚动）
 */
export default function Layout({ view, children, navigate, siteName, notice }: ThemeLayoutProps) {
  const { data: categories } = useCategories()
  const compact = view.name === 'toc' || view.name === 'chapter'

  return (
    <div
      className={
        view.name === 'chapter'
          ? 'flex min-h-screen min-w-0 flex-col bg-[#E6F3FF]'
          : 'flex min-h-screen min-w-0 flex-col bg-white'
      }
      style={{ fontFamily: FONT, fontSize: 12, lineHeight: 1.5, color: '#666666' }}
    >
      {compact ? (
        <div className="pt-2">
          <CompactHeader navigate={navigate} categories={categories ?? []} />
        </div>
      ) : (
        <>
          <FullHeader navigate={navigate} siteName={siteName} />
          <NavBar navigate={navigate} categories={categories ?? []} />
          {notice && (
            <div className="mx-auto w-full max-w-[960px]">
              <div className="mt-2 border border-[#E4E4E4] bg-white px-2 text-[12px] leading-[25px] text-[#FF3300]">
                公告：{notice}
              </div>
            </div>
          )}
        </>
      )}

      <div className="mx-auto w-full max-w-[960px] min-w-0 flex-1">{children}</div>

      {compact ? (
        <AFooter navigate={navigate} siteName={siteName} />
      ) : (
        <SiteFooter siteName={siteName} />
      )}
    </div>
  )
}
