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

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">进度</span>
        <span className="text-xs font-medium tabular-nums">{Math.round(progress)}%</span>
      </div>
      <Progress value={progress} className="h-1.5" />
    </div>
  );
}
