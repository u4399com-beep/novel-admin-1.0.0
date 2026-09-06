'use client';

import { Progress } from '@/components/ui/progress';

interface TaskProgressProps {
  progress: number;
  isRunning: boolean;
  isCompleted: boolean;
}

export function TaskProgress({ progress, isRunning, isCompleted }: TaskProgressProps) {
  if (!(isRunning || (isCompleted && progress > 0 && progress < 100))) {
    return null;
  }

  const pct = Math.round(progress);

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">进度</span>
        <span className="text-xs font-medium tabular-nums">{pct}%</span>
      </div>
      <div className="relative">
        <Progress value={progress} className="h-2" />
        {/* Animated shimmer on running progress bars */}
        {isRunning && (
          <div className="absolute inset-0 overflow-hidden rounded-full">
            <div className="h-full w-1/3 animate-[shimmer_2s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          </div>
        )}
      </div>
      {/* Mini sparkline representation using progress segments */}
      {isRunning && pct > 0 && (
        <div className="mt-1.5 flex gap-px" aria-hidden="true">
          {Array.from({ length: 20 }, (_, i) => {
            const filled = i < Math.round(pct / 5);
            return (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
                  filled
                    ? 'bg-primary/70'
                    : 'bg-muted/40'
                }`}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
