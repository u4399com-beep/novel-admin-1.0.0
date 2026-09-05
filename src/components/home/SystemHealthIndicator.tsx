'use client';

import { useState, useEffect, useRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiFetch } from '@/lib/api-fetch';

// ─── Component ───────────────────────────────────────────────
export function SystemHealthIndicator() {
  const [online, setOnline] = useState<boolean | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function check() {
      try {
        const data = await apiFetch<{ status: string }>(
          '/api/public/health',
          { silent: true, timeout: 3000 }
        );
        setOnline(data.status === 'healthy');
      } catch {
        setOnline(false);
      }
    }

    // Initial check
    check();

    // Poll every 60s
    intervalRef.current = setInterval(check, 60_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Don't render until first check completes
  if (online === null) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 cursor-default">
          <span
            className={`inline-block h-2 w-2 rounded-full transition-colors duration-500 ${
              online
                ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                : 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]'
            }`}
          />
          <span className="text-[10px] text-muted-foreground/50">
            {online ? '正常' : '异常'}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {online ? '系统运行正常' : '系统服务异常'}
      </TooltipContent>
    </Tooltip>
  );
}
