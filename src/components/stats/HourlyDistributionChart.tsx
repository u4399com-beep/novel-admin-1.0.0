'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Clock, AlertCircle } from 'lucide-react';
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

interface HourData {
  hour: number;
  count: number;
  label: string;
}

interface ApiResponse {
  distribution: HourData[];
}

// ─── Helpers ───────────────────────────────────────────────────────

function getBarColor(hour: number, count: number): string {
  if (count === 0) return 'var(--muted)';
  // Color gradient from cool (blue) to warm (orange) based on hour
  if (hour >= 6 && hour < 12) return 'hsl(210, 60%, 55%)';   // morning - blue
  if (hour >= 12 && hour < 18) return 'hsl(35, 85%, 55%)';   // afternoon - amber
  if (hour >= 18 && hour < 22) return 'hsl(25, 80%, 55%)';   // evening - orange
  return 'hsl(260, 50%, 60%)'; // night - purple
}

function getTimePeriod(hour: number): string {
  if (hour >= 0 && hour < 6) return '深夜';
  if (hour >= 6 && hour < 9) return '清晨';
  if (hour >= 9 && hour < 12) return '上午';
  if (hour >= 12 && hour < 14) return '中午';
  if (hour >= 14 && hour < 18) return '下午';
  if (hour >= 18 && hour < 21) return '傍晚';
  return '夜间';
}

// ─── Custom Tooltip ───────────────────────────────────────────────

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: HourData }> }) {
  if (!active || !payload?.length) return null;
  const data = payload[0].payload;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 shadow-md text-xs">
      <p className="font-medium">{data.label}</p>
      <p className="text-muted-foreground">
        {getTimePeriod(data.hour)} · {data.count} 次阅读
      </p>
    </div>
  );
}

// ─── Loading Skeleton ──────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Skeleton className="h-4 w-24 rounded" />
      </div>
      <Skeleton className="w-full rounded-lg" style={{ height: '200px' }} />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function HourlyDistributionChart() {
  const [data, setData] = useState<HourData[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const res = await apiFetch<ApiResponse>('/api/stats/hourly-distribution', {
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
            <span className="text-sm font-semibold">阅读时段分布</span>
          </div>
          <p className="text-sm text-muted-foreground">{error || '无法加载数据'}</p>
        </div>
      </motion.div>
    );
  }
  if (!data || data.every((d) => d.count === 0)) {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <span className="text-sm font-semibold">阅读时段分布</span>
          </div>
          <div className="flex items-center justify-center py-10">
            <p className="text-sm text-muted-foreground/60">暂无时段分布数据</p>
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
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/10">
              <Clock className="h-3.5 w-3.5 text-purple-500" />
            </div>
            <h2 className="text-sm font-semibold link-underline inline-block">阅读时段分布</h2>
          </div>
          <span className="text-[11px] text-muted-foreground">按小时统计</span>
        </div>
        <div style={{ height: '200px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
              <XAxis
                dataKey="hour"
                tickFormatter={(h) => `${String(h).padStart(2, '0')}`}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
                interval={1}
              />
              <YAxis
                tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={32}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.15 }} />
              <Bar
                dataKey="count"
                radius={[3, 3, 0, 0]}
                maxBarSize={18}
                animationDuration={800}
              >
                {data.map((entry) => (
                  <Cell
                    key={entry.hour}
                    fill={getBarColor(entry.hour, entry.count)}
                    opacity={entry.count > 0 ? 0.85 : 0.3}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* Period legend */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 justify-center">
          {[
            { label: '深夜', color: 'hsl(260, 50%, 60%)', range: '0-6' },
            { label: '清晨', color: 'hsl(210, 60%, 55%)', range: '6-9' },
            { label: '上午', color: 'hsl(210, 60%, 55%)', range: '9-12' },
            { label: '下午', color: 'hsl(35, 85%, 55%)', range: '12-18' },
            { label: '傍晚', color: 'hsl(25, 80%, 55%)', range: '18-21' },
            { label: '夜间', color: 'hsl(260, 50%, 60%)', range: '21-24' },
          ].map((p) => (
            <span key={p.label} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: p.color }} />
              {p.label} ({p.range})
            </span>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
