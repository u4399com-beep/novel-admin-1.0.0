'use client';

import { Trophy, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function RankingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  console.error('[Rankings ErrorBoundary]', error);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <h1 className="text-base font-semibold">排行榜</h1>
        </div>
      </header>
      <main className="flex flex-col items-center justify-center py-24 text-center">
        <div className="h-20 w-20 rounded-2xl bg-destructive/10 flex items-center justify-center mb-5">
          <Trophy className="h-10 w-10 text-destructive/50" />
        </div>
        <h2 className="text-lg font-semibold mb-2">加载失败</h2>
        <p className="text-sm text-muted-foreground mb-6 max-w-xs">
          排行榜数据加载出错
        </p>
        <Button variant="outline" onClick={reset} className="gap-1.5">
          <RotateCcw className="h-3.5 w-3.5" />
          重试
        </Button>
      </main>
    </div>
  );
}
