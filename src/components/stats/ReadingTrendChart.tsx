'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Activity, AlertCircle } from 'lucide-react';
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
} from 'recharts';

// ─── Types ─────────────────────────────────────────────────────────

interface TrendPoint {
  date: string;
  chapters: number;
  words: number;
}

interface TrendData {
  trend: TrendPoint[];
}

// ─── Constants ──────────────────────────────────────────────────────

const DAY_OPTIONS = [
  { value: '7', label: '7天' },
  { value: '30', label: '30天' },
  { value: '90', label: '90天' },
] as const;

// ─── Helpers ───────────────────────────────────────────────────────

function formatDateLabel(dateStr: string): string {
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  return `${m}/${d}`;
}

function formatWordsShort(w: number): string {
  return (w / 1000).toFixed(1);
}

// ─── Custom Tooltip ───────────────────────────────────────────────

function CustomTooltip({
  active,
  payload,
  showWords,
}: {
  active?: boolean;
  payload?: Array<{ payload: TrendPoint }>;
  showWords: boolean;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 shadow-md text-xs">
      <p className="font-medium">{formatDateLabel(d.date)}</p>
      {showWords ? (
        <p className="text-muted-foreground">{formatWordsShort(d.words)}千字</p>
      ) : (
        <p className="text-muted-foreground">{d.chapters} 章</p>
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
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Skeleton className="h-4 w-20 rounded" />
      </div>
      <Skeleton className="w-full rounded-lg" style={{ height: '180px' }} />
    </div>
  );
}

// ─── Error State ───────────────────────────────────────────────────

function ErrorState({ message }: { message?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/10">
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          </div>
          <span className="text-sm font-semibold">阅读趋势</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {message || '无法加载阅读趋势数据'}
        </p>
      </div>
    </motion.div>
  );
}

// ─── Empty State ───────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <span className="text-sm font-semibold link-underline inline-block">阅读趋势</span>
      </div>
      <div className="flex items-center justify-center" style={{ height: '180px' }}>
        <p className="text-sm text-muted-foreground/60">暂无阅读趋势数据</p>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function ReadingTrendChart() {
  const [data, setData] = useState<TrendPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showWords, setShowWords] = useState(false);
  const [days, setDays] = useState<string>('30');

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const res = await apiFetch<TrendData>(`/api/stats/reading-trend?days=${days}`, {
        signal,
        silent: true,
      });
      if (!signal?.aborted) {
        setData(res.trend);
      }
    } catch (err) {
      if (!signal?.aborted) {
        setError(err instanceof Error ? err.message : '加载失败');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  if (loading) return <LoadingSkeleton />;
  if (error) return <ErrorState message={error} />;
  if (!data || data.length === 0) return <EmptyState />;

  const yUnit = showWords ? '千字' : '章';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' as const }}
    >
      <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
        {/* Title row */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <h2 className="text-sm font-semibold link-underline inline-block">
              阅读趋势
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Day range toggle */}
            {DAY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDays(opt.value)}
                className={
                  'text-[11px] px-2 py-0.5 rounded-md border transition-colors ' +
                  (days === opt.value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-transparent text-muted-foreground border-transparent hover:bg-muted')
                }
              >
                {opt.label}
              </button>
            ))}
            <span className="text-muted-foreground/30 mx-1">|</span>
            <button
              type="button"
              onClick={() => setShowWords((v) => !v)}
              className={
                'text-[11px] px-2.5 py-1 rounded-md border transition-colors ' +
                (showWords
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/50 text-muted-foreground border-transparent hover:bg-muted')
              }
            >
              {showWords ? '千字' : '章节'}
            </button>
          </div>
        </div>

        {/* Recharts AreaChart */}
        <div style={{ height: '180px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: -10 }}>
              <defs>
                <linearGradient id="trend-gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDateLabel}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
                interval={Math.max(0, Math.floor(data.length / 6) - 1)}
              />
              <YAxis
                tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={32}
              />
              <Tooltip
                content={<CustomTooltip showWords={showWords} />}
              />
              <Area
                type="monotone"
                dataKey={showWords ? 'words' : 'chapters'}
                stroke="var(--primary)"
                strokeWidth={2}
                fill="url(#trend-gradient)"
                animationDuration={1000}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </motion.div>
  );
}
