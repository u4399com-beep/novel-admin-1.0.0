'use client';

export interface StatsBarProps {
  contentProgress: { withContent: number; pct: number } | null;
  totalChapters: number;
}

export function StatsBar({ contentProgress, totalChapters }: StatsBarProps) {
  if (!contentProgress) return null;

  return (
    <div className="px-4 pt-3 space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>采集进度</span>
        <span>{contentProgress.withContent}/{totalChapters} 章 ({contentProgress.pct}%)</span>
      </div>
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 dark:from-emerald-600 dark:to-emerald-500 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${contentProgress.pct}%` }}
        />
      </div>
    </div>
  );
}
