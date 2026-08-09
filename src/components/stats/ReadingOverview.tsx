'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  BookOpen,
  Clock,
  TrendingUp,
  Target,
  Flame,
  Star,
  Timer,
  BarChart3,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';

interface ReadingOverviewStats {
  totalReadingTime: number;
  totalWordsRead: number;
  totalChaptersRead: number;
  novelsCompleted: number;
  avgWordsPerSession: number;
  readingStreak: number;
  favoriteGenre: string | null;
  mostActiveHour: number;
}

interface StatItem {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  accent?: string;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`;
}

function formatWordCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万字`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}千字`;
  return `${count}字`;
}

export function ReadingOverview() {
  const [stats, setStats] = useState<ReadingOverviewStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    apiFetch<ReadingOverviewStats>('/api/stats/reading', { signal: ac.signal })
      .then((data) => {
        if (!ac.signal.aborted) setStats(data);
      })
      .catch(() => { if (!ac.signal.aborted) setError(true); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
        <div className="flex items-center gap-2 mb-4">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">阅读总览</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border bg-muted/30 p-3 animate-pulse">
              <div className="h-4 w-16 bg-muted rounded mb-2" />
              <div className="h-6 w-20 bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border bg-card p-5 card-glass card-border-glow"
      >
        <div className="flex items-center gap-2 mb-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">阅读总览</h2>
        </div>
        <p className="text-sm text-muted-foreground">无法加载详细统计数据</p>
      </motion.div>
    );
  }

  const statItems: StatItem[] = [
    {
      icon: Clock,
      label: '总阅读时长',
      value: formatMinutes(stats.totalReadingTime),
      accent: 'var(--chart-blue)',
    },
    {
      icon: BookOpen,
      label: '总阅读字数',
      value: formatWordCount(stats.totalWordsRead),
      accent: 'var(--chart-emerald)',
    },
    {
      icon: Target,
      label: '已读章节',
      value: stats.totalChaptersRead.toLocaleString(),
    },
    {
      icon: Star,
      label: '读完书籍',
      value: String(stats.novelsCompleted),
      accent: 'var(--chart-amber)',
    },
    {
      icon: TrendingUp,
      label: '平均每次阅读',
      value: formatWordCount(stats.avgWordsPerSession),
    },
    {
      icon: Flame,
      label: '连续阅读',
      value: `${stats.readingStreak}天`,
      accent: 'var(--chart-rose)',
    },
    {
      icon: Star,
      label: '最爱分类',
      value: stats.favoriteGenre || '暂无',
    },
    {
      icon: Timer,
      label: '最活跃时段',
      value: `${stats.mostActiveHour}:00`,
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border bg-card p-5 card-glass card-border-glow hover-lift focus-ring-soft"
    >
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold link-underline inline-block">阅读总览</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 stagger-children">
        {statItems.map((item) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-lg border bg-muted/20 p-3 transition-all hover:bg-muted/40 hover:border-primary/20"
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <span style={item.accent ? { color: item.accent } : { color: 'var(--muted-foreground)' }}>
                <item.icon className="h-3.5 w-3.5" />
              </span>
              <span className="text-[11px] text-muted-foreground">{item.label}</span>
            </div>
            <p className="text-base font-bold tabular-nums truncate">{item.value}</p>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
