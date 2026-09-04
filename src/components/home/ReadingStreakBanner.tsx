'use client';

import { useState, useEffect } from 'react';
import { Flame } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';

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

  // Don't show banner if no streak data or streak is 0
  if (streak === null || streak === 0) return null;

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 -mt-1 mb-4">
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-gradient-to-r from-amber-50/80 to-orange-50/80 dark:from-amber-950/30 dark:to-orange-950/30 border border-amber-200/50 dark:border-amber-800/30">
        <div className="flex items-center justify-center h-8 w-8 rounded-full bg-amber-100 dark:bg-amber-900/50">
          <Flame className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            连续阅读 {streak} 天
          </p>
          {todayWords > 0 && (
            <p className="text-xs text-amber-700/70 dark:text-amber-300/50">
              今日已读 {todayWords.toLocaleString()} 字
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 text-amber-600/60 dark:text-amber-400/40">
          {[...Array(Math.min(streak, 7))].map((_, i) => (
            <Flame key={i} className="h-3 w-3" />
          ))}
        </div>
      </div>
    </div>
  );
}
