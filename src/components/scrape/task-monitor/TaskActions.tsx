'use client';

import { ArrowLeft, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from './types';
import { STATUS_FILTERS } from './types';

interface TaskActionsHeaderProps {
  onBack?: () => void;
  hasRunningTasks: boolean;
  runningCount?: number;
  total: number;
  onRefresh: () => void;
  selectedCount?: number;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  onBatchDelete?: () => void;
}

export function TaskActionsHeader({
  onBack,
  hasRunningTasks,
  runningCount = 0,
  total,
  onRefresh,
  selectedCount = 0,
  onSelectAll,
  onDeselectAll,
  onBatchDelete,
}: TaskActionsHeaderProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4 mr-1" />
              返回
            </Button>
          )}
          <div>
            <h2 className="text-lg font-semibold">任务记录</h2>
            <p className="text-sm text-muted-foreground">
              采集任务历史与日志监控
              {total > 0 && (
                <span className="ml-1.5 text-muted-foreground/70">· 共 {total} 条</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasRunningTasks && (
            <Badge variant="outline" className="gap-1 text-sky-600 border-sky-200 dark:text-sky-400 dark:border-sky-800">
              <span className="h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" />
              {runningCount > 0 ? `${runningCount} 个运行中` : '自动刷新中'}
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={onRefresh} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      </div>

      {/* Batch operations bar */}
      {selectedCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/50 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              已选择 {selectedCount} 项
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={onBatchDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
              批量删除
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={onDeselectAll}
            >
              <X className="h-3.5 w-3.5" />
              取消选择
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface TaskStatusFilterProps {
  statusFilter: TaskStatus | 'all';
  onFilterChange: (status: TaskStatus | 'all') => void;
  onSelectAll?: () => void;
}

export function TaskStatusFilter({ statusFilter, onFilterChange, onSelectAll }: TaskStatusFilterProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            variant={statusFilter === filter.value ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => onFilterChange(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>
      {onSelectAll && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={onSelectAll}
        >
          全选
        </Button>
      )}
    </div>
  );
}

interface TaskPaginationProps {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}

export function TaskPagination({ page, totalPages, onPrev, onNext }: TaskPaginationProps) {
  return (
    <div className="flex items-center justify-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={onPrev}
      >
        上一页
      </Button>
      <span className="text-sm text-muted-foreground">
        第 {page} / {totalPages} 页
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= totalPages}
        onClick={onNext}
      >
        下一页
      </Button>
    </div>
  );
}
