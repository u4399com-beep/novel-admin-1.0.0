'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  BookOpen, Trophy, Flame, TrendingUp, Library, CheckCircle2,
  Clock, BarChart3, ArrowLeft, Loader2, BookMarked, RotateCcw,
} from 'lucide-react';
import ReadingHeatMap from '@/components/ReadingHeatMap';
import { Button } from '@/components/ui/button';
import { getSessionId } from '@/lib/reading-session';
import { formatRelativeTime, formatWordCount } from '@/lib/format';
import { apiFetch } from '@/lib/api-fetch';
import { getGenreColor } from '@/lib/cover-gradient';

// ─── Types ─────────────────────────────────────────────────────────

interface ReadingStats {
  totalBooks: number;
  completedBooks: number;
  ongoingBooks: number;
  totalChaptersRead: number;
  streak: number;
  genreDistribution: { name: string; count: number }[];
  recentActivity: {
    novelId: string;
    novelTitle: string;
    author: string;
    chapterIndex: number;
    totalChapters: number;
    lastReadAt: string;
    category: { name: string; color: string } | null;
    status: string;
  }[];
}

// ─── Stat Card ──────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border bg-card p-4 card-glow card-border-glow focus-ring-soft"
    >
      <div className="flex items-center gap-2 mb-2">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-lg ${accent ? '' : 'bg-muted'}`}
          style={accent ? { backgroundColor: `${accent}15` } : undefined}
        >
          <Icon
            className={`h-4 w-4 ${accent ? '' : 'text-muted-foreground'}`}
          />
        </div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground/60 mt-0.5">{sub}</p>}
    </motion.div>
  );
}

// ─── Genre Bar ──────────────────────────────────────────────────────

function GenreBar({ name, count, maxCount, color }: { name: string; count: number; maxCount: number; color?: string }) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground w-16 shrink-0 truncate">{name}</span>
      <div className="flex-1 h-5 rounded-full bg-muted/50 overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color || 'var(--primary)' }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' as const, delay: 0.2 }}
        />
      </div>
      <span className="text-xs font-medium tabular-nums w-6 text-right">{count}</span>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export default function StatsPage() {
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [heatMapData, setHeatMapData] = useState<{ dates: Record<string, number> } | null>(null);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    const sessionId = getSessionId();
    if (!sessionId) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const data = await apiFetch<ReadingStats>(`/api/public/reading-stats?sessionId=${encodeURIComponent(sessionId)}`, { signal });
      setStats(data);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : '获取统计失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchStats(ac.signal);
    // Fetch heat map data in parallel
    const sessionId = getSessionId();
    if (sessionId) {
      apiFetch<{ dates: Record<string, number> }>(`/api/public/reading-heatMap?sessionId=${encodeURIComponent(sessionId)}`, { signal: ac.signal })
        .then(setHeatMapData)
        .catch(() => {});
    }
    return () => ac.abort();
  }, [fetchStats]);

  // Streak level
  const streakLevel = (stats?.streak ?? 0) >= 7 ? '🔥' : (stats?.streak ?? 0) >= 3 ? '⭐' : '';

  const hasData = stats && (stats.totalBooks > 0 || stats.totalChaptersRead > 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="text-base font-semibold">阅读统计</h1>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 text-center"
          >
            <div className="h-20 w-20 rounded-2xl bg-destructive/10 flex items-center justify-center mb-5">
              <BarChart3 className="h-10 w-10 text-destructive/50" />
            </div>
            <h2 className="text-lg font-semibold mb-2">加载失败</h2>
            <p className="text-sm text-muted-foreground mb-6 max-w-xs">{error}</p>
            <Button variant="outline" onClick={() => fetchStats()}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              重试
            </Button>
          </motion.div>
        ) : !hasData ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-24 text-center"
          >
            <div className="h-20 w-20 rounded-2xl bg-muted flex items-center justify-center mb-5">
              <BarChart3 className="h-10 w-10 text-muted-foreground/40" />
            </div>
            <h2 className="text-lg font-semibold mb-2 text-shimmer">暂无阅读数据</h2>
            <p className="text-sm text-muted-foreground mb-6 max-w-xs">
              开始阅读小说后，这里会展示你的阅读统计和习惯分析
            </p>
            <Button variant="outline" asChild>
              <Link href="/">
                <BookOpen className="mr-1.5 h-4 w-4" />
                去看看有什么好书
              </Link>
            </Button>
          </motion.div>
        ) : (
          stats && (
            <>
              {/* Stat Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard
                  icon={Library}
                  label="在读书籍"
                  value={stats.ongoingBooks}
                  sub={`共 ${stats.totalBooks} 本`}
                />
                <StatCard
                  icon={CheckCircle2}
                  label="读完书籍"
                  value={stats.completedBooks}
                  accent="#10b981"
                />
                <StatCard
                  icon={BookMarked}
                  label="已读章节"
                  value={stats.totalChaptersRead.toLocaleString()}
                />
                <StatCard
                  icon={Flame}
                  label="连续阅读"
                  value={`${streakLevel} ${stats.streak}天`}
                  accent={stats.streak >= 7 ? '#f97316' : stats.streak >= 3 ? '#eab308' : undefined}
                />
              </div>

              {/* Reading Heat Map */}
              <ReadingHeatMap data={heatMapData?.dates ?? {}} />

              {/* Genre Distribution */}
              {stats.genreDistribution.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                  className="rounded-xl border bg-card p-5 card-glow card-border-glow inset-shadow focus-ring-soft"
                >
                  <div className="flex items-center gap-2 mb-4">
                    <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold link-underline inline-block">阅读偏好</h2>
                  </div>
                  <div className="space-y-1">
                    {stats.genreDistribution.map((genre) => (
                      <div key={genre.name} className="fade-in-up">
                        <GenreBar
                          name={genre.name}
                          count={genre.count}
                          maxCount={stats.genreDistribution[0].count}
                          color={getGenreColor(genre.name)}
                        />
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Recent Activity */}
              {stats.recentActivity.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="rounded-xl border bg-card p-5 card-glow card-border-glow inset-shadow focus-ring-soft"
                >
                  <div className="flex items-center gap-2 mb-4">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold">最近阅读</h2>
                  </div>
                  <div className="divide-y">
                    {stats.recentActivity.map((activity, i) => {
                      const progress = activity.totalChapters > 0
                        ? Math.round(((activity.chapterIndex + 1) / activity.totalChapters) * 100)
                        : 0;
                      return (
                        <Link
                          key={`${activity.novelId}-${i}`}
                          href={`/novels/${activity.novelId}`}
                          className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 group/list list-item-compact -mx-2 px-2"
                        >
                          {/* Progress ring */}
                          <div className="relative h-10 w-10 shrink-0 flex items-center justify-center">
                            <svg className="h-10 w-10 -rotate-90" viewBox="0 0 36 36">
                              <circle
                                cx="18" cy="18" r="15.5"
                                fill="none"
                                stroke="var(--muted)"
                                strokeWidth="2.5"
                                opacity="0.3"
                              />
                              <circle
                                cx="18" cy="18" r="15.5"
                                fill="none"
                                stroke="var(--primary)"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeDasharray={`${(Math.min(progress, 100) / 100) * 97.39} 97.39`}
                                className="transition-all duration-500"
                              />
                            </svg>
                            <span className="absolute text-[10px] font-medium tabular-nums">
                              {Math.min(progress, 100)}%
                            </span>
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate group-hover/list:text-primary transition-colors">
                              {activity.novelTitle}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-muted-foreground">
                                第{activity.chapterIndex + 1}章{activity.totalChapters > 0 ? `/共${activity.totalChapters}章` : ''}
                              </span>
                              {activity.category && (
                                <>
                                  <span className="text-muted-foreground/30">·</span>
                                  <span
                                    className="text-[10px]"
                                    style={{ color: activity.category.color }}
                                  >
                                    {activity.category.name}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>

                          {/* Time */}
                          <span className="text-[10px] text-muted-foreground/50 shrink-0">
                            {formatRelativeTime(activity.lastReadAt)}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </>
          )
        )}
      </main>
    </div>
  );
}
