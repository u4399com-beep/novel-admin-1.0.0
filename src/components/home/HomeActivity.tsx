'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { History, BookOpen, Flame } from 'lucide-react';
import { ContinueReading } from '@/components/home/ContinueReading';
import { getCoverGradient } from '@/lib/cover-gradient';
import { getSessionId } from '@/lib/reading-session';
import { apiFetch } from '@/lib/api-fetch';

// ─── Recently Viewed ──────────────────────────────────────────────

const RECENT_KEY = 'novel-recently-viewed';

interface RecentNovel {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  category: { name: string; color: string } | null;
  viewedAt: number;
}

function getRecentlyViewed(): RecentNovel[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch { return []; }
}

function clearRecentlyViewed() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(RECENT_KEY);
}

// ─── Today Reading Insight ─────────────────────────────────────────

interface StreakData {
  currentStreak: number;
  maxStreak: number;
  totalDays: number;
}

function getMotivationalMessage(streak: number): string | null {
  if (streak >= 30) return '月度连续阅读达人！';
  if (streak >= 14) return '两周连续阅读，坚持就是胜利！';
  if (streak >= 7) return '连续阅读一周，棒！';
  if (streak >= 3) return '三日连续阅读，继续保持！';
  if (streak >= 1) return '今日已开始阅读，好习惯！';
  return null;
}

function TodayReadingInsight() {
  const [streak, setStreak] = useState<number>(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const sessionId = getSessionId();

    if (!sessionId) {
      // No session — we still want to show "今日尚未阅读"
      // Use a microtask to avoid synchronous setState in effect
      queueMicrotask(() => setLoaded(true));
      return;
    }

    const ac = new AbortController();

    apiFetch<StreakData>(
      `/api/public/reading-streak?sessionId=${encodeURIComponent(sessionId)}`,
      { signal: ac.signal, silent: true },
    )
      .then((data) => {
        if (!ac.signal.aborted) {
          setStreak(data.currentStreak);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!ac.signal.aborted) setLoaded(true);
      });

    return () => ac.abort();
  }, []);

  if (!loaded) return null;

  const hasReadToday = streak > 0;
  const motivationalMsg = getMotivationalMessage(streak);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="rounded-xl border bg-muted/30 px-4 py-3 mt-3"
    >
      <div className="flex items-center gap-2 mb-2">
        <BookOpen className="h-3.5 w-3.5 text-muted-foreground/60" />
        <span className="text-xs font-medium text-muted-foreground">今日阅读洞察</span>
        {streak > 0 && (
          <div className="flex items-center gap-0.5 text-[10px] text-amber-500 dark:text-amber-400">
            <Flame className="h-3 w-3" />
            <span className="font-medium">{streak}天</span>
          </div>
        )}
      </div>

      <div>
        {hasReadToday ? (
          <p className="text-xs text-foreground/70">
            今日已阅读
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/60">今日尚未阅读</p>
        )}

        {motivationalMsg && (
          <p className="text-[11px] text-primary/70 mt-0.5 font-medium">{motivationalMsg}</p>
        )}
      </div>
    </motion.div>
  );
}

// ─── HomeActivity Component ────────────────────────────────────────

export function HomeActivity() {
  // Initialize empty on SSR, load from localStorage after mount to avoid hydration mismatch
  const [recentNovels, setRecentNovels] = useState<RecentNovel[]>([]);

  /* eslint-disable react-hooks/set-state-in-effect -- client hydration pattern */
  useEffect(() => {
    setRecentNovels(getRecentlyViewed());
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Listen for storage changes from other tabs
  useEffect(() => {
    const handler = () => setRecentNovels(getRecentlyViewed());
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return (
    <>
      {/* Continue Reading + Today's Insight */}
      <section className="border-b card-glass">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
          <ContinueReading />
          <TodayReadingInsight />
        </div>
      </section>

      {/* Recently Viewed */}
      {recentNovels.length > 0 && (
        <section className="border-b bg-muted/20 card-glass stagger-children">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">最近浏览</span>
                <span className="text-[10px] text-muted-foreground/60">{recentNovels.length}</span>
              </div>
              <button
                onClick={() => { clearRecentlyViewed(); setRecentNovels([]); }}
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors focus-ring-soft"
              >
                清除
              </button>
            </div>
            <div className="flex items-center gap-3 overflow-x-auto scrollbar-none pb-1">
              {recentNovels.slice(0, 8).map((rn) => (
                <Link
                  key={rn.id}
                  href={`/novels/${rn.id}`}
                  className="shrink-0 flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2 transition-all hover:shadow-sm hover:border-primary/30 group hover-lift tap-feedback hover-scale list-item-compact"
                >
                  <div className="h-8 w-6 rounded overflow-hidden shrink-0">
                    {rn.coverUrl ? (
                      <img src={rn.coverUrl} alt={rn.title} className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className={`h-full w-full bg-gradient-to-br ${getCoverGradient(rn.title)}`} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium line-clamp-1 group-hover:text-primary transition-colors">{rn.title}</p>
                    <p className="text-[10px] text-muted-foreground line-clamp-1">{rn.author}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
