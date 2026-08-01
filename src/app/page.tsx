'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen, Search, Sun, Moon, Shield,
  ChevronLeft, ChevronRight, RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Types ───────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  description: string | null;
  color: string;
  _count: { novels: number };
}

interface Novel {
  id: string;
  title: string;
  author: string;
  description: string | null;
  coverUrl: string | null;
  coverPath: string | null;
  status: string;
  wordCount: number;
  category: { id: string; name: string; slug: string; color: string; icon: string | null } | null;
  _count: { chapters: number };
  createdAt: string;
  updatedAt: string;
}

// ─── 23qb.net Filter Config ──────────────────────────────────────────

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
  { value: '200w_300w', label: '200-300万字' },
  { value: 'over_400w', label: '400万字以上' },
];

const SORT_OPTIONS = [
  { value: 'last_update', label: '最近更新' },
  { value: 'new_entry', label: '新书入库' },
  { value: 'new_hot', label: '新书热门' },
  { value: 'weekly_click', label: '周点击榜' },
  { value: 'monthly_click', label: '月点击榜' },
  { value: 'weekly_rec', label: '周推荐榜' },
  { value: 'monthly_rec', label: '月推荐榜' },
  { value: 'favorites', label: '收藏榜' },
];

const STATUS_MAP: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  ongoing: { label: '连载中', variant: 'default' },
  completed: { label: '已完结', variant: 'secondary' },
  hiatus: { label: '暂停中', variant: 'outline' },
};

function formatWordCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万字`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}千字`;
  return `${n}字`;
}

// ─── Cover placeholder gradient colors ────────────────────────────────
const COVER_GRADIENTS = [
  'from-rose-500/80 to-orange-500/80',
  'from-emerald-500/80 to-teal-500/80',
  'from-violet-500/80 to-purple-500/80',
  'from-amber-500/80 to-yellow-500/80',
  'from-cyan-500/80 to-sky-500/80',
  'from-fuchsia-500/80 to-pink-500/80',
  'from-lime-500/80 to-green-500/80',
  'from-red-500/80 to-rose-500/80',
];

function getGradient(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
  return COVER_GRADIENTS[Math.abs(hash) % COVER_GRADIENTS.length];
}

// ─── Skeleton Grid ───────────────────────────────────────────────────

function NovelCardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="aspect-[3/4] w-full rounded-xl" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6">
      {Array.from({ length: 10 }).map((_, i) => (
        <NovelCardSkeleton key={i} />
      ))}
    </div>
  );
}

// ─── Filter Row Skeleton ─────────────────────────────────────────────

function FilterRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-2">
      <Skeleton className="h-4 w-12 shrink-0" />
      <div className="flex items-center gap-2 overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-16 shrink-0 rounded-full" />
        ))}
      </div>
    </div>
  );
}

// ─── Novel Card ──────────────────────────────────────────────────────

