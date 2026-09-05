'use client';

import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { BookOpen, FileText, Type } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';

// ─── Animated Counter Hook ───────────────────────────────────
function useAnimatedCounter(target: number, duration = 1200) {
  const [count, setCount] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === 0) return;
    startTimeRef.current = null;

    function animate(timestamp: number) {
      if (startTimeRef.current === null) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.round(eased * target));
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(animate);
      }
    }

    frameRef.current = requestAnimationFrame(animate);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [target, duration]);

  return count;
}

// ─── Format large numbers ────────────────────────────────────
function formatStat(num: number): string {
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
  return num.toLocaleString();
}

// ─── Stats Data ─────────────────────────────────────────────
interface StatsData {
  totalNovels: number;
  totalChapters: number;
  totalWords: number;
}

export function QuickStatsWidget() {
  const [stats, setStats] = useState<StatsData | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    async function load() {
      try {
        // Fetch a small page of novels to get total count
        const data = await apiFetch<{ novels: unknown[]; total: number }>(
          '/api/public/novels?page=1&pageSize=1',
          { signal: ac.signal, silent: true, timeout: 5000 }
        );
        setStats({
          totalNovels: data.total || 0,
          totalChapters: 0, // Not available from list API, estimate
          totalWords: 0,
        });
      } catch { /* non-critical */ }
    }
    load();
    return () => ac.abort();
  }, []);

  if (!stats || stats.totalNovels === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 }}
      className="mx-auto max-w-7xl px-4 sm:px-6 mb-4"
    >
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          icon={<BookOpen className="h-4 w-4" />}
          label="小说总数"
          value={stats.totalNovels}
          color="text-blue-500 dark:text-blue-400"
          bgColor="bg-blue-50/60 dark:bg-blue-900/20"
        />
        <StatCard
          icon={<FileText className="h-4 w-4" />}
          label="章节总数"
          value={stats.totalChapters}
          color="text-emerald-500 dark:text-emerald-400"
          bgColor="bg-emerald-50/60 dark:bg-emerald-900/20"
        />
        <StatCard
          icon={<Type className="h-4 w-4" />}
          label="总字数"
          value={stats.totalWords}
          color="text-violet-500 dark:text-violet-400"
          bgColor="bg-violet-50/60 dark:bg-violet-900/20"
        />
      </div>
    </motion.div>
  );
}

// ─── Stat Card ──────────────────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  color,
  bgColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  bgColor: string;
}) {
  const animatedValue = useAnimatedCounter(value);
  const displayValue = value > 0 ? formatStat(animatedValue) : '—';

  return (
    <div className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border/50 ${bgColor} transition-colors`}>
      <div className={`${color} shrink-0`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-lg font-bold leading-tight">{displayValue}</p>
        <p className="text-[11px] text-muted-foreground/70 truncate">{label}</p>
      </div>
    </div>
  );
}
