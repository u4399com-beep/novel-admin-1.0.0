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
    color: 'text-gray-500 dark:text-gray-400',
    bgColor: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
    icon: Clock,
  },
  running: {
    label: '运行中',
    color: 'text-sky-500',
    bgColor: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
    icon: Loader2,
  },
  completed: {
    label: '已完成',
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    icon: CheckCircle2,
  },
  failed: {
    label: '失败',
    color: 'text-red-500',
    bgColor: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    icon: XCircle,
  },
  cancelled: {
    label: '已取消',
    color: 'text-amber-500',
    bgColor: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    icon: Ban,
  },
};

export const LOG_LEVEL_CONFIG: Record<
  string,
  { color: string; icon: React.ElementType }
> = {
  info: { color: 'text-foreground', icon: () => null },
  warn: { color: 'text-amber-500', icon: () => null },
  error: { color: 'text-red-500', icon: () => null },
  success: { color: 'text-emerald-500', icon: () => null },
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
