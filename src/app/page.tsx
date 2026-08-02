'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen, Search, Sun, Moon, Shield, User, BookMarked, FileText,
  ChevronLeft, ChevronRight, RotateCcw, History, Trophy, Compass,
  Menu, X, Book, Loader2, Eye,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { BackToTop } from '@/components/BackToTop';
import { formatWordCount } from '@/lib/format';

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

interface TagItem {
  id: string;
  name: string;
  color: string;
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
  tags: { tag: TagItem }[];
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
  { value: '200w_400w', label: '200-400万字' },
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

// ─── Recently Viewed Tracker ───────────────────────────────────────
const RECENT_KEY = 'novel-recently-viewed';
const MAX_RECENT = 12;

interface RecentNovel {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  category: { name: string; color: string } | null;
  viewedAt: number;
}

function getRecentlyViewed(): RecentNovel[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch { return []; }
}

function addToRecentlyViewed(novel: { id: string; title: string; author: string; coverUrl: string | null; category: { name: string; color: string } | null }) {
  if (typeof window === 'undefined') return;
  try {
    const list = getRecentlyViewed().filter((n) => n.id !== novel.id);
    list.unshift({ ...novel, viewedAt: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch { /* ignore */ }
}

function clearRecentlyViewed() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(RECENT_KEY);
}

// ─── Search History ────────────────────────────────────────────
const SEARCH_HISTORY_KEY = 'novel-search-history';
const MAX_SEARCH_HISTORY = 5;

function getSearchHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
  } catch { return []; }
}

function addSearchHistory(term: string) {
  if (typeof window === 'undefined') return;
  try {
    const list = getSearchHistory().filter((t) => t !== term);
    list.unshift(term);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_SEARCH_HISTORY)));
  } catch { /* ignore */ }
}

