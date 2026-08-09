'use client';

import type { SiteHealthStatus } from './helpers';

interface SiteStatusDotProps {
  status: SiteHealthStatus;
}

export function SiteStatusDot({ status }: SiteStatusDotProps) {
  const config: Record<SiteHealthStatus, { color: string; label: string }> = {
    active: { color: 'bg-chart-emerald', label: '正常' },
    error: { color: 'bg-destructive', label: '异常' },
    unknown: { color: 'bg-gray-400 dark:bg-gray-500', label: '未知' },
  };
  const c = config[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${c.color}`} />
      <span className="text-xs">{c.label}</span>
    </span>
  );
}
