'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen, Search, ChevronLeft, ChevronRight,
  History, Loader2, RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────

export interface Category {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  description: string | null;
  color: string;
  _count: { novels: number };
}

// ─── Filter Config ──────────────────────────────────────────────────

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

// ─── Search History ─────────────────────────────────────────────────

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
      <div className="relative flex-1 min-w-0 scroll-fade-edges" role="toolbar" aria-label={label}>
        {/* Left arrow */}
        {showLeftArrow && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-background border shadow-sm hover:bg-accent transition-colors no-fade-left"
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
                aria-pressed={isActive}
                className={`shrink-0 px-3 py-1 rounded-full text-sm transition-all duration-150 whitespace-nowrap tap-feedback tag-pill ${
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
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-background border shadow-sm hover:bg-accent transition-colors no-fade-right"
            aria-label="向右滚动"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── HeroSection ────────────────────────────────────────────────────

export interface HeroSectionProps {
  search: string;
  onSearch: (term: string) => void;
  categories: Category[];
  loadingCategories: boolean;
  loadingNovels: boolean;
  activeCategorySlug: string;
  activeStatus: string;
  activeWordCount: string;
  activeSort: string;
  onCategoryChange: (slug: string) => void;
  onStatusChange: (status: string) => void;
  onWordCountChange: (wc: string) => void;
  onSortChange: (sort: string) => void;
  hasActiveFilter: boolean;
  resetAllFilters: () => void;
  total: number;
  filterSummary: string;
}

export function HeroSection({
  search,
  onSearch,
  categories,
  loadingCategories,
  loadingNovels,
  activeCategorySlug,
  activeStatus,
  activeWordCount,
  activeSort,
  onCategoryChange,
  onStatusChange,
  onWordCountChange,
  onSortChange,
  hasActiveFilter,
  resetAllFilters,
  total,
  filterSummary,
}: HeroSectionProps) {
  const router = useRouter();

  // Search input state (internal to HeroSection)
  const [searchInput, setSearchInput] = useState('');
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

  // Build category options for filter
  const categoryOptions = [
    { value: '' as const, label: '全部' },
    ...categories.map((cat) => ({
      value: cat.slug as string & '',
      label: cat.name,
      icon: cat.icon ?? undefined,
    })),
  ];

  // ─── Handlers ──────────────────────────────────────────────────
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchInput.trim();
    if (trimmed) addSearchHistory(trimmed);
    onSearch(trimmed);
    setSuggestionsOpen(false);
    setSearchHistory(getSearchHistory());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleHistoryClear = () => {
    clearSearchHistory();
    setSearchHistory([]);
  };

  const handleHistorySelect = (term: string) => {
    setSearchInput(term);
    onSearch(term);
    setSuggestionsOpen(false);
    addSearchHistory(term);
    setSearchHistory(getSearchHistory());
  };

  // ─── Search suggestions (debounced) ─────────────────────────────
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
        const data = await apiFetch<{ suggestions?: Array<{ id: string; title: string; author: string; category: { name: string; color: string } | null }> }>(`/api/public/search-suggestions?q=${encodeURIComponent(query)}`, {
          signal: abortController.signal,
        });
        setSuggestions(data.suggestions || []);
        setActiveSuggestion(-1);
        setSuggestionsOpen(true);
      } catch {
        // Network error — silently ignore for search suggestions
      } finally {
        if (!abortController.signal.aborted) setSuggestionsLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortController?.abort();
    };
  }, [hasQuery, query]);

  // ─── Close suggestions on outside click ─────────────────────────
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSuggestionsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ─── Highlight matching part of title ────────────────────────────
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

  const handleReset = () => {
    setSearchInput('');
    setSuggestions([]);
    setSuggestionsOpen(false);
    resetAllFilters();
  };

  return (
    <>
      {/* ─── Compact Search Bar ──────────────────────────────────── */}
      <section className="border-b bg-muted/30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
          <div className="flex items-center gap-3">
            <h1 className="sm:block text-xl font-bold tracking-tight shrink-0 text-glow-subtle sr-only sm:not-sr-only text-shadow-sm">
              小说搜索
            </h1>
            <div className="flex-1 max-w-full sm:max-w-2xl" ref={searchRef}>
              <form onSubmit={handleSearch} className="relative search-focus-ring rounded-lg">
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
                            className="text-xs text-muted-foreground hover:text-foreground transition-colors focus-ring-soft"
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
                  onClick={() => { setSearchInput(''); onSearch(''); }}
                  className="ml-1 hover:text-foreground focus-ring-soft"
                  aria-label="清除搜索"
                >
                  ×
                </button>
              </Badge>
            )}
          </div>
        </div>
      </section>

      {/* ─── 4-Row Filter System ────────────────────────────────── */}
      <section id="filter-section" className="border-b bg-background">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="divide-y divide-border/50 py-1">
            {/* Row 1: 分类 */}
            <FilterRow
              label="分类"
              options={categoryOptions}
              value={activeCategorySlug}
              onChange={onCategoryChange}
              loading={loadingCategories}
            />

            {/* Row 2: 状态 */}
            <FilterRow
              label="状态"
              options={STATUS_OPTIONS}
              value={activeStatus}
              onChange={onStatusChange}
            />

            {/* Row 3: 字数 */}
            <FilterRow
              label="字数"
              options={WORD_COUNT_OPTIONS}
              value={activeWordCount}
              onChange={onWordCountChange}
            />

            {/* Row 4: 排序 */}
            <FilterRow
              label="排序"
              options={SORT_OPTIONS}
              value={activeSort}
              onChange={onSortChange}
            />
          </div>

          {/* Reset button when filters active */}
          {hasActiveFilter && (
            <div className="flex items-center justify-end py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
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
                {filterSummary !== '全部小说' && (
                  <span className="ml-2 text-muted-foreground/50">{filterSummary}</span>
                )}
              </p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
