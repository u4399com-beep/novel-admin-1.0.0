'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from './types';
import { STATUS_CONFIG } from './types';

interface TaskStatusBadgeProps {
  status: TaskStatus;
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
