'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Zap, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

// ─── Types ─────────────────────────────────────────────────────────

interface SpeedPoint {
  date: string;
  words: number;
  chapters: number;
}

interface MovingAvgPoint {
  date: string;
  avg: number;
}

interface ApiResponse {
  trend: SpeedPoint[];
  movingAvg: MovingAvgPoint[];
  avgWordsPerDay: number;
}

// ─── Helpers ───────────────────────────────────────────────────────

function formatDateLabel(dateStr: string): string {
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  return `${m}/${d}`;
}

function formatWords(w: number): string {
  if (w >= 10000) return `${(w / 10000).toFixed(1)}万`;
  if (w >= 1000) return `${(w / 1000).toFixed(1)}k`;
  return String(w);
}

// ─── Custom Tooltip ───────────────────────────────────────────────

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: SpeedPoint & { avg?: number } }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 shadow-md text-xs">
      <p className="font-medium">{formatDateLabel(d.date)}</p>
      <p className="text-muted-foreground">{formatWords(d.words)} 字</p>
      <p className="text-muted-foreground">{d.chapters} 章</p>
      {d.avg !== undefined && (
        <p className="text-emerald-500 mt-0.5">7日均: {formatWords(d.avg)} 字</p>
      )}
    </div>
  );
}

// ─── Loading Skeleton ──────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Zap className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Skeleton className="h-4 w-24 rounded" />
      </div>
      <Skeleton className="w-full rounded-lg" style={{ height: '200px' }} />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function ReadingSpeedChart() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const res = await apiFetch<ApiResponse>('/api/stats/reading-speed', {
        signal,
        silent: true,
      });
      if (!signal?.aborted) setData(res);
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
            <span className="text-sm font-semibold">阅读量趋势</span>
          </div>
          <p className="text-sm text-muted-foreground">{error || '无法加载数据'}</p>
        </div>
      </motion.div>
    );
  }
  if (!data || data.trend.length === 0) {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <span className="text-sm font-semibold">阅读量趋势</span>
          </div>
          <div className="flex items-center justify-center py-10">
            <p className="text-sm text-muted-foreground/60">暂无阅读量数据</p>
          </div>
        </div>
      </motion.div>
    );
  }

  // Merge trend with moving average for chart
  const chartData = data.trend.map((t) => {
    const ma = data.movingAvg.find((m) => m.date === t.date);
    return { ...t, avg: ma?.avg || 0 };
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' as const }}
    >
      <div className="rounded-xl border bg-card p-5 card-glass card-border-glow hover-lift focus-ring-soft">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10">
              <Zap className="h-3.5 w-3.5 text-amber-500" />
            </div>
            <h2 className="text-sm font-semibold link-underline inline-block">阅读量趋势</h2>
          </div>
          <span className="text-[11px] text-muted-foreground">近 {data.trend.length} 天</span>
        </div>
        <div className="flex items-center gap-3 mb-3 text-xs text-muted-foreground">
          <span>日均 <strong className="text-foreground">{formatWords(data.avgWordsPerDay)}</strong> 字</span>
          {data.trend.length > 7 && (
            <span className="text-muted-foreground/30">·</span>
          )}
          {data.trend.length > 7 && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              7日均线
            </span>
          )}
        </div>
        <div style={{ height: '200px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: -10 }}>
              <defs>
                <linearGradient id="speed-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(35, 85%, 55%)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="hsl(35, 85%, 55%)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="avg-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(160, 60%, 45%)" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="hsl(160, 60%, 45%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
                interval={Math.max(0, Math.floor(chartData.length / 6) - 1)}
              />
              <YAxis
                tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={40}
                tickFormatter={formatWords}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine
                y={data.avgWordsPerDay}
                stroke="var(--muted-foreground)"
                strokeDasharray="4 4"
                opacity={0.4}
                label={{ value: '均值', position: 'right', fill: 'var(--muted-foreground)', fontSize: 10 }}
              />
              <Area
                type="monotone"
                dataKey="words"
                stroke="hsl(35, 85%, 55%)"
                strokeWidth={2}
                fill="url(#speed-grad)"
                animationDuration={1000}
              />
              <Area
                type="monotone"
                dataKey="avg"
                stroke="hsl(160, 60%, 45%)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                fill="url(#avg-grad)"
                animationDuration={1200}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </motion.div>
  );
}
