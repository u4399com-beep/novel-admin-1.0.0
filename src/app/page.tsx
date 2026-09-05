'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import {
  BookOpen, Sun, Moon, Shield, Menu, Trophy, Compass,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { HomeActivity } from '@/components/home/HomeActivity';
import { RecentlyUpdatedNovels } from '@/components/home/RecentlyUpdatedNovels';
import { LayoutSwitcher } from '@/components/home/LayoutSwitcher';
import { HeroSection } from '@/components/home/HeroSection';
import { ReadingStreakBanner } from '@/components/home/ReadingStreakBanner';
import { NovelGridLoader } from '@/components/home/NovelGridLoader';
import type { Category } from '@/components/home/HeroSection';
import { FriendlyLinksFooter } from '@/components/footer/FriendlyLinksFooter';
import { useSiteName } from '@/lib/use-site-name';
import { useLayoutTheme } from '@/lib/use-layout-theme';
import { apiFetch, FetchError } from '@/lib/api-fetch';


// ─── Scroll Progress Bar ────────────────────────────────────────────────

function ScrollProgressBar() {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    function onScroll() {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(docHeight > 0 ? Math.min((scrollTop / docHeight) * 100, 100) : 0);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div className="fixed top-0 left-0 right-0 z-[60] h-[2px] bg-transparent pointer-events-none" aria-hidden="true">
      <div
        className="h-full bg-gradient-to-r from-primary via-primary/80 to-primary/50 transition-[width] duration-150 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'ongoing', label: '连载中' },
  { value: 'completed', label: '已完结' },
];

const WORD_COUNT_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'under_30w', label: '30万字以下' },
  { value: '30w_50w', label: '30-50万字' },
  { value: '50w_100w', label: '50-100万字' },
  { value: '100w_200w', label: '100-200万字' },
  { value: '200w_400w', label: '200-400万字' },
  { value: 'over_400w', label: '400万字以上' },
];

// ─── Main Page ───────────────────────────────────────────────────────

