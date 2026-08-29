'use client';

import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen, FileText, ChevronLeft, ChevronRight,
  RotateCcw, Book, Shield,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NovelGridLayout, NovelMagazineLayout, NovelListLayout, NovelSiteLayout } from '@/components/home/layouts';
import { getPageNumbers } from '@/lib/pagination';
import type { LayoutTheme } from '@/lib/use-layout-theme';
import type { NovelCardData } from '@/components/home/shared-types';

// Re-export for convenience
export type Novel = NovelCardData;

// ─── HighlightText ─────────────────────────────────────────────────

export function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-primary/20 text-foreground rounded px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
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
    <div className="grid-auto-fit">
      {Array.from({ length: 10 }).map((_, i) => (
        <NovelCardSkeleton key={i} />
      ))}
    </div>
  );
}

// ─── NovelGrid ───────────────────────────────────────────────────────

export interface NovelGridProps {
  novels: Novel[];
  loading: boolean;
  novelsError: boolean;
  page: number;
  totalPages: number;
  total: number;
  hasActiveFilter: boolean;
  filterSummary: string;
  layoutTheme: LayoutTheme;
  animKey: string;
  search?: string;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  onLoginClick: () => void;
}

export function NovelGrid({
  novels,
  loading,
  novelsError,
  page,
  totalPages,
  total,
  hasActiveFilter,
  filterSummary,
  layoutTheme,
  animKey,
  search = '',
  onPageChange,
  onRetry,
  onLoginClick,
}: NovelGridProps) {
  return (
    <section id="novels-section" className="flex-1">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        {/* Section header */}
        <AnimatePresence mode="wait">
          {loading ? (
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
                <h2 className="text-lg font-semibold">{filterSummary}</h2>
                <span className="text-sm text-muted-foreground">
                  共 {total} 本小说
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Novel grid */}
        <AnimatePresence mode="wait">
          {loading ? (
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
                onClick={onRetry}
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
                  <h3 className="text-xl font-semibold mb-2 text-shimmer">暂无小说</h3>
                  <p className="text-sm text-muted-foreground mb-6 max-w-xs text-gradient-muted">
                    开始添加您的第一本小说，或等待采集任务自动入库
                  </p>
                  <Button
                    variant="default"
                    onClick={onLoginClick}
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
              key={animKey}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' as const }}
              className="stagger-children"
            >
              {layoutTheme === 'grid' && <NovelGridLayout novels={novels} search={search} />}
              {layoutTheme === 'magazine' && <NovelMagazineLayout novels={novels} search={search} />}
              {layoutTheme === 'list' && <NovelListLayout novels={novels} search={search} />}
              {layoutTheme === 'novel-site' && <NovelSiteLayout novels={novels} search={search} />}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-1.5 mt-10">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 page-btn btn-ripple"
              aria-label="上一页"
              disabled={page <= 1}
              onClick={() => { onPageChange(Math.max(1, page - 1)); }}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {getPageNumbers(page, totalPages).map((p, i) =>
              typeof p === 'string' ? (
                <span key={`dots-${i}`} className="px-1 text-muted-foreground">
                  ...
                </span>
              ) : (
                <Button
                  key={p}
                  variant={p === page ? 'default' : 'outline'}
                  size="icon"
                  className="h-8 w-8 page-btn btn-ripple"
                  onClick={() => { onPageChange(p); }}
                  aria-current={p === page ? 'page' : undefined}
                >
                  {p}
                </Button>
              ),
            )}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 page-btn btn-ripple"
              aria-label="下一页"
              disabled={page >= totalPages}
              onClick={() => { onPageChange(Math.min(totalPages, page + 1)); }}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
