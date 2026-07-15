'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import {
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  Trash2,
  ChevronDown,
  ChevronRight,
  FileText,
  BookOpen,
  AlertTriangle,
  Info,
  CircleCheck,
  CircleX,
  ArrowLeft,
  RefreshCw,
  ListChecks,
} from 'lucide-react';
import { safeFormatDate } from '@/lib/format';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// ==================== Types ====================

interface ScrapeTaskLog {
  id: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  url?: string | null;
  createdAt: string;
}

interface ScrapeTask {
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

type TaskStatus = ScrapeTask['status'];

// ==================== Constants ====================

const STATUS_CONFIG: Record<
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
    color: 'text-slate-400',
    bgColor: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
    icon: Ban,
  },
};

const LOG_LEVEL_CONFIG: Record<
  string,
  { color: string; icon: React.ElementType }
> = {
  info: { color: 'text-foreground', icon: Info },
  warn: { color: 'text-amber-500', icon: AlertTriangle },
  error: { color: 'text-red-500', icon: CircleX },
  success: { color: 'text-emerald-500', icon: CircleCheck },
};

const STATUS_FILTERS: { value: TaskStatus | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'pending', label: '等待中' },
  { value: 'cancelled', label: '已取消' },
];

const PAGE_SIZE = 15;

// ==================== Main Component ====================

