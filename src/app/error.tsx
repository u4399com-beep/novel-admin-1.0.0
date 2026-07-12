'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[ErrorBoundary] Uncaught error:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
        <h2 className="text-xl font-semibold text-foreground">页面出现了问题</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {error.message || '发生了意外错误，请尝试刷新页面。'}
        </p>
        {error.digest && (
          <p className="text-xs text-muted-foreground/60 font-mono">
            错误ID: {error.digest}
          </p>
        )}
        <Button onClick={reset} className="gap-2">
          <RotateCcw className="h-4 w-4" />
          重试
        </Button>
      </div>
    </div>
  );
}