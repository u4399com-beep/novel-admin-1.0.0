'use client';

import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Target, Flame, Loader2 } from 'lucide-react';
import { apiFetch, FetchError } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────

interface DailyReadingGoalProps {
  className?: string;
}

interface ReadingGoalData {
  date: string;
  chaptersRead: number;
  dailyGoal: number;
  percentage: number;
  streakDays: number;
}

// ─── Progress Ring ────────────────────────────────────────────────────

function ProgressRing({
  percentage,
  size = 72,
  strokeWidth = 5,
  color,
}: {
  percentage: number;
  size?: number;
  strokeWidth?: number;
  color: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(percentage, 100) / 100) * circumference;

  return (
    <svg width={size} height={size} className="-rotate-90" viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-muted/25"
      />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 0.8, ease: 'easeOut' as const }}
      />
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────────────────

export function DailyReadingGoal({ className }: DailyReadingGoalProps) {
  const [data, setData] = useState<ReadingGoalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    async function load() {
      try {
        const result = await apiFetch<ReadingGoalData>(
          '/api/reading-goals?date=today',
          { signal: controller.signal, silent: true, timeout: 8000 },
        );
        setData(result);
        setVisible(true);
      } catch (err) {
        // Silently hide if unauthenticated or network error
        if (err instanceof FetchError && (err.status === 401 || err.status === 403)) {
          setVisible(false);
        }
        // For other errors, still don't show anything noisy
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      controller.abort();
    };
  }, []);

  // Don't render anything if data is unavailable or loading
  if (!visible || (!data && !loading)) {
    return null;
  }

  if (loading || !data) {
    return (
      <div className={`flex items-center justify-center py-2 ${className ?? ''}`}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  const isCompleted = data.percentage >= 100;
  const ringColor = isCompleted ? 'var(--chart-emerald)' : 'var(--primary)';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4, ease: 'easeOut' as const }}
      className={`flex flex-col items-center gap-1.5 ${className ?? ''}`}
    >
      {/* Progress Ring */}
      <div className="relative">
        <ProgressRing percentage={data.percentage} color={ringColor} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-sm font-bold tabular-nums leading-none"
            style={{ color: ringColor }}
          >
            {data.percentage}%
          </span>
        </div>
      </div>

      {/* Chapter count and goal */}
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Flame className="h-3 w-3" />
        <span className="tabular-nums">
          {data.chaptersRead} / {data.dailyGoal} 章
        </span>
      </div>

      {/* Streak indicator */}
      {data.streakDays > 0 && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
          <Target className="h-2.5 w-2.5" />
          <span className="tabular-nums">连续 {data.streakDays} 天</span>
        </div>
      )}
    </motion.div>
  );
}
