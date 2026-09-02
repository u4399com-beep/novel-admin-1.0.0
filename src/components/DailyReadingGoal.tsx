'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Target, Flame, Loader2, PartyPopper } from 'lucide-react';
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

// ─── Encouraging messages ────────────────────────────────────────────

const GOAL_MESSAGES = [
  '今日目标达成，太棒了！',
  '阅读目标已完成，继续加油！',
  '完美达成！你是阅读达人！',
  '今日阅读目标已达成！',
];

function getGoalMessage(): string {
  return GOAL_MESSAGES[Math.floor(Math.random() * GOAL_MESSAGES.length)];
}

// ─── CSS-only Progress Ring ─────────────────────────────────────────

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
  const clampedPct = Math.min(percentage, 100);
  const offset = circumference - (clampedPct / 100) * circumference;

  return (
    <svg
      width={size}
      height={size}
      className="-rotate-90 progress-ring-pulse"
      viewBox={`0 0 ${size} ${size}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-muted/25"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        style={{
          '--ring-circumference': `${circumference}`,
          '--ring-target-offset': `${offset}`,
          strokeDashoffset: offset,
        } as React.CSSProperties}
        className="transition-all duration-1000 ease-out"
      />
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────────────────

export function DailyReadingGoal({ className }: DailyReadingGoalProps) {
  const [data, setData] = useState<ReadingGoalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);
  const [goalJustMet, setGoalJustMet] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const goalMessage = useMemo(() => getGoalMessage(), []);

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
        // Trigger celebration if goal is met
        if (result.percentage >= 100) {
          // Slight delay so the ring animation plays first
          setTimeout(() => setGoalJustMet(true), 800);
        }
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
      <div className={`relative ${goalJustMet ? 'goal-celebrate' : ''}`}>
        <ProgressRing percentage={data.percentage} color={ringColor} />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={`text-sm font-bold tabular-nums leading-none ${isCompleted ? 'text-gradient-emerald' : ''}`}
            style={!isCompleted ? { color: ringColor } : undefined}
          >
            {data.percentage}%
          </span>
        </div>
      </div>

      {/* Chapter count and goal */}
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Flame className={`h-3 w-3 ${isCompleted ? 'text-emerald-500' : ''}`} />
        <span className="tabular-nums">
          {data.chaptersRead} / {data.dailyGoal} 章
        </span>
      </div>

      {/* Goal met encouraging message */}
      {isCompleted && goalJustMet && (
        <motion.p
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
        >
          <PartyPopper className="h-3 w-3" />
          {goalMessage}
        </motion.p>
      )}

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
