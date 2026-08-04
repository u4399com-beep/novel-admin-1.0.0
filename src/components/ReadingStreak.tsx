'use client';

import { Flame, Trophy } from 'lucide-react';

interface ReadingStreakProps {
  data: {
    currentStreak: number;
    maxStreak: number;
    totalDays: number;
  };
}

export default function ReadingStreak({ data }: ReadingStreakProps) {
  const { currentStreak, maxStreak, totalDays } = data;

  return (
    <div className="card-glow card-border-glow inset-shadow rounded-2xl p-5 flex flex-col items-center gap-3 bg-background/80 backdrop-blur-sm">
      {/* Current streak - hero area */}
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-2">
          <Flame
            className="shrink-0 text-orange-500"
            size={28}
            strokeWidth={2.2}
          />
          <span className="stat-value text-4xl font-extrabold tracking-tight tabular-nums">
            {currentStreak}
          </span>
          <span className="text-base font-medium text-muted-foreground">天</span>
        </div>
        <span className="text-xs font-medium text-muted-foreground">当前连续</span>
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
