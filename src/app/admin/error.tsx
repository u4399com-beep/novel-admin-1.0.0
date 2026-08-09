'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/stores/app-store';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const setCurrentView = useAppStore((s) => s.setCurrentView);

  useEffect(() => {
    console.error('[Admin ErrorBoundary]', error);
  }, [error]);

  return (
    <div role="alert" className="min-h-[400px] flex items-center justify-center bg-background p-4">
      <div className="flex flex-col items-center gap-4 max-w-sm text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border bg-destructive/5">
          <AlertTriangle className="h-8 w-8 text-destructive/80" strokeWidth={1.5} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold text-foreground">
            管理面板出错
          </h2>
          <p className="text-sm text-muted-foreground">
            {process.env.NODE_ENV === 'development'
              ? error.message
              : '管理面板发生了意外错误，请尝试刷新。'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={reset} size="sm" className="gap-1.5">
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentView('dashboard')}
          >
            返回仪表盘
          </Button>
        </div>
      </div>
    </div>
  );
}
