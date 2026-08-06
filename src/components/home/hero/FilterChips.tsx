'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

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
    <div className="relative flex items-center gap-3 py-2 stagger-children">
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
          className="flex items-center gap-2 overflow-x-auto py-1 scrollbar-none scrollbar-thin"
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
                className={`shrink-0 px-3 py-1 rounded-full text-sm transition-all duration-150 whitespace-nowrap tap-feedback tag-pill hover-scale ${
                  isActive
                    ? 'bg-primary text-primary-foreground font-medium shadow-sm badge-glow'
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

// ─── Props ─────────────────────────────────────────────────────────

export interface FilterChipsProps {
  categories: { id: string; name: string; slug: string; icon: string | null; color: string }[];
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

export function FilterChips({
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
}: FilterChipsProps) {
  const categoryOptions = [
    { value: '' as const, label: '全部' },
    ...categories.map((cat) => ({
      value: cat.slug as string & '',
      label: cat.name,
      icon: cat.icon ?? undefined,
    })),
  ];

  return (
    <section id="filter-section" className="border-b bg-background stagger-children">
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
              {filterSummary !== '全部小说' && (
                <span className="ml-2 text-muted-foreground/50">{filterSummary}</span>
              )}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