export default function HomePage() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { theme: layoutTheme } = useLayoutTheme();
  const [mounted, setMounted] = useState(false);
  const siteName = useSiteName();
  useEffect(() => { setMounted(true); }, []);


  // Data state
  const [categories, setCategories] = useState<Category[]>([]);
  // Filter state
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState('');
  const [activeCategorySlug, setActiveCategorySlug] = useState('');
  const [activeStatus, setActiveStatus] = useState('');
  const [activeWordCount, setActiveWordCount] = useState('all');
  const [activeSort, setActiveSort] = useState('last_update');

  // Loading state
  const [loadingCategories, setLoadingCategories] = useState(true);

  // Mobile menu state
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // ─── Search debounce ───────────────────────────────────────────
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // ─── Fetch categories ────────────────────────────────────────────
  useEffect(() => {
    const abortController = new AbortController();
    async function load() {
      try {
        const data = await apiFetch<Category[]>('/api/public/categories', { signal: abortController.signal, silent: true });
        setCategories(data);
      } catch (err) {
        // Categories are non-critical; the UI shows no category buttons on failure
        if (!(err instanceof FetchError && err.status === 0)) {
          console.warn('[HomePage] Failed to load categories');
        }
      } finally {
        if (!abortController.signal.aborted) setLoadingCategories(false);
      }
    }
    load();
    return () => abortController.abort();
  }, []);

  // Novel data is now fetched by NovelGridLoader (child component)

  // ─── Handlers ────────────────────────────────────────────────────
  const handleNovelSearch = (term: string) => {
    setSearch(term);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(term);
      setPage(1);
    }, 300);
  };

  const handleCategoryChange = (slug: string) => {
    setActiveCategorySlug(slug === activeCategorySlug ? '' : slug);
    setPage(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleStatusChange = (status: string) => {
    setActiveStatus(status === activeStatus ? '' : status);
    setPage(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleWordCountChange = (wc: string) => {
    setActiveWordCount(wc === activeWordCount ? 'all' : wc);
    setPage(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSortChange = (sort: string) => {
    setActiveSort(sort);
    setPage(1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const resetAllFilters = () => {
    setActiveCategorySlug('');
    setActiveStatus('');
    setActiveWordCount('all');
    setActiveSort('last_update');
    setDebouncedSearch('');
    setSearch('');
    setPage(1);
  };

  const handlePageChange = (p: number) => {
    setPage(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleRetry = () => {
    setRefreshKey((k) => k + 1);
  };

  // ─── Check if any filter is active ──────────────────────────────
  const hasActiveFilter = !!(activeCategorySlug || activeStatus || (activeWordCount !== 'all') || (activeSort !== 'last_update') || debouncedSearch);

  // ─── Build filter summary (memoized) ────────────────────────────────
  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (debouncedSearch) parts.push(`搜索: ${debouncedSearch}`);
    if (activeCategorySlug) {
      const cat = categories.find((c) => c.slug === activeCategorySlug);
      if (cat) parts.push(`分类: ${cat.name}`);
    }
    if (activeStatus) {
      const opt = STATUS_OPTIONS.find((o) => o.value === activeStatus);
      if (opt) parts.push(`状态: ${opt.label}`);
    }
    if (activeWordCount !== 'all') {
      const opt = WORD_COUNT_OPTIONS.find((o) => o.value === activeWordCount);
      if (opt) parts.push(`字数: ${opt.label}`);
    }
    return parts.length > 0 ? parts.join(' | ') : '全部小说';
  }, [debouncedSearch, activeCategorySlug, categories, activeStatus, activeWordCount]);

  return (
    <div className="min-h-screen flex flex-col">
      <ScrollProgressBar />
      {/* ─── Header ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto flex items-center justify-between h-14 px-4 sm:px-6">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
              <BookOpen className="h-[1.125rem] w-[1.125rem] text-primary-foreground" />
            </div>
            <span className="text-lg font-bold tracking-tight">{siteName}</span>
          </div>

          {/* Nav links - desktop */}
          <nav className="hidden sm:flex items-center gap-6 text-sm">
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="text-muted-foreground hover:text-foreground transition-colors animated-underline"
            >
              首页
            </button>
            <Link
              href="/categories"
              className="text-muted-foreground hover:text-foreground transition-colors animated-underline"
            >
              分类
            </Link>
            <Link
              href="/rankings"
              className="text-muted-foreground hover:text-foreground transition-colors animated-underline"
            >
              排行榜
            </Link>
            <Link
              href="/stats"
              className="text-muted-foreground hover:text-foreground transition-colors animated-underline"
            >
              统计
            </Link>
          </nav>

          {/* Right actions */}
          <div className="flex items-center gap-2">
            {/* Hamburger menu - mobile only */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 sm:hidden"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="打开菜单"
            >
              <Menu className="h-[1.125rem] w-[1.125rem]" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切换主题"
              className="h-8 w-8 hidden sm:inline-flex"
              {...(!mounted && { tabIndex: -1, 'aria-disabled': true, style: { visibility: 'hidden' } })}
            >
              <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
              <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            </Button>
            <LayoutSwitcher />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/login')}
              className="gap-1.5 text-muted-foreground hover:text-foreground h-8 hidden sm:inline-flex"
            >
              <Shield className="h-3.5 w-3.5" />
              <span>管理后台</span>
            </Button>
          </div>

          {/* Mobile Menu Sheet - proper a11y with focus trap + Escape */}
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetContent side="right" className="w-72 p-0">
              <SheetHeader className="border-b px-4 py-3">
                <SheetTitle className="text-left">菜单</SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col p-4 gap-1">
                <button
                  onClick={() => {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    setMobileMenuOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition-colors text-left"
                >
                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                  首页
                </button>
                <button
                  onClick={() => {
                    router.push('/categories');
                    setMobileMenuOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition-colors text-left"
                >
                  <Compass className="h-4 w-4 text-muted-foreground" />
                  分类
                </button>
                <button
                  onClick={() => {
                    router.push('/rankings');
                    setMobileMenuOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition-colors text-left"
                >
                  <Trophy className="h-4 w-4 text-muted-foreground" />
                  排行榜
                </button>
                <button
                  onClick={() => {
                    router.push('/stats');
                    setMobileMenuOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition-colors text-left"
                >
                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                  阅读统计
                </button>
              </nav>
              <div className="border-t mx-4" />
              <div className="flex flex-col gap-1 p-4">
                <button
                  onClick={() => {
                    setTheme(theme === 'dark' ? 'light' : 'dark');
                    setMobileMenuOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition-colors text-left"
                >
                  <Sun className="h-4 w-4 text-muted-foreground dark:hidden" />
                  <Moon className="h-4 w-4 text-muted-foreground hidden dark:block" />
                  {mounted && (theme === 'dark' ? '浅色模式' : '深色模式')}
                </button>
                <button
                  onClick={() => {
                    router.push('/login');
                    setMobileMenuOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition-colors text-left"
                >
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  管理后台
                </button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>

      {/* ─── Hero Section: Search + Filters ─────────────────────── */}
      <HeroSection
        search={search}
        onSearch={handleNovelSearch}
        categories={categories}
        loadingCategories={loadingCategories}
        loadingNovels={false}
        activeCategorySlug={activeCategorySlug}
        activeStatus={activeStatus}
        activeWordCount={activeWordCount}
        activeSort={activeSort}
        onCategoryChange={handleCategoryChange}
        onStatusChange={handleStatusChange}
        onWordCountChange={handleWordCountChange}
        onSortChange={handleSortChange}
        hasActiveFilter={hasActiveFilter}
        resetAllFilters={resetAllFilters}
        total={0}
        filterSummary={filterSummary}
      />

      {/* Reading Streak Banner */}
      <ReadingStreakBanner />

      {/* Recently Updated Novels */}
      <RecentlyUpdatedNovels />

      {/* Continue Reading & Recently Viewed & Today Insight */}
      <HomeActivity />

      {/* ─── Novels Section ─────────────────────────────────────── */}
      <div className="stagger-children">
      <NovelGridLoader
        layoutTheme={layoutTheme}
        activeCategorySlug={activeCategorySlug}
        activeStatus={activeStatus}
        activeWordCount={activeWordCount}
        activeSort={activeSort}
        debouncedSearch={debouncedSearch}
        page={page}
        refreshKey={refreshKey}
        search={search}
        hasActiveFilter={hasActiveFilter}
        filterSummary={filterSummary}
        onPageChange={handlePageChange}
        onRetry={handleRetry}
        onLoginClick={() => router.push('/login')}
      />
      </div>

      {/* ─── Footer ──────────────────────────────────────────────── */}
      <footer className="mt-auto bg-background/80 backdrop-blur-sm">
        <div className="h-px bg-gradient-to-r from-transparent via-border to-transparent" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
          <div className="flex flex-col items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <BookOpen className="h-4 w-4 text-primary/70" />
              </div>
              <span className="font-semibold text-foreground/80">{siteName}</span>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <Link href="/categories" className="text-muted-foreground/60 hover:text-primary hover:underline underline-offset-2 transition-colors">分类</Link>
              <span className="text-muted-foreground/20">·</span>
              <Link href="/rankings" className="text-muted-foreground/60 hover:text-primary hover:underline underline-offset-2 transition-colors">排行榜</Link>
              <span className="text-muted-foreground/20">·</span>
              <Link href="/stats" className="text-muted-foreground/60 hover:text-primary hover:underline underline-offset-2 transition-colors">统计</Link>
              <span className="text-muted-foreground/20">·</span>
              <Link href="/login" className="text-muted-foreground/60 hover:text-primary hover:underline underline-offset-2 transition-colors">管理</Link>
              <span className="text-muted-foreground/20">·</span>
              <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="text-muted-foreground/60 hover:text-primary hover:underline underline-offset-2 transition-colors">回到顶部</button>
            </div>
            {/* Friendly Links & Link Wheel */}
            <FriendlyLinksFooter />
            <p className="text-[11px] text-muted-foreground/40">
              © {new Date().getFullYear()} {siteName} · 基于 Next.js 16 + Prisma + Tailwind CSS 构建
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
