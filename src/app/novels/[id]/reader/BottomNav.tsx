'use client';

import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DailyReadingGoal } from '@/components/DailyReadingGoal';

function formatReadDuration(seconds: number): string {
  if (seconds < 60) return '';
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}min`;
}

export interface BottomNavProps {
  hasPrev: boolean;
  hasNext: boolean;
  loadingChapter: boolean;
  onGoToChapter: (direction: 'prev' | 'next') => void;
  readDuration: number;
}

export function BottomNav({
  hasPrev,
  hasNext,
  loadingChapter,
  onGoToChapter,
  readDuration,
}: BottomNavProps) {
  return (
    <div className="shrink-0 border-t px-4 py-2.5 flex items-center justify-between bg-muted/30 glass-card">
      <Button
        variant="outline"
        size="sm"
        disabled={!hasPrev || loadingChapter}
        onClick={() => onGoToChapter('prev')}
        className="h-8 tap-feedback press-effect chapter-nav-btn"
      >
        <ChevronLeft className="h-4 w-4 mr-1" />
        上一章
      </Button>
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-muted-foreground hidden sm:block kbd-hint-bar rounded-md px-2.5 py-1">
          ← → J/K 翻页 · ↑↓ 滚动 · B 书签 · F 全屏 · ? 帮助
        </span>
        <DailyReadingGoal />
        {formatReadDuration(readDuration) && (
          <span className="text-xs text-muted-foreground/60 flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatReadDuration(readDuration)}
          </span>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!hasNext || loadingChapter}
        onClick={() => onGoToChapter('next')}
        className="h-8 tap-feedback press-effect chapter-nav-btn"
      >
        下一章
        <ChevronRight className="h-4 w-4 ml-1" />
      </Button>
    </div>
  );
}
