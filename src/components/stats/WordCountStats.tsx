'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { FileText, BookOpen, TrendingUp, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Types ─────────────────────────────────────────────────────────

interface NovelWordStat {
  title: string;
  totalWords: number;
  avgWordsPerChapter: number;
  chapterCount: number;
}

interface WordCountData {
  totalWords: number;
  totalChapters: number;
  topNovels: NovelWordStat[];
}

// ─── Helpers ───────────────────────────────────────────────────────

function formatWordCount(count: number): string {
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)}亿`;
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)}万`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatCompact(count: number): string {
  return count.toLocaleString('en-US');
}

// ─── Loading Skeleton ──────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <Card className="card-glass card-border-glow">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <CardTitle className="text-sm">字数统计</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Big number skeleton */}
        <div className="flex items-end gap-3">
          <Skeleton className="h-10 w-36 rounded-lg" />
          <Skeleton className="h-4 w-20 rounded" />
        </div>
        {/* Stat row skeleton */}
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
        {/* Bar chart skeleton */}
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-3.5 w-24 shrink-0 rounded" />
              <Skeleton className="h-5 flex-1 rounded-full" />
              <Skeleton className="h-3.5 w-10 rounded" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Error State ───────────────────────────────────────────────────

function ErrorState({ message }: { message?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <Card className="card-glass card-border-glow">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/10">
              <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            </div>
            <CardTitle className="text-sm">字数统计</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {message || '无法加载字数统计数据'}
          </p>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── Mini Bar Chart ────────────────────────────────────────────────

function MiniBar({
  title,
  count,
  maxCount,
  index,
}: {
  title: string;
  count: number;
  maxCount: number;
  index: number;
}) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;

  return (
    <motion.div
      className="flex items-center gap-3 py-1.5 fade-in-up"
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.15 + index * 0.06, duration: 0.35 }}
    >
      <span className="text-xs text-muted-foreground w-28 shrink-0 truncate" title={title}>
        {title}
      </span>
      <div className="flex-1 h-5 rounded-full bg-muted/50 overflow-hidden stat-bar-animated">
        <motion.div
          className="h-full rounded-full fill"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.7, ease: 'easeOut', delay: 0.2 + index * 0.06 }}
          style={{
            background: `linear-gradient(90deg, var(--chart-blue) 0%, var(--chart-emerald) ${pct}%)`,
          }}
        />
      </div>
      <span className="text-xs font-medium tabular-nums w-12 text-right shrink-0">
        {formatWordCount(count)}
      </span>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function WordCountStats() {
  const [data, setData] = useState<WordCountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    apiFetch<WordCountData>('/api/stats/word-count', { silent: true })
      .then((res) => {
        setData(res);
        setError(false);
      })
      .catch(() => {
        setError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSkeleton />;
  if (error || !data) return <ErrorState />;

  const top5 = data.topNovels.slice(0, 5);
  const maxNovelWords = top5.length > 0 ? top5[0].totalWords : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      <Card className="card-glass card-border-glow hover-lift">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10">
              <FileText className="h-3.5 w-3.5 text-blue-500" />
            </div>
            <CardTitle className="text-sm link-underline inline-block">字数统计</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Total word count — big number */}
          <div className="fade-in-up">
            <p className="text-xs text-muted-foreground mb-1">全站总字数</p>
            <div className="flex items-end gap-2">
              <motion.span
                className="text-3xl font-bold tabular-nums tracking-tight"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
              >
                {formatCompact(data.totalWords)}
              </motion.span>
              <span className="text-sm text-muted-foreground mb-0.5">字</span>
            </div>
          </div>

          {/* Stat cards row */}
          <div className="grid grid-cols-2 gap-3 stagger-children">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.15 }}
              className="rounded-lg border bg-muted/20 p-3 transition-all hover:bg-muted/40 hover:border-primary/20"
            >
              <div className="flex items-center gap-1.5 mb-1.5">
                <BookOpen className="h-3.5 w-3.5 text-emerald-500" />
                <span className="text-[11px] text-muted-foreground">有字数章节</span>
              </div>
              <p className="text-base font-bold tabular-nums">
                {formatCompact(data.totalChapters)}
              </p>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.2 }}
              className="rounded-lg border bg-muted/20 p-3 transition-all hover:bg-muted/40 hover:border-primary/20"
            >
              <div className="flex items-center gap-1.5 mb-1.5">
                <TrendingUp className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-[11px] text-muted-foreground">小说数量</span>
              </div>
              <p className="text-base font-bold tabular-nums">
                {data.topNovels.length}
              </p>
            </motion.div>
          </div>

          {/* Top 5 novels mini bar chart */}
          {top5.length > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">
                  字数排行 Top 5
                </span>
              </div>
              <div className="space-y-0.5">
                {top5.map((novel, i) => (
                  <MiniBar
                    key={novel.title}
                    title={novel.title}
                    count={novel.totalWords}
                    maxCount={maxNovelWords}
                    index={i}
                  />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
