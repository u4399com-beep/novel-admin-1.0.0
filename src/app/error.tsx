'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

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
    <div role="alert" className="min-h-screen flex items-center justify-center bg-background p-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="flex flex-col items-center gap-5 max-w-md text-center"
      >
        {/* Decorative icon with glow */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-28 w-28 rounded-full bg-destructive/8 blur-2xl" />
          </div>
          <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl border bg-gradient-to-br from-destructive/5 to-destructive/10 shadow-sm">
            <AlertTriangle className="h-10 w-10 text-destructive/80" strokeWidth={1.5} />
          </div>
        </div>

        {/* Text */}
        <div className="space-y-2">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            页面出现了问题
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {process.env.NODE_ENV === 'development'
              ? error.message
              : '发生了意外错误，请尝试刷新页面。'}
          </p>
        </div>

        {/* Error ID */}
        {error.digest && (
          <div className="rounded-lg border bg-muted/40 px-3 py-1.5">
            <p className="text-xs text-muted-foreground/70 font-mono">
              错误ID: {error.digest}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row items-center gap-3 pt-1">
          <Button onClick={reset} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            重试
          </Button>
          <Button variant="outline" asChild>
            <a href="/" className="gap-1.5">
              <Home className="h-4 w-4" />
              返回首页
            </a>
          </Button>
        </div>
      </motion.div>
    </div>
  );
}