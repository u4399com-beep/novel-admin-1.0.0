'use client';

import React from 'react';
import {
  ChevronDown, ChevronRight, FileText, BookOpen, XCircle, Ban, Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TaskStatusBadge } from './TaskStatusBadge';
import { TaskProgress } from './TaskProgress';
import { TaskLogPanel } from './TaskLogPanel';
import type { ScrapeTask, ScrapeTaskLog } from './types';
import { formatDuration } from './types';

interface TaskCardProps {
  task: ScrapeTask;
  isExpanded: boolean;
  logs: ScrapeTaskLog[];
  logsLoading: boolean;
  formatDate: (d: string | null | undefined) => string;
  onToggleExpand: (taskId: string) => void;
  onDelete: (task: ScrapeTask) => void;
}

function StatItem({
  icon: Icon,
  label: _label,
  value,
  className,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 ${className || ''}`}>
      <Icon className="h-3 w-3" />
      <span>{value}</span>
    </span>
  );
}

export const TaskCard = React.memo(function TaskCard({
  task, isExpanded, logs, logsLoading, formatDate, onToggleExpand, onDelete,
}: TaskCardProps) {
  const isRunning = task.status === 'running';
  const isCompleted = task.status === 'completed';
  const canDelete = task.status !== 'running';
  const progressPercent = task.progress ?? 0;
  const runningElapsed = isRunning ? formatDuration(task.startedAt, null) : null;
  const completedTotal = isCompleted ? formatDuration(task.startedAt, task.completedAt) : null;

  return (
    <Card className="overflow-hidden transition-all hover:shadow-sm card-interactive">
      {/* Card Header - Clickable for expand */}
      <button
        onClick={() => onToggleExpand(task.id)}
        className="w-full text-left"
        aria-expanded={isExpanded}
      >
        <CardHeader className="p-4 pb-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              {/* Expand icon */}
              <div className="mt-0.5 shrink-0">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </div>

              {/* Task info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-muted-foreground">
                    {task.id.slice(0, 8)}
                  </span>
                  <TaskStatusBadge status={task.status} />
                  <Badge variant="outline" className="text-xs">
                    {task.mode === 'full' ? '全量' : '增量'}
                  </Badge>
                </div>
                <p className="mt-1 text-sm font-medium truncate">
                  {task.rule?.name || '未知规则'}
                </p>
                {task.currentStep && isRunning && (
                  <p className="mt-0.5 text-xs text-muted-foreground truncate">
                    {task.currentStep}
                  </p>
                )}
              </div>
            </div>

            {/* Delete button (non-running) */}
            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(task);
                }}
                title="删除任务"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </CardHeader>
      </button>

      <CardContent className="p-4 pt-3">
        {/* Progress bar */}
        <TaskProgress progress={progressPercent} isRunning={isRunning} isCompleted={isCompleted} />

        {/* Stats row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <StatItem icon={BookOpen} label="书籍" value={`${task.totalBooks} 总 / ${task.newBooks} 新`} />
          <StatItem icon={FileText} label="章节" value={`${task.totalChapters} 总 / ${task.newChapters} 新`} />
          {task.failedItems > 0 && (
            <StatItem icon={XCircle} label="失败" value={String(task.failedItems)} className="text-destructive" />
          )}
          {task.skippedItems > 0 && (
            <StatItem icon={Ban} label="跳过" value={String(task.skippedItems)} className="text-slate-500" />
          )}
          <span className="text-muted-foreground/60">
            创建于 {formatDate(task.createdAt)}
          </span>
          {runningElapsed && (
            <span className="text-sky-600 dark:text-sky-400 font-medium">
              运行 {runningElapsed}
            </span>
          )}
          {completedTotal && (
            <span className="text-chart-emerald">
              总耗时 {completedTotal}
            </span>
          )}
        </div>

        {/* Error message for failed tasks */}
        {task.status === 'failed' && task.errorMessage && (
          <div className="mt-2 rounded-md bg-destructive/5 border border-destructive/20 px-3 py-2">
            <p className="text-xs text-destructive break-words">
              {task.errorMessage}
            </p>
          </div>
        )}

        {/* Result URL for completed tasks */}
        {task.status === 'completed' && task.resultUrl && (
          <div className="mt-2">
            <p className="text-xs text-muted-foreground">
              结果文件:{' '}
              <span className="font-mono text-xs text-chart-emerald break-all">
                {task.resultUrl}
              </span>
            </p>
          </div>
        )}

        {/* Time info */}
        {(task.startedAt || task.completedAt) && (
          <div className="mt-1.5 text-xs text-muted-foreground/60 flex flex-wrap gap-x-3">
            {task.startedAt && <span>开始: {formatDate(task.startedAt)}</span>}
            {task.completedAt && <span>完成: {formatDate(task.completedAt)}</span>}
          </div>
        )}

        {/* Expanded Logs */}
        <TaskLogPanel
          isExpanded={isExpanded}
          logs={logs}
          logsLoading={logsLoading}
          formatDate={formatDate}
        />
      </CardContent>
    </Card>
  );
});
