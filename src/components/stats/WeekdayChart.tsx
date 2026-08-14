'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { CalendarDays, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';

// ─── Types ─────────────────────────────────────────────────────────

interface WeekdayData {
  dow: number;
  dayLabel: string;
  shortLabel: string;
  totalChapters: number;
  totalWords: number;
  activeDays: number;
}

interface ApiResponse {
  distribution: WeekdayData[];
}

// ─── Constants ──────────────────────────────────────────────────────

const COLORS = [
  'hsl(210, 60%, 55%)',  // 日
  'hsl(200, 55%, 55%)',  // 一
  'hsl(190, 55%, 50%)',  // 二
  'hsl(170, 55%, 48%)',  // 三
  'hsl(150, 50%, 45%)',  // 四
  'hsl(130, 50%, 48%)',  // 五
  'hsl(35, 85%, 55%)',   // 六 (weekend - warm)
];

// ─── Custom Tooltip ───────────────────────────────────────────────

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: WeekdayData }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const wordsStr = d.totalWords >= 10000
    ? `${(d.totalWords / 10000).toFixed(1)}万`
    : d.totalWords.toLocaleString();
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 shadow-md text-xs">
      <p className="font-medium">{d.dayLabel}</p>
      <p className="text-muted-foreground">{d.totalChapters} 章已读</p>
      <p className="text-muted-foreground">{wordsStr} 字</p>
      {d.activeDays > 0 && <p className="text-muted-foreground">活跃 {d.activeDays} 天</p>}
    </div>
  );
}

// ─── Loading Skeleton ──────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Skeleton className="h-4 w-24 rounded" />
      </div>
      <Skeleton className="w-full rounded-lg" style={{ height: '180px' }} />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function WeekdayChart() {
  const [data, setData] = useState<WeekdayData[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<'chapters' | 'words'>('chapters');

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const res = await apiFetch<ApiResponse>('/api/stats/weekday-distribution', {
        signal,
        silent: true,
      });
      if (!signal?.aborted) setData(res.distribution);
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
        <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/10">
              <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            </div>
            <span className="text-sm font-semibold">每周阅读分布</span>
          </div>
          <p className="text-sm text-muted-foreground">{error || '无法加载数据'}</p>
        </div>
      </motion.div>
    );
  }
  if (!data || data.every((d) => d.totalChapters === 0)) {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <span className="text-sm font-semibold">每周阅读分布</span>
          </div>
          <div className="flex items-center justify-center py-10">
            <p className="text-sm text-muted-foreground/60">暂无星期分布数据</p>
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
      <div className="rounded-xl border bg-card p-5 card-glass card-border-glow hover-lift focus-ring-soft">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10">
              <CalendarDays className="h-3.5 w-3.5 text-emerald-500" />
            </div>
            <h2 className="text-sm font-semibold link-underline inline-block">每周阅读分布</h2>
          </div>
          <button
            type="button"
            onClick={() => setMetric((m) => (m === 'chapters' ? 'words' : 'chapters'))}
            className={
              'text-[11px] px-2.5 py-1 rounded-md border transition-colors ' +
              (metric === 'words'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted/50 text-muted-foreground border-transparent hover:bg-muted')
            }
          >
            {metric === 'chapters' ? '章节' : '字数'}
          </button>
        </div>
        <div style={{ height: '180px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
              <XAxis
                dataKey="shortLabel"
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={32}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.15 }} />
              <Bar
                dataKey={metric === 'chapters' ? 'totalChapters' : 'totalWords'}
                radius={[6, 6, 0, 0]}
                maxBarSize={40}
                animationDuration={800}
              >
                {data.map((entry) => (
                  <Cell
                    key={entry.dow}
                    fill={COLORS[entry.dow]}
                    opacity={0.85}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </motion.div>
  );
}