function clearSearchHistory() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SEARCH_HISTORY_KEY);
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
  const gradient = getGradient(novel.title);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleMouseEnter = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(() => setPopoverOpen(true), 400);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (enterTimer.current) clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setPopoverOpen(false), 200);
  }, []);

  const handlePopoverEnter = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  const handlePopoverLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setPopoverOpen(false), 150);
  }, []);

  // Cleanup timers on unmount to prevent state updates on unmounted component
  useEffect(() => {
    return () => {
      if (enterTimer.current) clearTimeout(enterTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    };
  }, []);

  const statusLabel = novel.status === 'ongoing' ? '连载中' : novel.status === 'completed' ? '已完结' : '暂停中';
  const statusColor = novel.status === 'ongoing'
    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
    : novel.status === 'completed'
      ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
      : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
    <PopoverTrigger asChild>
    <Link href={`/novels/${novel.id}`} className="block" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3, delay: index * 0.04 }}
      className="group cursor-pointer"
    >
      {/* Cover */}
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl shadow-md group-hover:shadow-2xl group-hover:shadow-primary/10 transition-all duration-300 ease-out group-hover:-translate-y-1.5 group-hover:ring-1 group-hover:ring-primary/20">
        {novel.coverUrl ? (
          <img
            src={novel.coverUrl}
            alt={novel.title}
            className="h-full w-full object-cover transition-all duration-500 group-hover:scale-110 group-hover:brightness-75"
            loading="lazy"
          />
        ) : (
          <div className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center transition-all duration-500 group-hover:brightness-110`}>
            <span className="text-4xl font-bold text-white/90 select-none">
              {novel.title.charAt(0)}
            </span>
          </div>
        )}
        {/* Category badge - top left */}
        {novel.category && (
          <div className="absolute top-2 left-2">
            <span
              className="inline-block text-[10px] px-1.5 py-0.5 rounded-full font-medium backdrop-blur-sm"
              style={{
                backgroundColor: `${novel.category.color}cc`,
                color: '#fff',
              }}
            >
              {novel.category.name}
            </span>
          </div>
        )}
        {/* Status dot - top right */}
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              novel.status === 'ongoing'
                ? 'bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.6)]'
                : novel.status === 'completed'
                  ? 'bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]'
                  : 'bg-gray-400'
            }`}
            title={statusLabel}
          />
        </div>
        {/* Hover CTA Overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-all duration-300 opacity-0 group-hover:opacity-100">
          <span className="flex items-center gap-1.5 rounded-full bg-white/90 dark:bg-black/70 px-4 py-2 text-sm font-medium text-foreground backdrop-blur-sm shadow-lg translate-y-3 group-hover:translate-y-0 transition-transform duration-300">
            <Eye className="h-4 w-4" />
            阅读
          </span>
        </div>
        {/* Chapter count overlay */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent p-3 pt-10">
          <p className="text-[11px] text-white/80 flex items-center gap-1">
            <BookOpen className="h-3 w-3" />
            {novel._count.chapters} 章 · {formatWordCount(novel.wordCount)}
          </p>
        </div>
      </div>

      {/* Info */}
      <div className="mt-3 space-y-1 px-0.5">
        <h3 className="text-sm font-semibold leading-snug line-clamp-1 group-hover:text-primary transition-colors duration-200">
          {novel.title}
        </h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="line-clamp-1">{novel.author}</span>
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
          <span>{novel._count.chapters}章</span>
        </div>
      </div>
    </motion.div>
    </Link>
    </PopoverTrigger>
    <PopoverContent
      className="w-72 p-4"
      side="right"
      sideOffset={8}
      align="start"
      onMouseEnter={handlePopoverEnter}
      onMouseLeave={handlePopoverLeave}
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <h4 className="font-bold text-sm leading-snug mb-1 line-clamp-1">{novel.title}</h4>
      <p className="text-xs text-muted-foreground flex items-center gap-1.5 mb-2">
        <User className="h-3 w-3 shrink-0" />
        <span className="line-clamp-1">{novel.author}</span>
      </p>
      {novel.description && (
        <p className="text-xs text-muted-foreground/90 leading-relaxed line-clamp-3 mb-2">{novel.description}</p>
      )}
      {novel.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {novel.tags.map(({ tag }) => (
            <span
              key={tag.id}
              className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium"
              style={{ backgroundColor: `${tag.color}20`, color: tag.color, border: `1px solid ${tag.color}40` }}
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 pt-2 border-t">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <BookMarked className="h-3 w-3" />
          {novel._count.chapters} 章
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <FileText className="h-3 w-3" />
          {formatWordCount(novel.wordCount)}
        </span>
        <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusColor}`}>
          {statusLabel}
        </span>
      </div>
    </PopoverContent>
    </Popover>
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

  // ─── SEO: set document title ──────────────────────────────────────
  useEffect(() => {
    document.title = '小说阁 - 免费小说在线阅读';
  }, []);

  // Data state
  const [novels, setNovels] = useState<Novel[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  // ─── Recently viewed (initialized from localStorage, synced cross-tab) ─
  const [recentNovels, setRecentNovels] = useState<RecentNovel[]>(() => {
    if (typeof window === 'undefined') return [];
    return getRecentlyViewed();
  });

  // Listen for storage changes from other tabs
  useEffect(() => {
    const handler = () => setRecentNovels(getRecentlyViewed());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

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

  // Mobile menu state
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Lock body scroll when mobile drawer is open
  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileMenuOpen]);

  // Search suggestions state
  const [suggestions, setSuggestions] = useState<{ id: string; title: string; author: string; category: { name: string; color: string } | null }[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    return getSearchHistory();
  });
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ─── Fetch categories ────────────────────────────────────────────
  const [categoriesError, setCategoriesError] = useState(false);
  useEffect(() => {
    const abortController = new AbortController();
    async function load() {
      try {
        const res = await fetch('/api/public/categories', { signal: abortController.signal });
        if (res.ok) {
          const data = await res.json();
          setCategories(data);
        } else if (!abortController.signal.aborted) {
          setCategoriesError(true);
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setCategoriesError(true);
        }
      } finally {
        if (!abortController.signal.aborted) setLoadingCategories(false);
      }
    }
    load();
    return () => abortController.abort();
  }, []);

  // ─── Fetch novels ────────────────────────────────────────────────
  const [novelsError, setNovelsError] = useState(false);
  useEffect(() => {
    const abortController = new AbortController();
    async function load() {
      setLoadingNovels(true);
      setNovelsError(false);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '15' });
        if (activeCategorySlug) params.set('categorySlug', activeCategorySlug);
        if (activeStatus) params.set('status', activeStatus);
        if (activeWordCount && activeWordCount !== 'all') params.set('wordCount', activeWordCount);
        if (activeSort) params.set('sort', activeSort);
        if (search) params.set('search', search);
        const res = await fetch(`/api/public/novels?${params}`, { signal: abortController.signal });
        if (res.ok) {
          const data = await res.json();
          setNovels(data.novels || []);
          setTotalPages(data.totalPages || 0);
          setTotal(data.total || 0);
        } else if (!abortController.signal.aborted) {
          setNovelsError(true);
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setNovelsError(true);
        }
      } finally {
        if (!abortController.signal.aborted) setLoadingNovels(false);
      }
    }
    load();
    return () => abortController.abort();
  }, [page, activeCategorySlug, activeStatus, activeWordCount, activeSort, search]);

  // ─── Handlers ────────────────────────────────────────────────────
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchInput.trim();
    if (trimmed) addSearchHistory(trimmed);
    setSearch(trimmed);
    setPage(1);
    setSuggestionsOpen(false);
    setSearchHistory(getSearchHistory());
  };

  const handleHistoryClear = () => {
    clearSearchHistory();
    setSearchHistory([]);
  };

  const handleHistorySelect = (term: string) => {
    setSearchInput(term);
    setSearch(term);
    setPage(1);
    setSuggestionsOpen(false);
    addSearchHistory(term);
    setSearchHistory(getSearchHistory());
  };

  // ─── Search suggestions (debounced) ─────────────────────────
  const query = searchInput.trim();
  const hasQuery = query.length >= 1;

  useEffect(() => {
    if (!hasQuery) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    let abortController: AbortController | undefined;
    debounceRef.current = setTimeout(async () => {
      abortController = new AbortController();
      setSuggestionsLoading(true);
      try {
        const res = await fetch(`/api/public/search-suggestions?q=${encodeURIComponent(query)}`, {
          signal: abortController.signal,
        });
        if (res.ok) {
          const data = await res.json();
          setSuggestions(data.suggestions || []);
          setActiveSuggestion(-1);
          setSuggestionsOpen(true);
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          // Network error — silently ignore for search suggestions
        }
      } finally {
        if (!abortController.signal.aborted) setSuggestionsLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortController?.abort();
    };
  }, [hasQuery, query]);

  // ─── Close suggestions on outside click ─────────────────────
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSuggestionsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ─── Highlight matching part of title ───────────────────────
  function highlightTitle(title: string) {
    if (!query) return title;
    const idx = title.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return title;
    return (
      <>
        {title.slice(0, idx)}
        <span className="font-bold text-primary">{title.slice(idx, idx + query.length)}</span>
        {title.slice(idx + query.length)}
      </>
    );
  }

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
            <Link
              href="/categories"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              分类
            </Link>
            <Link
              href="/rankings"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              排行榜
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
              <Menu className="h-4.5 w-4.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切换主题"
              className="h-8 w-8 hidden sm:inline-flex"
            >
              <Sun className="h-4 w-4 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
              <Moon className="absolute h-4 w-4 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
            </Button>
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

          {/* Mobile Drawer Overlay */}
          <AnimatePresence>
            {mobileMenuOpen && (
              <>
                <motion.div
                  key="drawer-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="fixed inset-0 z-[100] bg-black/50"
                  onClick={() => setMobileMenuOpen(false)}
                />
                <motion.div
                  key="drawer-panel"
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                  className="fixed top-0 right-0 bottom-0 z-[101] w-72 bg-background border-l shadow-2xl"
                >
                  <div className="flex items-center justify-between p-4 border-b">
                    <span className="font-semibold">菜单</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setMobileMenuOpen(false)}
                      aria-label="关闭菜单"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
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
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                        router.push('/rankings');
                        setMobileMenuOpen(false);
                      }}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted transition-colors text-left"
                    >
                      <Trophy className="h-4 w-4 text-muted-foreground" />
                      排行榜
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
                      {theme === 'dark' ? '浅色模式' : '深色模式'}
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
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </header>

      {/* ─── Compact Search Bar ──────────────────────────────────── */}
      <section className="border-b bg-muted/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
          <div className="flex items-center gap-3">
            <h1 className="hidden sm:block text-xl font-bold tracking-tight shrink-0 text-glow-subtle">
              小说搜索
            </h1>
            <div className="flex-1 max-w-full sm:max-w-2xl" ref={searchRef}>
              <form onSubmit={handleSearch} className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground z-10" />
                <Input
                  type="text"
                  placeholder="搜索小说名、作者..."
                  value={searchInput}
                  onChange={(e) => {
                    setSearchInput(e.target.value);
                    if (!e.target.value.trim()) {
                      setSuggestions([]);
                      setSuggestionsOpen(false);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSuggestionsOpen(false);
                      setActiveSuggestion(-1);
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setActiveSuggestion((prev) => Math.min(prev + 1, suggestions.length - 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setActiveSuggestion((prev) => Math.max(prev - 1, -1));
                    } else if (e.key === 'Enter' && activeSuggestion >= 0 && suggestions[activeSuggestion]) {
                      e.preventDefault();
                      router.push(`/novels/${suggestions[activeSuggestion].id}`);
                      setSuggestionsOpen(false);
                      setActiveSuggestion(-1);
                    }
                  }}
                  onFocus={() => {
                    if (query.length >= 1 && suggestions.length > 0) setSuggestionsOpen(true);
                    else if (query.length === 0 && searchHistory.length > 0) setSuggestionsOpen(true);
                  }}
                  className="h-10 pl-10 pr-20 text-sm rounded-lg w-full"
                />
                <Button
                  type="submit"
                  size="sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-8 px-3 rounded-md z-10"
                >
                  搜索
                </Button>
              </form>

              {/* Suggestions Dropdown */}
              <AnimatePresence>
                {suggestionsOpen && (suggestionsLoading || suggestions.length > 0 || (query.length === 0 && searchHistory.length > 0)) && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.15 }}
                    className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border bg-popover shadow-lg overflow-hidden"
                  >
                    {suggestionsLoading ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        搜索中...
                      </div>
                    ) : query.length === 0 && searchHistory.length > 0 ? (
                      <div className="py-1">
                        <div className="flex items-center justify-between px-4 py-1.5">
                          <span className="text-xs font-medium text-muted-foreground">搜索历史</span>
                          <button
                            onClick={handleHistoryClear}
                            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            aria-label="清除搜索历史"
                          >
                            清除
                          </button>
                        </div>
                        {searchHistory.map((term) => (
                          <button
                            key={term}
                            className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/70"
                            onClick={() => handleHistorySelect(term)}
                          >
                            <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="text-sm truncate">{term}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <ul role="listbox" className="max-h-80 overflow-y-auto py-1">
                        {suggestions.map((item, idx) => (
                          <li
                            key={item.id}
                            role="option"
                            aria-selected={idx === activeSuggestion}
                            className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer ${idx === activeSuggestion ? 'bg-accent' : 'hover:bg-accent/70'}`}
                            onClick={() => {
                              router.push(`/novels/${item.id}`);
                              setSuggestionsOpen(false);
                              setActiveSuggestion(-1);
                            }}
                            onMouseEnter={() => setActiveSuggestion(idx)}
                          >
                            <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm leading-tight truncate">
                                {highlightTitle(item.title)}
                              </p>
                              <p className="text-xs text-muted-foreground truncate mt-0.5">
                                {item.author}
                              </p>
                            </div>
                            {item.category && (
                              <span
                                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full"
                                style={{
                                  backgroundColor: `${item.category.color}18`,
                                  color: item.category.color,
                                }}
                              >
                                {item.category.name}
                              </span>
                            )}
                          </li>
                        ))}
                        {/* Keyboard hint footer */}
                        <li className="flex items-center gap-2 px-4 py-1.5 border-t mt-1 text-[10px] text-muted-foreground/60">
                          <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">↑↓</kbd> 导航
                          <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Enter</kbd> 选择
                          <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Esc</kbd> 关闭
                        </li>
                      </ul>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
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

      {/* Recently Viewed */}
      {recentNovels.length > 0 && (
        <section className="border-b bg-muted/20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">最近浏览</span>
                <span className="text-[10px] text-muted-foreground/60">{recentNovels.length}</span>
              </div>
              <button
                onClick={() => { clearRecentlyViewed(); setRecentNovels([]); }}
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                清除
              </button>
            </div>
            <div className="flex items-center gap-3 overflow-x-auto scrollbar-none pb-1">
              {recentNovels.slice(0, 8).map((rn) => (
                <Link
                  key={rn.id}
                  href={`/novels/${rn.id}`}
                  className="shrink-0 flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2 transition-all hover:shadow-sm hover:border-primary/30 hover:-translate-y-0.5 group"
                >
                  <div className="h-8 w-6 rounded overflow-hidden shrink-0">
                    {rn.coverUrl ? (
                      <img src={rn.coverUrl} alt={rn.title} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className={`h-full w-full bg-gradient-to-br ${getGradient(rn.title)}`} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium line-clamp-1 group-hover:text-primary transition-colors">{rn.title}</p>
                    <p className="text-[10px] text-muted-foreground line-clamp-1">{rn.author}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

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

          {/* Filter summary bar when filters are active */}
          {hasActiveFilter && !loadingNovels && (
            <div className="py-2.5 border-t">
              <p className="text-center text-xs text-muted-foreground/70 bg-muted/30 rounded-md py-1.5 px-3">
                找到 <span className="font-medium text-muted-foreground">{total}</span> 本小说
                {getFilterSummary() !== '全部小说' && (
                  <span className="ml-2 text-muted-foreground/50">{getFilterSummary()}</span>
                )}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ─── Novels Section ──────────────────────────────────────── */}
      <section id="novels-section" className="flex-1">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
          {/* Section header */}
          <AnimatePresence mode="wait">
            {loadingNovels ? (
              <motion.div
                key="skeleton-header"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-center gap-2 mb-6"
              >
                <Skeleton className="h-6 w-28" />
                <Skeleton className="h-4 w-16" />
              </motion.div>
            ) : (
              <motion.div
                key="real-header"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="flex items-center justify-between mb-6"
              >
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{getFilterSummary()}</h2>
                  <span className="text-sm text-muted-foreground">
                    共 {total} 本小说
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Novel grid */}
          <AnimatePresence mode="wait">
            {loadingNovels ? (
              <motion.div
                key="skeleton-grid"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <SkeletonGrid />
              </motion.div>
            ) : novelsError ? (
              <motion.div
                key="error-state"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col items-center justify-center py-20 text-center"
              >
                <div className="h-16 w-16 rounded-2xl bg-destructive/10 flex items-center justify-center mb-4">
                  <FileText className="h-8 w-8 text-destructive/60" />
                </div>
                <h3 className="text-base font-medium mb-1">加载失败</h3>
                <p className="text-sm text-muted-foreground mb-4">无法获取小说列表，请检查网络后重试</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setNovelsError(false);
                    setPage((p) => p); // trigger re-fetch
                  }}
                  className="gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  重试
                </Button>
              </motion.div>
            ) : novels.length === 0 ? (
              <motion.div
                key="empty-state"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col items-center justify-center py-20 text-center"
              >
                {hasActiveFilter ? (
                  <>
                    <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                      <BookOpen className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <h3 className="text-base font-medium mb-1">暂无匹配结果</h3>
                    <p className="text-sm text-muted-foreground">试试其他关键词或筛选条件</p>
                  </>
                ) : (
                  <>
                    <div className="h-20 w-20 rounded-2xl bg-muted flex items-center justify-center mb-5">
                      <Book className="h-10 w-10 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold mb-2">暂无小说</h3>
                    <p className="text-sm text-muted-foreground mb-6 max-w-xs">
                      开始添加您的第一本小说，或等待采集任务自动入库
                    </p>
                    <Button
                      variant="default"
                      onClick={() => router.push('/login')}
                      className="gap-2"
                    >
                      <Shield className="h-4 w-4" />
                      前往管理后台
                    </Button>
                  </>
                )}
              </motion.div>
            ) : (
              <motion.div
                key={`${activeCategorySlug}-${activeStatus}-${activeWordCount}-${activeSort}-${search}-${page}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' as const }}
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6"
              >
                {novels.map((novel, i) => (
                  <NovelCard key={novel.id} novel={novel} index={i} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 mt-10">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 page-btn"
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
                    className="h-8 w-8 page-btn"
                    onClick={() => setPage(p)}
                    aria-current={p === page ? 'page' : undefined}
                  >
                    {p}
                  </Button>
                ),
              )}
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 page-btn"
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
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
          <div className="flex flex-col items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <BookOpen className="h-4 w-4 text-primary/70" />
              </div>
              <span className="font-semibold text-foreground/80">小说阁</span>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <Link href="/categories" className="text-muted-foreground/60 hover:text-foreground transition-colors">分类</Link>
              <span className="text-muted-foreground/20">·</span>
              <Link href="/rankings" className="text-muted-foreground/60 hover:text-foreground transition-colors">排行榜</Link>
              <span className="text-muted-foreground/20">·</span>
              <Link href="/login" className="text-muted-foreground/60 hover:text-foreground transition-colors">管理</Link>
            </div>
            <p className="text-[11px] text-muted-foreground/40">
              © 2026 小说阁 · 基于 Next.js 16 + Prisma + Tailwind CSS 构建
            </p>
          </div>
        </div>
      </footer>
      <BackToTop />
    </div>
  );
}