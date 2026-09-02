'use client';

import { Flame, Trophy } from 'lucide-react';

// ─── Motivational messages based on streak length ─────────────

const STREAK_MILESTONES: { min: number; label: string; gradientClass: string }[] = [
  { min: 100, label: '书海无涯', gradientClass: 'text-gradient-primary' },
  { min: 60, label: '博览群书', gradientClass: 'text-gradient-primary' },
  { min: 30, label: '学富五车', gradientClass: 'text-gradient-fire' },
  { min: 14, label: '勤学不辍', gradientClass: 'text-gradient-amber' },
  { min: 7, label: '渐入佳境', gradientClass: 'text-gradient-amber' },
  { min: 3, label: '初窥门径', gradientClass: 'text-gradient-fire' },
];

function getStreakMilestone(streak: number) {
  for (const m of STREAK_MILESTONES) {
    if (streak >= m.min) return m;
  }
  return null;
}

// ─── Component ──────────────────────────────────────────────────

interface ReadingStreakProps {
  data: {
    currentStreak: number;
    maxStreak: number;
    totalDays: number;
  };
}

export default function ReadingStreak({ data }: ReadingStreakProps) {
  const { currentStreak, maxStreak, totalDays } = data;
  const isActive = currentStreak > 0;
  const milestone = getStreakMilestone(currentStreak);

  return (
    <div className="card-glow card-border-glow inset-shadow rounded-2xl p-5 flex flex-col items-center gap-3 bg-background/80 backdrop-blur-sm">
      {/* Current streak - hero area */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <Flame
            className={`shrink-0 ${isActive ? 'text-orange-500 flame-pulse' : 'text-muted-foreground/40'}`}
            size={28}
            strokeWidth={2.2}
          />
          <span className={`stat-value text-4xl font-extrabold tracking-tight tabular-nums ${isActive ? 'text-gradient-fire' : ''}`}>
            {currentStreak}
          </span>
          <span className="text-base font-medium text-muted-foreground">天</span>
        </div>
        <span className="text-xs font-medium text-muted-foreground">当前连续</span>

        {/* Motivational milestone badge */}
        {milestone && (
          <span className={`mt-0.5 text-[11px] font-semibold tracking-wide ${milestone.gradientClass} streak-badge-shimmer`}>
            {milestone.label}
          </span>
        )}
      </div>

      {/* Divider */}
      <div className="w-full h-px bg-border" />

      {/* Bottom stats */}
      <div className="flex w-full items-center justify-around text-center">
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex items-center gap-1">
            <Trophy
              className="text-amber-500"
              size={14}
              strokeWidth={2}
            />
            <span className="stat-value text-sm font-semibold tabular-nums">{maxStreak}</span>
          </div>
          <span className="text-[11px] text-muted-foreground">最长连续</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="stat-value text-sm font-semibold tabular-nums">{totalDays}</span>
          <span className="text-[11px] text-muted-foreground">累计天数</span>
        </div>
      </div>
    </div>
  );
}