export function ScrapeTaskMonitor({ onBack }: { onBack?: () => void }) {
  const [tasks, setTasks] = useState<ScrapeTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<ScrapeTaskLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScrapeTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check if any running tasks exist
  const hasRunningTasks = tasks.some((t) => t.status === 'running');

  // Fetch task list
  const fetchTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      });
      const res = await fetch(`/api/scrape-tasks?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTasks(data.tasks || []);
      setTotalPages(data.totalPages || 1);
      setTotal(data.total || 0);
    } catch {
      toast.error('获取任务列表失败');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  // Initial fetch + refetch on page/filter/refresh changes
  useEffect(() => {
    setLoading(true);
    fetchTasks();
  }, [fetchTasks, refreshKey]);

  // Auto-refresh every 5s when running tasks exist
  useEffect(() => {
    if (hasRunningTasks) {
      autoRefreshRef.current = setInterval(() => {
        fetchTasks();
        // Also refresh expanded task logs if it's a running task
        if (expandedTaskId) {
          const expandedTask = tasks.find((t) => t.id === expandedTaskId);
          if (expandedTask?.status === 'running') {
            fetchTaskLogs(expandedTaskId);
          }
        }
      }, 5000);
    } else if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }
    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
        autoRefreshRef.current = null;
      }
    };
  }, [hasRunningTasks, expandedTaskId, tasks, fetchTasks]);

  // Fetch task logs for expanded task
  const fetchTaskLogs = useCallback(async (taskId: string) => {
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/scrape-tasks/${taskId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const task = await res.json();
      setExpandedLogs(task.logs || []);
      // Also update the task in the list with fresh data
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...task, logs: undefined } : t)));
    } catch {
      toast.error('获取任务详情失败');
    } finally {
      setLogsLoading(false);
    }
  }, []);

  // Toggle task expansion
  const handleToggleExpand = useCallback(
    (taskId: string) => {
      if (expandedTaskId === taskId) {
        setExpandedTaskId(null);
        setExpandedLogs([]);
      } else {
        setExpandedTaskId(taskId);
        setExpandedLogs([]);
        fetchTaskLogs(taskId);
      }
    },
    [expandedTaskId, fetchTaskLogs],
  );

  // Delete task
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/scrape-tasks/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '删除失败');
      }
      toast.success('任务已删除');
      if (expandedTaskId === deleteTarget.id) {
        setExpandedTaskId(null);
        setExpandedLogs([]);
      }
      fetchTasks();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  // Manual refresh
  const handleRefresh = () => setRefreshKey((k) => k + 1);

  // Reset page on filter change
  const handleFilterChange = (status: TaskStatus | 'all') => {
    setStatusFilter(status);
    setPage(1);
  };

  const formatDate = (dateStr: string | null | undefined) =>
    safeFormatDate(dateStr, (d) => format(d, 'yyyy-MM-dd HH:mm:ss', { locale: zhCN }));

  // ==================== Render ====================

  return (
    <div className="space-y-4">
      {/* Header */}
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
              自动刷新中
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={handleRefresh} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      </div>

      {/* Status Filter */}
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            variant={statusFilter === filter.value ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => handleFilterChange(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {/* Task List */}
      {loading ? (
        <LoadingSkeleton />
      ) : tasks.length === 0 ? (
        <EmptyState onBack={onBack} />
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              isExpanded={expandedTaskId === task.id}
              logs={expandedLogs}
              logsLoading={logsLoading}
              formatDate={formatDate}
              onToggleExpand={() => handleToggleExpand(task.id)}
              onDelete={() => setDeleteTarget(task)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
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
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确定要删除这条任务记录吗？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后无法恢复。运行中的任务不可删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ==================== Task Card ====================

interface TaskCardProps {
  task: ScrapeTask;
  isExpanded: boolean;
  logs: ScrapeTaskLog[];
  logsLoading: boolean;
  formatDate: (d: string | null | undefined) => string;
  onToggleExpand: () => void;
  onDelete: () => void;
}

function TaskCard({ task, isExpanded, logs, logsLoading, formatDate, onToggleExpand, onDelete }: TaskCardProps) {
  const config = STATUS_CONFIG[task.status];
  const StatusIcon = config.icon;
  const isRunning = task.status === 'running';
  const canDelete = task.status !== 'running';

  return (
    <Card className="overflow-hidden transition-all hover:shadow-sm">
      {/* Card Header - Clickable for expand */}
      <button
        onClick={onToggleExpand}
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
                  <Badge className={config.bgColor} variant="secondary">
                    <StatusIcon
                      className={`h-3 w-3 mr-0.5 ${isRunning ? 'animate-spin' : ''}`}
                    />
                    {config.label}
                  </Badge>
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
                  onDelete();
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
        {/* Progress bar for running tasks */}
        {isRunning && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">进度</span>
              <span className="text-xs font-medium tabular-nums">{task.progress}%</span>
            </div>
            <Progress value={task.progress} className="h-1.5" />
          </div>
        )}

        {/* Stats row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <StatItem icon={BookOpen} label="书籍" value={`${task.totalBooks} 总 / ${task.newBooks} 新`} />
          <StatItem icon={FileText} label="章节" value={`${task.totalChapters} 总 / ${task.newChapters} 新`} />
          {task.failedItems > 0 && (
            <StatItem icon={XCircle} label="失败" value={String(task.failedItems)} className="text-red-500" />
          )}
          {task.skippedItems > 0 && (
            <StatItem icon={Ban} label="跳过" value={String(task.skippedItems)} className="text-slate-500" />
          )}
          <span className="text-muted-foreground/60">
            创建于 {formatDate(task.createdAt)}
          </span>
        </div>

        {/* Error message for failed tasks */}
        {task.status === 'failed' && task.errorMessage && (
          <div className="mt-2 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 px-3 py-2">
            <p className="text-xs text-red-600 dark:text-red-400 break-words">
              {task.errorMessage}
            </p>
          </div>
        )}

        {/* Result URL for completed tasks */}
        {task.status === 'completed' && task.resultUrl && (
          <div className="mt-2">
            <p className="text-xs text-muted-foreground">
              结果文件:{' '}
              <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400 break-all">
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
        {isExpanded && (
          <div className="mt-3 border-t pt-3">
            <div className="flex items-center gap-2 mb-2">
              <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">运行日志</span>
            </div>
            {logsLoading ? (
              <div className="space-y-1.5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 w-full" />
                ))}
              </div>
            ) : logs.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">暂无日志</p>
            ) : (
              <ScrollArea className="max-h-64">
                <div className="space-y-0.5">
                  {logs.map((log) => {
                    const logConfig = LOG_LEVEL_CONFIG[log.level] || LOG_LEVEL_CONFIG.info;
                    const LogIcon = logConfig.icon;
                    return (
                      <div
                        key={log.id}
                        className="flex items-start gap-2 py-1 px-2 rounded-sm hover:bg-muted/50 text-xs"
                      >
                        <LogIcon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${logConfig.color}`} />
                        <span className={`flex-1 break-words ${logConfig.color}`}>{log.message}</span>
                        {log.url && (
                          <span className="shrink-0 text-[10px] text-muted-foreground/60 font-mono max-w-[160px] truncate hidden sm:inline-block">
                            {log.url}
                          </span>
                        )}
                        <span className="shrink-0 text-[10px] text-muted-foreground/50 font-mono whitespace-nowrap hidden md:inline">
                          {formatDate(log.createdAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ==================== Stat Item ====================

function StatItem({
  icon: Icon,
  label,
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

// ==================== Loading Skeleton ====================

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="p-4 pb-0">
            <div className="flex items-start gap-3">
              <Skeleton className="h-4 w-4 mt-0.5" />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-5 w-16" />
                  <Skeleton className="h-5 w-12" />
                </div>
                <Skeleton className="h-4 w-40" />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-3">
            <div className="flex gap-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ==================== Empty State ====================

function EmptyState({ onBack }: { onBack?: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="rounded-full bg-muted p-4">
          <ListChecks className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <div className="text-center">
          <p className="text-sm text-muted-foreground">暂无任务记录</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            在采集规则列表中执行规则后，任务将显示在此处
          </p>
        </div>
        {onBack && (
          <Button variant="link" size="sm" onClick={onBack}>
            返回采集规则列表
          </Button>
        )}
      </CardContent>
    </Card>
  );
}