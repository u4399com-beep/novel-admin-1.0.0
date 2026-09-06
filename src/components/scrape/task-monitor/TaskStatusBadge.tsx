'use client';

import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from './types';
import { STATUS_CONFIG } from './types';

interface TaskStatusBadgeProps {
  status: TaskStatus;
}

/** Color-coded status dot for health indicators */
export function StatusDot({ status }: { status: 'healthy' | 'degraded' | 'error' }) {
  const colors = {
    healthy: 'bg-emerald-500',
    degraded: 'bg-amber-500',
    error: 'bg-red-500',
  };
  return (
    <span className="relative flex h-2 w-2">
      {status !== 'error' && (
        <span className={`status-dot-pulse absolute inline-flex h-full w-full rounded-full ${colors[status]} opacity-75`} />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${colors[status]}`} />
    </span>
  );
}

export function TaskStatusBadge({ status }: TaskStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const StatusIcon = config.icon;
  const isRunning = status === 'running';

  return (
    <Badge
      className={`${config.bgColor} ${isRunning ? 'animate-pulse pulse-dot' : ''}`}
      variant="secondary"
    >
      <StatusIcon
        className={`h-3 w-3 mr-0.5 ${isRunning ? 'animate-spin' : ''}`}
      />
      {config.label}
    </Badge>
  );
}
