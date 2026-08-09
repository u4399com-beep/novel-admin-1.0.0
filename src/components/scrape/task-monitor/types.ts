import React from 'react';
import { Clock, Loader2, CheckCircle2, XCircle, Ban } from 'lucide-react';

// ==================== Types ====================

export interface ScrapeTaskLog {
  id: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  url?: string | null;
  createdAt: string;
}

export interface ScrapeTask {
  id: string;
  ruleId: string;
  rule: { id: string; name: string };
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  mode: string;
  totalBooks: number;
  totalChapters: number;
  newBooks: number;
  newChapters: number;
  failedItems: number;
  skippedItems: number;
  progress: number;
  currentStep: string | null;
  resultUrl: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  logs?: ScrapeTaskLog[];
}

export type TaskStatus = ScrapeTask['status'];

// ==================== Constants ====================

export const STATUS_CONFIG: Record<
  TaskStatus,
  { label: string; color: string; bgColor: string; icon: React.ElementType }
> = {
  pending: {
    label: '等待中',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted text-muted-foreground',
    icon: Clock,
  },
  running: {
    label: '运行中',
    color: 'text-chart-slate',
    bgColor: 'bg-chart-slate/10 text-chart-slate',
    icon: Loader2,
  },
  completed: {
    label: '已完成',
    color: 'text-chart-emerald',
    bgColor: 'bg-chart-emerald/10 text-chart-emerald',
    icon: CheckCircle2,
  },
  failed: {
    label: '失败',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10 text-destructive',
    icon: XCircle,
  },
  cancelled: {
    label: '已取消',
    color: 'text-chart-amber',
    bgColor: 'bg-chart-amber/10 text-chart-amber',
    icon: Ban,
  },
};

export const LOG_LEVEL_CONFIG: Record<
  string,
  { color: string; icon: React.ElementType }
> = {
  info: { color: 'text-foreground', icon: () => null },
  warn: { color: 'text-chart-amber', icon: () => null },
  error: { color: 'text-destructive', icon: () => null },
  success: { color: 'text-chart-emerald', icon: () => null },
};

export const STATUS_FILTERS: { value: TaskStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'pending', label: '等待中' },
  { value: 'cancelled', label: '已取消' },
];

export const PAGE_SIZE = 15;

// ==================== Helpers ====================

export function formatDuration(startStr: string | null, endStr: string | null): string {
  if (!startStr) return '';
  const start = new Date(startStr).getTime();
  const end = endStr ? new Date(endStr).getTime() : Date.now();
  if (isNaN(start) || isNaN(end)) return '';
  const diffMs = end - start;
  if (diffMs < 0) return '';
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    if (minutes > 0) return `${hours}小时${minutes}分`;
    return `${hours}小时`;
  }
  if (minutes > 0) return `${minutes}分`;
  if (totalSeconds > 0) return `${totalSeconds}秒`;
  return '';
}
