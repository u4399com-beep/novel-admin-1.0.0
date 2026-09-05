'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { apiFetch } from '@/lib/api-fetch';

// ─── Mini Calendar Heatmap for last 7 days ─────────────────────
function StreakHeatmap({ streak }: { streak: number }) {
  // Generate last 7 days; if streak >= n days back, the cell is filled
  const days = Array.from({ length: 7 }, (_, i) => {
    const daysAgo = 6 - i; // 6=leftmost (oldest), 0=rightmost (today)
    return daysAgo < streak;
  });
  const dayLabels = ['一', '二', '三', '四', '五', '六', '日'];

  return (
    <div className="flex items-center gap-0.5">
      {days.map((active, i) => (
        <motion.div
          key={i}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.5 + i * 0.06, duration: 0.2, type: 'spring', stiffness: 400 }}
          className="group relative"
        >
          <div
            className={`h-4 w-4 rounded-[3px] transition-colors ${
              active
                ? 'bg-amber-400 dark:bg-amber-500'
                : 'bg-amber-100 dark:bg-amber-900/30'
            }`}
          />
          {/* Tooltip on hover */}
          <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-[9px] text-amber-700 dark:text-amber-300 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
            {dayLabels[i]}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

// ─── Detailed Flame SVG ──────────────────────────────────────
function DetailedFlame({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2C12 2 8 6 8 11C8 14 9.5 16 12 16C14.5 16 16 14 16 11C16 6 12 2 12 2Z" opacity="0.3" />
      <path d="M12 6C12 6 10 9 10 12C10 14 10.8 15 12 15C13.2 15 14 14 14 12C14 9 12 6 12 6Z" opacity="0.6" />
      <path d="M12 9C12 9 11.2 11 11.2 12.5C11.2 13.5 11.5 14 12 14C12.5 14 12.8 13.5 12.8 12.5C12.8 11 12 9 12 9Z" />
    </svg>
  );
}

// ─── Milestone Badges ────────────────────────────────────────
function MilestoneBadges({ streak }: { streak: number }) {
  const milestones = [
    { days: 7, label: '7天', emoji: '🔥' },
    { days: 30, label: '30天', emoji: '🏆' },
    { days: 100, label: '100天', emoji: '💎' },
  ];

  return (
    <div className="flex items-center gap-1">
      {milestones.map((m) => (
        <span
          key={m.days}
          className={`inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full font-medium transition-all ${
            streak >= m.days
              ? 'bg-amber-200/80 dark:bg-amber-800/50 text-amber-800 dark:text-amber-200 scale-100'
              : 'bg-amber-100/40 dark:bg-amber-900/20 text-amber-600/40 dark:text-amber-400/30 scale-95'
          }`}
        >
          {m.emoji} {m.label}
        </span>
      ))}
    </div>
  );
}

export function ReadingStreakBanner() {
  const [streak, setStreak] = useState<number | null>(null);
  const [todayWords, setTodayWords] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    async function load() {
      try {
        const data = await apiFetch<{ streak?: number; todayWords?: number }>(
          '/api/public/reading-streak',
          { signal: ac.signal, silent: true, timeout: 5000 }
        );
        if (typeof data.streak === 'number') setStreak(data.streak);
        if (typeof data.todayWords === 'number') setTodayWords(data.todayWords);
      } catch { /* non-critical */ }
    }
    load();
    return () => ac.abort();
  }, []);

  if (streak === null || streak === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="mx-auto max-w-7xl px-4 sm:px-6 -mt-1 mb-4"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4 px-4 py-3 rounded-lg bg-gradient-to-r from-amber-50/80 to-orange-50/80 dark:from-amber-950/30 dark:to-orange-950/30 border border-amber-200/50 dark:border-amber-800/30 streak-border-glow">
        <div className="flex items-center gap-3">
          {/* Detailed flame icon */}
          <div className="flex items-center justify-center h-9 w-9 rounded-full bg-amber-100 dark:bg-amber-900/50 flame-icon-pulse">
            <DetailedFlame className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              连续阅读 <span className="text-base font-bold">{streak}</span> 天
            </p>
            {todayWords > 0 && (
              <p className="text-xs text-amber-700/70 dark:text-amber-300/50">
                今日已读 {todayWords.toLocaleString()} 字
              </p>
            )}
          </div>
        </div>

        {/* Mini heatmap */}
        <div className="flex items-center gap-2 sm:ml-auto">
          <StreakHeatmap streak={streak} />
        </div>

        {/* Milestone badges */}
        <MilestoneBadges streak={streak} />
      </div>
    </motion.div>
  );
}
