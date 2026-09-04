'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { RefreshCw, Clock } from 'lucide-react';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NovelCover } from '@/components/shared/NovelCover';
import { apiFetch, FetchError } from '@/lib/api-fetch';
import { formatRelativeTime } from '@/lib/format';

// ─── Types ─────────────────────────────────────────────────────────

interface RecentlyUpdatedNovel {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  category: string | null;
  totalChapters: number;
  lastChapterTitle: string;
  updatedAt: string;
}

// ─── Skeleton ──────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="shrink-0 w-[140px] sm:w-[160px] lg:w-[152px]">
      <div className="h-[100px] w-full rounded-lg animate-pulse bg-muted mb-2.5" />
      <div className="h-3.5 w-3/4 animate-pulse bg-muted rounded" />
      <div className="h-3 w-1/2 animate-pulse bg-muted rounded mt-1.5" />
    </div>
  );
}

// ─── Card ──────────────────────────────────────────────────────────

function NovelCard({ novel, index }: { novel: RecentlyUpdatedNovel; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.06, ease: 'easeOut' }}
      className="shrink-0 w-[140px] sm:w-[160px] lg:w-[152px]"
    >
      <Link
        href={`/novels/${novel.id}`}
        className="group block"
      >
        {/* Cover */}
        <div className="relative h-[100px] w-full rounded-lg overflow-hidden shadow-sm ring-1 ring-black/5 dark:ring-white/5 transition-all duration-300 group-hover:shadow-md group-hover:ring-primary/20 group-hover:-translate-y-0.5">
          <NovelCover coverUrl={novel.coverUrl} title={novel.title} className="transition-transform duration-500 group-hover:scale-105" />
        </div>

        {/* Info */}
        <div className="mt-2.5 space-y-1">
          <p className="text-sm font-medium leading-snug line-clamp-1 group-hover:text-primary transition-colors">
            {novel.title}
          </p>
          <p className="text-xs text-muted-foreground line-clamp-1">{novel.author}</p>
          <p className="text-[11px] text-muted-foreground/60 line-clamp-1 mt-0.5">
            最新: {novel.lastChapterTitle}
          </p>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50">
            <Clock className="h-3 w-3" />
            <span>{formatRelativeTime(novel.updatedAt)}</span>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

// ─── Main Component ────────────────────────────────────────────────

function RecentlyUpdatedNovelsInner() {
  const [novels, setNovels] = useState<RecentlyUpdatedNovel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async (isRefresh = false, signal?: AbortSignal) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const data = await apiFetch<{ novels: RecentlyUpdatedNovel[] }>(
        '/api/public/recently-updated?limit=6',
        { signal, silent: true },
      );
      if (!signal?.aborted) {
        setNovels(data.novels || []);
      }
    } catch (err) {
      if (!(err instanceof FetchError && err.status === 0)) {
        // Silently fail — this section is non-critical
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(false, ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  if (!loading && novels.length === 0) return null;

  return (
    <section className="border-b bg-muted/20 card-glass">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
        {/* Section Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <RefreshCw className={`h-4 w-4 text-primary/70 ${refreshing ? 'animate-spin' : ''}`} />
            <h2 className="text-sm font-semibold">最近更新</h2>
            {!loading && novels.length > 0 && (
              <span className="text-xs text-muted-foreground/60">{novels.length}</span>
            )}
          </div>
          {!loading && novels.length > 0 && (
            <button
              onClick={() => fetchData(true)}
              disabled={refreshing}
              className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors p-1 rounded hover:bg-muted/50 focus-ring-soft disabled:opacity-50"
              aria-label="刷新最近更新"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>

        {/* Content: Horizontal scroll on mobile, grid on desktop */}
        {loading ? (
          <div className="flex gap-3 overflow-x-auto scrollbar-none pb-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <>
            {/* Mobile: horizontal scroll */}
            <div className="lg:hidden">
              <ScrollArea className="w-full whitespace-nowrap">
                <div className="flex gap-3 pb-3">
                  {novels.map((novel, i) => (
                    <NovelCard key={novel.id} novel={novel} index={i} />
                  ))}
                </div>
                <ScrollBar orientation="horizontal" />
              </ScrollArea>
            </div>

            {/* Desktop: grid layout */}
            <div className="hidden lg:grid lg:grid-cols-6 gap-4">
              {novels.map((novel, i) => (
                <NovelCard key={novel.id} novel={novel} index={i} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

// ─── Export with ErrorBoundary ─────────────────────────────────────

export function RecentlyUpdatedNovels() {
  return (
    <ErrorBoundary name="RecentlyUpdatedNovels">
      <RecentlyUpdatedNovelsInner />
    </ErrorBoundary>
  );
}
