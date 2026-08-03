'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, ChevronRight, X, Loader2, Clock } from 'lucide-react';
import { getSessionId } from '@/lib/reading-session';
import { formatRelativeTime, formatWordCount } from '@/lib/format';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ─────────────────────────────────────────────────────────

interface ReadingProgressItem {
  id: string;
  novelId: string;
  chapterId: string | null;
  chapterIndex: number;
  scrollPercent: number | null;
  lastReadAt: string;
  novel: {
    id: string;
    title: string;
    author: string;
    coverUrl: string | null;
    status: string;
    wordCount: number;
    category: { name: string; color: string; slug: string } | null;
    _count: { chapters: number };
  };
}

import { getCoverGradient } from '@/lib/cover-gradient';

// ─── Skeleton ──────────────────────────────────────────────────────

function ContinueReadingSkeleton() {
  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-3 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="shrink-0 flex items-center gap-3 rounded-xl border bg-background p-3 w-[280px]"
          >
            <div className="h-14 w-10 rounded-md animate-pulse bg-muted" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="h-3.5 w-3/4 rounded skeleton-line" />
              <div className="h-3 w-1/2 rounded skeleton-line" />
              <div className="h-2.5 w-2/3 rounded skeleton-line" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────

export function ContinueReading() {
  const shouldLoad = (() => {
    try {
      if (localStorage.getItem('continue-reading-dismissed') === 'true') return false;
    } catch { /* ignore */ }
    return !!getSessionId();
  })();
  const [progress, setProgress] = useState<ReadingProgressItem[]>([]);
  const [loading, setLoading] = useState(shouldLoad);
  const [dismissed, setDismissed] = useState(!shouldLoad);

  useEffect(() => {
    if (!shouldLoad) return;
    const ac = new AbortController();
    const sessionId = getSessionId();
    apiFetch<{ progress: ReadingProgressItem[] }>(`/api/public/reading-progress?sessionId=${encodeURIComponent(sessionId)}`, { signal: ac.signal })
      .then((data) => setProgress(data.progress || []))
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem('continue-reading-dismissed', 'true');
    } catch { /* ignore */ }
  }, []);

  // Don't render if dismissed or no progress and not loading
  if (dismissed) return null;
  if (!loading && progress.length === 0) return null;

  return (
    <div className="group relative">
      {/* Section Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BookOpen className="h-3.5 w-3.5 text-primary/70" />
          <span className="text-xs font-medium text-muted-foreground">继续阅读</span>
          {progress.length > 0 && (
            <span className="text-[10px] text-muted-foreground/60">{progress.length}</span>
          )}
        </div>
        {!loading && progress.length > 0 && (
          <button
            onClick={handleDismiss}
            className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors opacity-0 group-hover:opacity-100"
            aria-label="隐藏继续阅读"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="skeleton"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <ContinueReadingSkeleton />
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex items-center gap-3 overflow-x-auto scrollbar-none no-scrollbar pb-1 scroll-fade-edges">
              {progress.slice(0, 8).map((item) => {
                const totalChapters = item.novel._count.chapters;
                const currentCh = item.chapterIndex + 1;
                const readPercent = totalChapters > 0
                  ? Math.round((currentCh / totalChapters) * 100)
                  : 0;
                const statusLabel = item.novel.status === 'ongoing'
                  ? '连载中'
                  : item.novel.status === 'completed'
                    ? '已完结'
                    : '暂停中';

                return (
                  <Link
                    key={item.id}
                    href={`/novels/${item.novelId}`}
                    className="shrink-0 flex items-center gap-3 rounded-xl border bg-background/80 backdrop-blur-sm p-3 w-[280px] transition-all hover:shadow-md hover:border-primary/30 hover:-translate-y-0.5 group/item card-glow"
                  >
                    {/* Cover Thumbnail */}
                    <div className="h-14 w-10 rounded-md overflow-hidden shrink-0 relative">
                      {item.novel.coverUrl ? (
                        <img
                          src={item.novel.coverUrl}
                          alt={item.novel.title}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className={`h-full w-full bg-gradient-to-br ${getCoverGradient(item.novel.title)}`} />
                      )}
                      {/* Progress indicator bar */}
                      <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-black/20">
                        <div
                          className="h-full bg-primary/80 transition-all"
                          style={{ width: `${Math.min(readPercent, 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium line-clamp-1 group-hover/item:text-primary transition-colors">
                        {item.novel.title}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] text-muted-foreground/60">
                          {statusLabel}
                        </span>
                        {item.novel.category && (
                          <span
                            className="text-[10px] px-1 py-px rounded-sm"
                            style={{
                              color: item.novel.category.color,
                              backgroundColor: `${item.novel.category.color}15`,
                            }}
                          >
                            {item.novel.category.name}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/50">
                        <span>第{currentCh}章{totalChapters > 0 ? `/共${totalChapters}章` : ''}</span>
                        <span className="text-muted-foreground/30">·</span>
                        <span className="flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {formatRelativeTime(item.lastReadAt)}
                        </span>
                      </div>
                    </div>

                    {/* Arrow */}
                    <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover/item:text-primary/50 shrink-0 transition-colors" />
                  </Link>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
