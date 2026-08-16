'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BarChart3,
  ChevronUp,
  ChevronDown,
  BookOpen,
  Timer,
  AlertTriangle,
  Activity,
} from 'lucide-react';
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
} from 'recharts';

// ─── Types ─────────────────────────────────────────────────────────

interface ScrapeTaskStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  pendingTasks: number;
  cancelledTasks: number;
  successRate: number;
  totalBooksHarvested: number;
  totalChaptersHarvested: number;
  avgDuration: number; // seconds
  lastRunAt: string | null;
  dailyTrend: Array<{
    date: string;
    tasks: number;
    completed: number;
    failed: number;
    books: number;
    chapters: number;
  }>;
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatAvgDuration(seconds: number): string {
  if (seconds <= 0) return '暂无数据';
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0 && secs > 0) return `${minutes}分${secs}秒`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${secs}秒`;
}

function formatDateLabel(dateStr: string): string {
  // dateStr is "YYYY-MM-DD", show as "MM/DD"
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[1]}/${parts[2]}`;
  }
  return dateStr;
}

function getSuccessRateColor(rate: number): string {
  if (rate > 80) return 'var(--chart-emerald)';
  if (rate > 50) return 'var(--chart-amber)';
  return 'var(--chart-rose)';
}

// ─── Custom Tooltip ─────────────────────────────────────────────────

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { date: string; completed: number; failed: number; tasks: number } }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 shadow-md text-xs">
      <p className="font-medium">{d.date}</p>
      <p className="text-muted-foreground">任务 {d.tasks} 个</p>
      <p className="text-emerald-500">完成 {d.completed}</p>
      {d.failed > 0 && <p className="text-destructive">失败 {d.failed}</p>}
    </div>
  );
}

// ─── Success Rate Ring ──────────────────────────────────────────────

function SuccessRateRing({ rate }: { rate: number }) {
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (rate / 100) * circumference;
  const color = getSuccessRateColor(rate);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-[90px] h-[90px]">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 80 80">
          {/* Background circle */}
          <circle
            cx="40"
            cy="40"
            r={radius}
            fill="none"
            stroke="var(--muted)"
            strokeWidth="6"
            opacity={0.3}
          />
          {/* Progress circle */}
          <circle
            cx="40"
            cy="40"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-1000 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-lg font-bold tabular-nums" style={{ color }}>
            {rate}%
          </span>
        </div>
      </div>
      <span className="text-[11px] text-muted-foreground">任务成功率</span>
    </div>
  );
}

// ─── Loading Skeleton ──────────────────────────────────────────────

function StatsSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glass card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <Skeleton className="h-4 w-4 rounded" />
        <Skeleton className="h-4 w-24 rounded" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border bg-muted/30 p-3 animate-pulse">
            <div className="h-3 w-16 bg-muted rounded mb-2" />
            <div className="h-6 w-20 bg-muted rounded mb-1" />
            <div className="h-3 w-12 bg-muted rounded" />
          </div>
        ))}
      </div>
      <Skeleton className="w-full h-[200px] rounded-lg mt-4" />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function ScrapeStatsDashboard() {
  const [stats, setStats] = useState<ScrapeTaskStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(false);
      const data = await apiFetch<ScrapeTaskStats>('/api/scrape-tasks/stats', {
        signal,
        silent: true,
      });
      if (!signal?.aborted) setStats(data);
    } catch {
      if (!signal?.aborted) setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchStats(ac.signal);
    return () => ac.abort();
  }, [fetchStats]);

  if (loading) return <StatsSkeleton />;

  if (error || !stats) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-xl border bg-card p-5 card-glass card-border-glow"
      >
        <div className="flex items-center gap-2 mb-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">采集统计</h2>
        </div>
        <p className="text-sm text-muted-foreground">无法加载统计数据</p>
      </motion.div>
    );
  }

  const chartData = stats.dailyTrend.map((d) => ({
    ...d,
    dateLabel: formatDateLabel(d.date),
  }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="rounded-xl border bg-card card-glass card-border-glow"
    >
      {/* Header with toggle */}
      <div className="flex items-center justify-between px-5 pt-4 pb-0">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">采集统计</h2>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted/50"
        >
          {collapsed ? (
            <>
              <ChevronDown className="h-3.5 w-3.5" />
              展开统计
            </>
          ) : (
            <>
              <ChevronUp className="h-3.5 w-3.5" />
              收起统计
            </>
          )}
        </button>
      </div>

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ height: 'auto', opacity: 1 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="p-5 pt-4 space-y-4">
              {/* Summary Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Total Tasks + Success Rate */}
                <div className="rounded-lg border bg-muted/20 p-3 transition-all hover:bg-muted/40 hover:border-primary/20">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground">总任务数</span>
                  </div>
                  <p className="text-base font-bold tabular-nums">{stats.totalTasks}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    成功率{' '}
                    <span style={{ color: getSuccessRateColor(stats.successRate) }}>
                      {stats.successRate}%
                    </span>
                  </p>
                </div>

                {/* Books Harvested */}
                <div className="rounded-lg border bg-muted/20 p-3 transition-all hover:bg-muted/40 hover:border-primary/20">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <BookOpen className="h-3.5 w-3.5" style={{ color: 'var(--chart-emerald)' }} />
                    <span className="text-[11px] text-muted-foreground">采集书籍</span>
                  </div>
                  <p className="text-base font-bold tabular-nums">{stats.totalBooksHarvested}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {stats.totalChaptersHarvested} 章节
                  </p>
                </div>

                {/* Average Duration */}
                <div className="rounded-lg border bg-muted/20 p-3 transition-all hover:bg-muted/40 hover:border-primary/20">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Timer className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground">平均耗时</span>
                  </div>
                  <p className="text-base font-bold tabular-nums">
                    {formatAvgDuration(stats.avgDuration)}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {stats.completedTasks} 已完成
                  </p>
                </div>

                {/* Failed Tasks */}
                <div className="rounded-lg border bg-muted/20 p-3 transition-all hover:bg-muted/40 hover:border-primary/20">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <AlertTriangle className="h-3.5 w-3.5" style={{ color: stats.failedTasks > 0 ? 'var(--destructive)' : 'var(--muted-foreground)' }} />
                    <span className="text-[11px] text-muted-foreground">失败任务</span>
                  </div>
                  <p
                    className="text-base font-bold tabular-nums"
                    style={{ color: stats.failedTasks > 0 ? 'var(--destructive)' : undefined }}
                  >
                    {stats.failedTasks}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {stats.runningTasks > 0 ? `${stats.runningTasks} 运行中` : `${stats.pendingTasks} 等待中`}
                  </p>
                </div>
              </div>

              {/* Chart + Success Ring Row */}
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4">
                {/* Trend Chart */}
                <div className="rounded-lg border bg-muted/10 p-3">
                  {chartData.length > 0 && chartData.some((d) => d.tasks > 0) ? (
                    <div style={{ maxHeight: '200px', height: '200px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 4, left: -10 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                          <XAxis
                            dataKey="dateLabel"
                            tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                            axisLine={{ stroke: 'var(--border)' }}
                            tickLine={false}
                          />
                          <YAxis
                            tick={{ fill: 'var(--muted-foreground)', fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            width={28}
                          />
                          <Tooltip content={<TrendTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.15 }} />
                          <Bar
                            dataKey="completed"
                            stackId="tasks"
                            fill="var(--chart-emerald)"
                            radius={[0, 0, 0, 0]}
                            maxBarSize={24}
                            animationDuration={800}
                          />
                          <Bar
                            dataKey="failed"
                            stackId="tasks"
                            fill="var(--chart-rose)"
                            radius={[4, 4, 0, 0]}
                            maxBarSize={24}
                            animationDuration={800}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-[200px]">
                      <p className="text-sm text-muted-foreground/60">暂无近期任务数据</p>
                    </div>
                  )}
                </div>

                {/* Success Rate Ring */}
                <div className="flex items-center justify-center lg:justify-end">
                  <SuccessRateRing rate={stats.successRate} />
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
