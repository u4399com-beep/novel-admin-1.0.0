'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Radar, Activity, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { getSessionId } from '@/lib/reading-session';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from 'recharts';

// ─── Types ─────────────────────────────────────────────────────────

interface RadarData {
  radar: {
    consistency: number;
    volume: number;
    speed: number;
    diversity: number;
    completion: number;
  };
  summary: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const DIMENSION_LABELS: Record<string, string> = {
  consistency: '连续性',
  volume: '阅读量',
  speed: '阅读速度',
  diversity: '多样性',
  completion: '完成率',
};

const READING_TYPE_LABELS: Record<string, string> = {
  consistency: '坚持不懈型',
  volume: '博览群书型',
  speed: '一目十行型',
  diversity: '涉猎广泛型',
  completion: '有始有终型',
};

// ─── Loading Skeleton ──────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 card-glow card-border-glow">
      <div className="flex items-center gap-2 mb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted">
          <Radar className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <Skeleton className="h-4 w-32 rounded" />
      </div>
      <Skeleton className="w-full rounded-lg" style={{ height: '260px' }} />
      <Skeleton className="h-6 w-28 rounded mx-auto mt-3" />
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export function ReadingRadarChart() {
  const [data, setData] = useState<RadarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      setError(null);
      const sid = getSessionId();
      const res = await apiFetch<RadarData>(`/api/stats/reading-radar?sessionId=${encodeURIComponent(sid)}`, {
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
        <div className="rounded-xl border bg-card p-5 card-glow card-border-glow">
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/10">
              <AlertCircle className="h-3.5 w-3.5 text-destructive" />
            </div>
            <span className="text-sm font-semibold">阅读能力雷达图</span>
          </div>
          <p className="text-sm text-muted-foreground">{error || '无法加载数据'}</p>
        </div>
      </motion.div>
    );
  }

  if (!data) return null;

  // Convert radar object to recharts data array
  const chartData = Object.entries(data.radar).map(([key, value]) => ({
    dimension: DIMENSION_LABELS[key] || key,
    value,
    key,
  }));

  // Determine highest dimension
  const entries = Object.entries(data.radar);
  const highestKey = entries.sort(([, a], [, b]) => b - a)[0]?.[0] || '';
  const typeLabel = data.summary || READING_TYPE_LABELS[highestKey] || '';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' as const }}
    >
      <div className="rounded-xl border bg-card p-5 card-glow card-border-glow hover-lift focus-ring-soft">
        <div className="flex items-center gap-2 mb-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10">
            <Radar className="h-3.5 w-3.5 text-violet-500" />
          </div>
          <h2 className="text-sm font-semibold link-underline inline-block">阅读能力雷达图</h2>
        </div>

        <div style={{ height: '220px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart cx="50%" cy="50%" outerRadius="72%" data={chartData}>
              <PolarGrid
                stroke="var(--border)"
                opacity={0.5}
              />
              <PolarAngleAxis
                dataKey="dimension"
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
              />
              <Radar
                name="阅读能力"
                dataKey="value"
                stroke="hsl(var(--primary))"
                fill="hsl(var(--primary))"
                fillOpacity={0.3}
                strokeWidth={2}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Reading type label */}
        {typeLabel && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3, duration: 0.3 }}
            className="flex items-center justify-center mt-2"
          >
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary">
              <Activity className="h-3 w-3" />
              {typeLabel}
            </span>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