function NovelCard({ novel, index }: { novel: Novel; index: number }) {
  const statusInfo = STATUS_MAP[novel.status] || STATUS_MAP.ongoing;
  const gradient = getGradient(novel.title);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3, delay: index * 0.04 }}
      className="group cursor-pointer"
    >
      {/* Cover */}
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl shadow-md group-hover:shadow-xl transition-all duration-300 group-hover:-translate-y-1">
        {novel.coverUrl ? (
          <img
            src={novel.coverUrl}
            alt={novel.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center`}>
            <span className="text-4xl font-bold text-white/90 select-none">
              {novel.title.charAt(0)}
            </span>
          </div>
        )}
        {/* Status badge overlay */}
        <div className="absolute top-2 left-2">
          <Badge variant={statusInfo.variant} className="text-[10px] px-1.5 py-0">
            {statusInfo.label}
          </Badge>
        </div>
        {/* Chapter count overlay */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3 pt-8">
          <p className="text-[11px] text-white/80 flex items-center gap-1">
            <BookOpen className="h-3 w-3" />
            {novel._count.chapters} 章 · {formatWordCount(novel.wordCount)}
          </p>
        </div>
      </div>

      {/* Info */}
      <div className="mt-3 space-y-1.5 px-0.5">
        <h3 className="text-sm font-semibold leading-snug line-clamp-1 group-hover:text-primary transition-colors">
          {novel.title}
        </h3>
        <p className="text-xs text-muted-foreground line-clamp-1">{novel.author}</p>
        {novel.category && (
          <span
            className="inline-block text-[10px] px-1.5 py-0.5 rounded-full"
            style={{
              backgroundColor: `${novel.category.color}18`,
              color: novel.category.color,
            }}
          >
            {novel.category.name}
          </span>
        )}
      </div>
    </motion.div>
  );
}

// ─── Filter Row Component ────────────────────────────────────────────

function FilterRow<T extends string>({
  label,
  options,
  value,
  onChange,
  loading,
}: {
  label: string;
  options: { value: T; label: string; icon?: string }[];
  value: T;
  onChange: (v: T) => void;
  loading?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);

  const checkArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeftArrow(el.scrollLeft > 4);
    setShowRightArrow(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    checkArrows();
    const el = scrollRef.current;
    if (el) {
      el.addEventListener('scroll', checkArrows, { passive: true });
      // Also check on resize
      const ro = new ResizeObserver(checkArrows);
      ro.observe(el);
      return () => {
        el.removeEventListener('scroll', checkArrows);
        ro.disconnect();
      };
    }
  }, [checkArrows, options]);

  const scroll = (dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -200 : 200, behavior: 'smooth' });
  };

  if (loading) {
    return <FilterRowSkeleton />;
  }

  return (
    <div className="relative flex items-center gap-3 py-2">
      {/* Label */}
      <span className="shrink-0 text-sm font-medium text-muted-foreground w-12 text-right">
        {label}
      </span>

      {/* Scroll container with arrows */}
      <div className="relative flex-1 min-w-0">
        {/* Left arrow */}
        {showLeftArrow && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-background border shadow-sm hover:bg-accent transition-colors"
            aria-label="向左滚动"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Scrollable options */}
        <div
          ref={scrollRef}
          className="flex items-center gap-2 overflow-x-auto py-1 scrollbar-none"
          style={{
            paddingLeft: showLeftArrow ? '28px' : '4px',
            paddingRight: showRightArrow ? '28px' : '4px',
          }}
        >
          {options.map((opt) => {
            const isActive = opt.value === value;
            return (
              <button
                key={opt.value || '__all__'}
                onClick={() => onChange(opt.value)}
                className={`shrink-0 px-3 py-1 rounded-full text-sm transition-all duration-150 whitespace-nowrap ${
                  isActive
                    ? 'bg-primary text-primary-foreground font-medium shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                }`}
              >
                {opt.icon && <span className="mr-1">{opt.icon}</span>}
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Right arrow */}
        {showRightArrow && (
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-background border shadow-sm hover:bg-accent transition-colors"
            aria-label="向右滚动"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────

export default function HomePage() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  // Data state
  const [novels, setNovels] = useState<Novel[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);

  // Filter state
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [activeCategorySlug, setActiveCategorySlug] = useState('');
  const [activeStatus, setActiveStatus] = useState('');
  const [activeWordCount, setActiveWordCount] = useState('all');
  const [activeSort, setActiveSort] = useState('last_update');

  // Loading state
  const [loadingNovels, setLoadingNovels] = useState(true);
  const [loadingCategories, setLoadingCategories] = useState(true);

  // ─── Fetch categories ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingCategories(true);
      try {
        const res = await fetch('/api/public/categories');
        if (!cancelled && res.ok) {
          const data = await res.json();
          setCategories(data);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoadingCategories(false);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ─── Fetch novels ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingNovels(true);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '15' });
        if (activeCategorySlug) params.set('categorySlug', activeCategorySlug);
        if (activeStatus) params.set('status', activeStatus);
        if (activeWordCount && activeWordCount !== 'all') params.set('wordCount', activeWordCount);
        if (activeSort) params.set('sort', activeSort);
        if (search) params.set('search', search);
        const res = await fetch(`/api/public/novels?${params}`);
        if (!cancelled && res.ok) {
          const data = await res.json();
          setNovels(data.novels || []);
          setTotalPages(data.totalPages || 0);
          setTotal(data.total || 0);
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoadingNovels(false);
    }
    load();
    return () => { cancelled = true; };
  }, [page, activeCategorySlug, activeStatus, activeWordCount, activeSort, search]);

  // ─── Handlers ────────────────────────────────────────────────────
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  const handleCategoryChange = (slug: string) => {
    setActiveCategorySlug(slug === activeCategorySlug ? '' : slug);
    setPage(1);
  };

  const handleStatusChange = (status: string) => {
    setActiveStatus(status === activeStatus ? '' : status);
    setPage(1);
  };

  const handleWordCountChange = (wc: string) => {
    setActiveWordCount(wc === activeWordCount ? 'all' : wc);
    setPage(1);
  };

  const handleSortChange = (sort: string) => {
    setActiveSort(sort);
    setPage(1);
  };

  const resetAllFilters = () => {
    setActiveCategorySlug('');
    setActiveStatus('');
    setActiveWordCount('all');
    setActiveSort('last_update');
    setSearch('');
    setSearchInput('');
    setPage(1);
  };

  // ─── Build category options for filter ──────────────────────────
  const categoryOptions = [
    { value: '' as const, label: '全部' },
    ...categories.map((cat) => ({
      value: cat.slug as string & '',
      label: cat.name,
      icon: cat.icon ?? undefined,
    })),
  ];

  // ─── Check if any filter is active ──────────────────────────────
  const hasActiveFilter = activeCategorySlug || activeStatus || (activeWordCount !== 'all') || (activeSort !== 'last_update') || search;

  // ─── Build active filter summary ────────────────────────────────
  const getFilterSummary = () => {
    const parts: string[] = [];
    if (search) parts.push(`搜索: ${search}`);
    if (activeCategorySlug) {
      const cat = categories.find((c) => c.slug === activeCategorySlug);
      if (cat) parts.push(cat.name);
    }
    if (activeStatus) {
      const opt = STATUS_OPTIONS.find((o) => o.value === activeStatus);
      if (opt) parts.push(opt.label);
    }
    if (activeWordCount !== 'all') {
      const opt = WORD_COUNT_OPTIONS.find((o) => o.value === activeWordCount);
      if (opt) parts.push(opt.label);
    }
    return parts.length > 0 ? parts.join(' · ') : '全部小说';
  };

  // ─── Pagination range ────────────────────────────────────────────
  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push('...');
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* ─── Header ──────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto flex items-center justify-between h-14 px-4 sm:px-6">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
              <BookOpen className="h-4.5 w-4.5 text-primary-foreground" />
            </div>
            <span className="text-lg font-bold tracking-tight">小说阁</span>
          </div>

          {/* Nav links - desktop */}
          <nav className="hidden sm:flex items-center gap-6 text-sm">
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              首页
            </button>
            <button
              onClick={() => document.getElementById('filter-section')?.scrollIntoView({ behavior: 'smooth' })}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              分类
            </button>
            <button
              onClick={() => document.getElementById('novels-section')?.scrollIntoView({ behavior: 'smooth' })}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              排行榜
            </button>
          </nav>

          {/* Right actions */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切换主题"
              className="h-8 w-8"
            >
              <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
              <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/login')}
              className="gap-1.5 text-muted-foreground hover:text-foreground h-8"
            >
              <Shield className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">管理后台</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ─── Compact Search Bar ──────────────────────────────────── */}
      <section className="border-b bg-muted/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
          <div className="flex items-center gap-3">
            <h1 className="hidden sm:block text-xl font-bold tracking-tight shrink-0">
              小说搜索
            </h1>
            <form onSubmit={handleSearch} className="relative flex-1 max-w-2xl">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="搜索小说名、作者..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-10 pl-10 pr-20 text-sm rounded-lg"
              />
              <Button
                type="submit"
                size="sm"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-8 px-3 rounded-md"
              >
                搜索
              </Button>
            </form>
            {search && (
              <Badge variant="secondary" className="shrink-0 text-xs">
                &quot;{search}&quot;
                <button
                  onClick={() => { setSearch(''); setSearchInput(''); setPage(1); }}
                  className="ml-1 hover:text-foreground"
                  aria-label="清除搜索"
                >
                  ×
                </button>
              </Badge>
            )}
          </div>
        </div>
      </section>

      {/* ─── 23qb.net 4-Row Filter System ───────────────────────── */}
      <section id="filter-section" className="border-b bg-background">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="divide-y divide-border/50 py-1">
            {/* Row 1: 分类 */}
            <FilterRow
              label="分类"
              options={categoryOptions}
              value={activeCategorySlug}
              onChange={handleCategoryChange}
              loading={loadingCategories}
            />

            {/* Row 2: 状态 */}
            <FilterRow
              label="状态"
              options={STATUS_OPTIONS}
              value={activeStatus}
              onChange={handleStatusChange}
            />

            {/* Row 3: 字数 */}
            <FilterRow
              label="字数"
              options={WORD_COUNT_OPTIONS}
              value={activeWordCount}
              onChange={handleWordCountChange}
            />

            {/* Row 4: 排序 */}
            <FilterRow
              label="排序"
              options={SORT_OPTIONS}
              value={activeSort}
              onChange={handleSortChange}
            />
          </div>

          {/* Reset button when filters active */}
          {hasActiveFilter && (
            <div className="flex items-center justify-end py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={resetAllFilters}
                className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground gap-1"
              >
                <RotateCcw className="h-3 w-3" />
                重置筛选
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* ─── Novels Section ──────────────────────────────────────── */}
      <section id="novels-section" className="flex-1">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
          {/* Section header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{getFilterSummary()}</h2>
              <span className="text-sm text-muted-foreground">
                共 {total} 本
              </span>
            </div>
          </div>

          {/* Novel grid */}
          {loadingNovels ? (
            <SkeletonGrid />
          ) : novels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <BookOpen className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-base font-medium mb-1">暂无小说</h3>
              <p className="text-sm text-muted-foreground">试试其他关键词或筛选条件</p>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={`${activeCategorySlug}-${activeStatus}-${activeWordCount}-${activeSort}-${search}-${page}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6"
              >
                {novels.map((novel, i) => (
                  <NovelCard key={novel.id} novel={novel} index={i} />
                ))}
              </motion.div>
            </AnimatePresence>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 mt-10">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {getPageNumbers().map((p, i) =>
                typeof p === 'string' ? (
                  <span key={`dots-${i}`} className="px-1 text-muted-foreground">
                    ...
                  </span>
                ) : (
                  <Button
                    key={p}
                    variant={p === page ? 'default' : 'outline'}
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </Button>
                ),
              )}
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* ─── Footer ──────────────────────────────────────────────── */}
      <footer className="mt-auto border-t bg-background/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4" />
              <span className="font-medium">小说阁</span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-xs">沉浸式小说阅读体验</span>
            </div>
            <p className="text-xs text-muted-foreground/60">基于 Next.js 16 构建</p>
          </div>
        </div>
      </footer>
    </div>
  );
}