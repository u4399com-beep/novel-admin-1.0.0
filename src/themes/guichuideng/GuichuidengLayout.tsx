'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Search, Menu, X } from 'lucide-react';

// ─── Navigation categories ──────────────────────────────────────────
const NAV_CATEGORIES = [
  { label: '玄幻奇幻', href: '/categories?slug=xuanhuan' },
  { label: '武侠仙侠', href: '/categories?slug=wuxia' },
  { label: '都市言情', href: '/categories?slug=dushi' },
  { label: '历史军事', href: '/categories?slug=lishi' },
  { label: '科幻灵异', href: '/categories?slug=kehuan' },
  { label: '网游竞技', href: '/categories?slug=youxi' },
  { label: '排行榜', href: '/rankings' },
  { label: '完本小说', href: '/?status=completed' },
];

interface GuichuidengLayoutProps {
  siteName: string;
  children: React.ReactNode;
  searchValue?: string;
  onSearch?: (value: string) => void;
}

export function GuichuidengLayout({
  siteName,
  children,
  searchValue = '',
  onSearch,
}: GuichuidengLayoutProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [localSearch, setLocalSearch] = useState(searchValue);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch?.(localSearch);
  };

  return (
    <div className="min-h-screen flex flex-col bg-white">
      {/* ─── Topbar: dark bar ──────────────────────────────────── */}
      <div className="bg-[#333] text-white/70 text-xs">
        <div className="max-w-[960px] mx-auto px-3 py-1.5 flex items-center justify-end gap-4">
          <button
            onClick={() => {
              try {
                // window.external.addFavorite is a legacy IE-only API not present
                // in the standard lib.dom External interface — widen locally.
                const external = typeof window !== 'undefined'
                  ? (window.external as External & { addFavorite?: (url: string, title: string) => void })
                  : undefined;
                if (external?.addFavorite) {
                  external.addFavorite(window.location.href, siteName);
                } else {
                  alert('请按 Ctrl+D 收藏本站');
                }
              } catch {
                alert('请按 Ctrl+D 收藏本站');
              }
            }}
            className="hover:text-white transition-colors"
          >
            收藏本站
          </button>
        </div>
      </div>

      {/* ─── Header: white bg, logo + search ────────────────────── */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-[960px] mx-auto px-3 py-4 flex items-center justify-between gap-4">
          {/* Logo */}
          <Link href="/" className="shrink-0">
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
              {siteName || '小说阅读网'}
            </h1>
          </Link>

          {/* Search box */}
          <form onSubmit={handleSearch} className="flex items-center gap-0 w-full max-w-sm">
            <input
              type="text"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="搜索书名或作者..."
              className="flex-1 h-9 px-3 text-sm border border-gray-300 rounded-l focus:outline-none focus:border-orange-400 bg-white text-gray-900 placeholder:text-gray-400"
            />
            <button
              type="submit"
              className="h-9 px-4 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded-r transition-colors"
            >
              <Search className="h-4 w-4" />
            </button>
          </form>
        </div>
      </header>

      {/* ─── Navigation: dark bar with category links ───────────── */}
      <nav className="bg-[#3d3d3d] sticky top-0 z-50">
        <div className="max-w-[960px] mx-auto px-3">
          {/* Desktop nav */}
          <ul className="hidden md:flex items-center gap-0">
            {NAV_CATEGORIES.map((cat) => (
              <li key={cat.label}>
                <Link
                  href={cat.href}
                  className="block px-3.5 py-2.5 text-sm text-white/90 hover:text-white hover:bg-white/10 transition-colors"
                >
                  {cat.label}
                </Link>
              </li>
            ))}
          </ul>

          {/* Mobile nav toggle */}
          <div className="flex md:hidden items-center h-10">
            <button
              onClick={() => setMobileNavOpen(!mobileNavOpen)}
              className="flex items-center gap-2 px-2 py-1.5 text-sm text-white/90"
              aria-label="导航菜单"
            >
              {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
              <span>分类导航</span>
            </button>
          </div>
        </div>

        {/* Mobile nav dropdown */}
        {mobileNavOpen && (
          <div className="md:hidden bg-[#3d3d3d] border-t border-white/10">
            <div className="max-w-[960px] mx-auto px-3 py-1">
              {NAV_CATEGORIES.map((cat) => (
                <Link
                  key={cat.label}
                  href={cat.href}
                  onClick={() => setMobileNavOpen(false)}
                  className="block px-3 py-2.5 text-sm text-white/90 hover:text-white hover:bg-white/10 rounded transition-colors"
                >
                  {cat.label}
                </Link>
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* ─── Main content ───────────────────────────────────────── */}
      <main className="flex-1">
        <div className="max-w-[960px] mx-auto px-3 py-5">
          {children}
        </div>
      </main>

      {/* ─── Footer ─────────────────────────────────────────────── */}
      <footer className="bg-[#333] text-white/50 text-xs mt-auto">
        <div className="max-w-[960px] mx-auto px-3 py-5 text-center space-y-1.5">
          <p>本站所有小说均为转载作品，所有章节均由网友上传发布。</p>
          <p>转载小说至本站只是为了宣传本书让更多读者欣赏。</p>
          <p>Copyright © {new Date().getFullYear()} {siteName || '小说阅读网'} All Rights Reserved.</p>
        </div>
      </footer>
    </div>
  );
}
