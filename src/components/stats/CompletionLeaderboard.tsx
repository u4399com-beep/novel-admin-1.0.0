'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Trophy, AlertCircle, CheckCircle2, BookOpen } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { getSessionId } from '@/lib/reading-session';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';

// ─── Types ─────────────────────────────────────────────────────────

interface LeaderboardEntry {
  novelId: string;
  title: string;
  author: string;
  coverUrl: string | null;
  completionPct: number;
  chaptersRead: number;
  totalChapters: number;
}

interface ApiResponse {
  leaderboard: LeaderboardEntry[];
}

// ─── Constants ──────────────────────────────────────────────────────

const RANK_COLORS = [
  { bg: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400', ring: 'ring-amber-500/30' },    // Gold
  { bg: 'bg-slate-400/15', text: 'text-slate-500 dark:text-slate-300', ring: 'ring-slate-400/30' },       // Silver
  { bg: 'bg-orange-500/15', text: 'text-orange-600 dark:text-orange-400', ring: 'ring-orange-500/30' },   // Bronze
];

// ─── Loading Skeleton ──────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glow card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Trophy className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Skeleton className="h-4 w-36 rounded" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-5 w-5 rounded-full shrink-0" />
            <Skeleton className="h-9 w-9 rounded-lg shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-3/4 rounded" />
              <Skeleton className="h-2.5 w-1/2 rounded" />
            </div>
            <Skeleton className="h-3.5 w-10 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Progress Bar ──────────────────────────────────────────────────

function ProgressBar({ pct, isTop3 }: { pct: number; isTop3: boolean }) {
  const colorClass = isTop3
    ? 'bg-gradient-to-r from-amber-500 to-amber-400'
    : 'bg-primary';
  return (
    <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden flex-1 max-w-[80px]">
      <motion.div
        role="progressbar"
        aria-valuenow={Math.min(pct, 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className={`h-full rounded-full ${colorClass}`}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(pct, 100)}%` }}
        transition={{ duration: 0.6, ease: 'easeOut' as const, delay: 0.15 }}
      />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function CompletionLeaderboard() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const sid = getSessionId();
      const res = await apiFetch<ApiResponse>(`/api/stats/completion-leaderboard?sessionId=${encodeURIComponent(sid)}`, {
        signal,
        silent: true,
      });
      if (!signal?.aborted) setLeaderboard(res.leaderboard);
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="rounded-xl border bg-card p-5 card-glow card-border-glow">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/10">
              <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            </div>
            <span className="text-sm font-semibold">完成度排行榜</span>
          </div>
          <p className="text-sm text-muted-foreground">{error || '无法加载数据'}</p>
        </div>
      </motion.div>
    );
  }

  if (leaderboard.length === 0) {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="rounded-xl border bg-card p-5 card-glow card-border-glow">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
              <Trophy className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <span className="text-sm font-semibold">完成度排行榜</span>
          </div>
          <div className="flex items-center justify-center py-10">
            <p className="text-sm text-muted-foreground/60">暂无阅读进度数据</p>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' as const }}
    >
      <div className="rounded-xl border bg-card p-5 card-glow card-border-glow hover-lift focus-ring-soft">
        <div className="flex items-center gap-2 mb-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10">
            <Trophy className="h-3.5 w-3.5 text-amber-500" />
          </div>
          <h2 className="text-sm font-semibold link-underline inline-block">完成度排行榜</h2>
        </div>

        <div className="space-y-2.5">
          {leaderboard.map((entry, idx) => {
            const rank = idx + 1;
            const isTop3 = rank <= 3;
            const isCompleted = entry.completionPct >= 100;
            const rankStyle = isTop3 ? RANK_COLORS[rank - 1] : null;

            return (
              <motion.div
                key={entry.novelId}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.06, duration: 0.3, ease: 'easeOut' as const }}
              >
                <Link
                  href={`/novels/${entry.novelId}`}
                  className="flex items-center gap-2.5 py-1.5 -mx-2 px-2 rounded-lg hover:bg-muted/40 transition-colors group"
                >
                  {/* Rank Number */}
                  <div
                    className={
                      'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold shrink-0 ' +
                      (rankStyle
                        ? `${rankStyle.bg} ${rankStyle.text} ring-1 ${rankStyle.ring}`
                        : 'text-muted-foreground bg-muted/50')
                    }
                  >
                    {rank}
                  </div>

                  {/* Cover Thumbnail */}
                  <div className="h-9 w-9 rounded-lg overflow-hidden bg-muted/60 shrink-0">
                    {entry.coverUrl ? (
                      <img
                        src={entry.coverUrl}
                        alt={entry.title}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <BookOpen className="h-3.5 w-3.5 text-muted-foreground/40" />
                      </div>
                    )}
                  </div>

                  {/* Title & Author */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                      {isCompleted && (
                        <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-500 mr-1 -mt-0.5" />
                      )}
                      {entry.title}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">{entry.author}</p>
                  </div>

                  {/* Progress Bar + Percentage */}
                  <div className="flex items-center gap-2 shrink-0">
                    <ProgressBar pct={entry.completionPct} isTop3={isTop3} />
                    <span className={`text-[11px] font-medium tabular-nums w-9 text-right ${
                      isCompleted ? 'text-emerald-500' : isTop3 ? (rankStyle?.text ?? 'text-muted-foreground') : 'text-muted-foreground'
                    }`}>
                      {entry.completionPct}%
                    </span>
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
