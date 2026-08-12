'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, X } from 'lucide-react';
import { getSessionId } from '@/lib/reading-session';
import { apiFetch } from '@/lib/api-fetch';
import { getCoverGradient } from '@/lib/cover-gradient';

// ─── Progress Ring Component ──────────────────────────────────────
function ProgressRing({ percent, size = 44, strokeWidth = 3 }: { percent: number; size?: number; strokeWidth?: number }) {
  const ringId = useId();
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(percent, 100) / 100) * circumference;

  return (
    <svg width={size} height={size} className="progress-ring-svg" aria-hidden="true">
      <defs>
        <linearGradient id={`progress-ring-${ringId}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--primary)" />
          <stop offset="100%" stopColor="oklch(0.7 0.15 200)" />
        </linearGradient>
      </defs>
      {/* Background circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-black/5 dark:text-white/10"
      />
      {/* Progress circle with gradient stroke */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={`url(#progress-ring-${ringId})`}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="progress-ring-circle"
        style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%', transition: 'stroke-dashoffset 0.6s cubic-bezier(0.4, 0, 0.2, 1)' }}
      />
      {/* Center text */}
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-foreground text-[10px] font-semibold tabular-nums"
      >
        {Math.min(percent, 100)}%
      </text>
    </svg>
  );
}

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

// ─── Skeleton ──────────────────────────────────────────────────────

function ContinueReadingSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-4 w-4 animate-pulse bg-muted rounded" />
        <div className="h-4 w-20 animate-pulse bg-muted rounded" />
      </div>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="shrink-0 w-16"
          >
            <div className="h-24 w-16 rounded animate-pulse bg-muted mb-2" />
            <div className="h-3.5 w-14 animate-pulse bg-muted rounded" />
            <div className="h-3 w-10 animate-pulse bg-muted rounded mt-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Stagger variants ───────────────────────────────────────────────

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.06 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

// ─── Main Component ────────────────────────────────────────────────

export function ContinueReading() {
  // Initialize loading state, determine actual state after mount to avoid SSR hydration mismatch
  const [progress, setProgress] = useState<ReadingProgressItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- client hydration pattern */
  useEffect(() => {
    // Check dismissed state and session after mount (client-side only)
    try {
      if (localStorage.getItem('continue-reading-dismissed') === 'true') {
        setDismissed(true);
        setLoading(false);
        return;
      }
    } catch { /* ignore */ }

    const sessionId = getSessionId();
    if (!sessionId) {
      setLoading(false);
      return;
    }

    const ac = new AbortController();
    apiFetch<{ progress: ReadingProgressItem[] }>(`/api/public/reading-progress?sessionId=${encodeURIComponent(sessionId)}`, { signal: ac.signal })
      .then((data) => { if (!ac.signal.aborted) setProgress(data.progress || []); })
      .catch(() => {})
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

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
    <AnimatePresence mode="wait">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="rounded-xl border bg-card p-5 card-glow"
      >
        {/* Section Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary/70" />
            <span className="text-sm font-semibold">最近阅读</span>
            {progress.length > 0 && (
              <span className="text-xs text-muted-foreground/60">{progress.length}</span>
            )}
          </div>
          {!loading && progress.length > 0 && (
            <button
              onClick={handleDismiss}
              className="text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors p-1 rounded hover:bg-muted/50 focus-ring-soft"
              aria-label="隐藏最近阅读"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <ContinueReadingSkeleton />
        ) : (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="flex gap-4 overflow-x-auto scrollbar-none pb-1 -mx-1 px-1"
          >
            {progress.slice(0, 6).map((item) => {
              const totalChapters = item.novel._count.chapters;
              const currentCh = item.chapterIndex + 1;
              const readPercent = totalChapters > 0
                ? Math.round((currentCh / totalChapters) * 100)
                : 0;

              return (
                <motion.div key={item.id} variants={itemVariants} className="shrink-0">
                  <Link
                    href={`/novels/${item.novelId}`}
                    className="group/item flex flex-col items-center"
                    style={{ width: '72px' }}
                  >
                    {/* Cover Thumbnail with Progress Ring Overlay */}
                    <div className="relative" style={{ width: '56px', height: '76px' }}>
                      <div className="h-full w-full rounded-lg overflow-hidden shadow-sm ring-1 ring-black/5 dark:ring-white/5 transition-all duration-300 group-hover/item:shadow-md group-hover/item:ring-primary/20 group-hover/item:-translate-y-0.5">
                        {item.novel.coverUrl ? (
                          <img
                            src={item.novel.coverUrl}
                            alt={item.novel.title}
                            className="h-full w-full object-cover transition-transform duration-500 group-hover/item:scale-105"
                            loading="lazy"
                          />
                        ) : (
                          <div className={`h-full w-full bg-gradient-to-br ${getCoverGradient(item.novel.title)}`} />
                        )}
                      </div>
                      {/* Progress Ring */}
                      <div className="absolute -bottom-2 -right-2 progress-ring-pulse">
                        <ProgressRing percent={readPercent} size={28} strokeWidth={2.5} />
                      </div>
                    </div>

                    {/* Info */}
                    <p className="text-xs font-medium leading-snug line-clamp-1 group-hover/item:text-primary transition-colors mt-3 text-center">
                      {item.novel.title}
                    </p>
                    <p className="text-[10px] text-muted-foreground/70 leading-snug line-clamp-1 mt-0.5 text-center">
                      {item.novel.author}
                    </p>
                  </Link>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
