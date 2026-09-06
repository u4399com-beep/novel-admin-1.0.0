'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import { Download, FileJson, FileSpreadsheet, Clock, AlertTriangle, RotateCcw, Flame, CheckCircle2, XCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { safeFormatDate } from '@/lib/format';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';

import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDeleteConfirm } from '@/hooks/useDeleteConfirm';

import { TaskCard, TaskActionsHeader, TaskStatusFilter, TaskPagination, LoadingSkeleton, EmptyState, ScrapeStatsDashboard } from './task-monitor';
import type { ScrapeTask, ScrapeTaskLog, TaskStatus } from './task-monitor';
import { PAGE_SIZE } from './task-monitor';

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
  const { deleteTarget, setDeleteTarget, deleting, handleDelete: confirmDelete } = useDeleteConfirm<ScrapeTask>();
  const [refreshKey, setRefreshKey] = useState(0);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expandedTaskIdRef = useRef<string | null>(null);

  // Batch selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [showBatchDeleteDialog, setShowBatchDeleteDialog] = useState(false);

  const hasRunningTasks = tasks.some((t) => t.status === 'running');
  const runningCount = tasks.filter((t) => t.status === 'running').length;

  const fetchTasks = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      });
      const data = await apiFetch<{ tasks: ScrapeTask[]; totalPages: number; total: number }>(`/api/scrape-tasks?${params}`, { signal });
      if (signal?.aborted) return;
      setTasks(data.tasks || []);
      setTotalPages(data.totalPages || 1);
      setTotal(data.total || 0);
    } catch {
      if (signal?.aborted) return;
      /* handled by apiFetch */
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fetchTasks(ac.signal);
    return () => ac.abort();
  }, [fetchTasks, refreshKey]);

  useEffect(() => {
    const ac = new AbortController();
    if (hasRunningTasks) {
      autoRefreshRef.current = setInterval(() => {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        });
        apiFetch<{ tasks: ScrapeTask[]; totalPages: number; total: number }>(
          `/api/scrape-tasks?${params}`, { signal: ac.signal, silent: true }
        ).then((data) => {
          if (ac.signal.aborted) return;
          setTasks(data.tasks || []);
          setTotalPages(data.totalPages || 1);
          setTotal(data.total || 0);
        }).catch(() => { /* silent */ });

        if (expandedTaskIdRef.current) {
          apiFetch<ScrapeTask>(`/api/scrape-tasks/${expandedTaskIdRef.current}`, { signal: ac.signal, silent: true })
            .then((task) => {
              if (ac.signal.aborted) return;
              setExpandedLogs(task.logs || []);
              setTasks((prev) => prev.map((t) => (t.id === expandedTaskIdRef.current ? { ...t, ...task, logs: undefined } : t)));
            }).catch(() => { /* silent */ });
        }
      }, 5000);
    } else if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }
    return () => {
      ac.abort();
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
        autoRefreshRef.current = null;
      }
    };
  }, [hasRunningTasks, page, statusFilter]);

  const fetchTaskLogs = useCallback(async (taskId: string, signal?: AbortSignal) => {
    setLogsLoading(true);
    try {
      const task = await apiFetch<ScrapeTask>(`/api/scrape-tasks/${taskId}`, { signal });
      if (signal?.aborted) return;
      setExpandedLogs(task.logs || []);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...task, logs: undefined } : t)));
    } catch { /* handled by apiFetch */ } finally {
      setLogsLoading(false);
    }
  }, []);

  const handleToggleExpand = useCallback(
    (taskId: string) => {
      if (expandedTaskId === taskId) {
        setExpandedTaskId(null);
        expandedTaskIdRef.current = null;
        setExpandedLogs([]);
      } else {
        setExpandedTaskId(taskId);
        expandedTaskIdRef.current = taskId;
        setExpandedLogs([]);
        fetchTaskLogs(taskId);
      }
    },
    [expandedTaskId, fetchTaskLogs],
  );

  const handleDelete = useCallback(() => confirmDelete(async () => {
    if (!deleteTarget) return;
    await apiFetch(`/api/scrape-tasks/${deleteTarget.id}`, { method: 'DELETE' });
    toast.success('任务已删除');
    if (expandedTaskId === deleteTarget.id) {
      setExpandedTaskId(null);
      expandedTaskIdRef.current = null;
      setExpandedLogs([]);
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(deleteTarget.id);
      return next;
    });
    fetchTasks();
  }), [confirmDelete, deleteTarget, expandedTaskId, fetchTasks]);

  const handleRetry = useCallback(async (task: ScrapeTask) => {
    try {
      await apiFetch<{ taskId: string }>(`/api/scrape-tasks/${task.id}/retry`, { method: 'POST' });
      toast.success('已创建重试任务');
      fetchTasks();
    } catch {
      /* handled by apiFetch */
    }
  }, [fetchTasks]);

  // ── One-Click Retry with Strategy Selection ──
  const handleRetryWithStrategy = useCallback(async (task: ScrapeTask, strategy: 'same' | 'upgrade' | 'proxy') => {
    try {
      await apiFetch<{ taskId: string }>(`/api/scrape-tasks/${task.id}/retry`, {
        method: 'POST',
        body: JSON.stringify({ strategy }),
        headers: { 'Content-Type': 'application/json' },
      });
      const strategyLabels = { same: '同引擎', upgrade: '升级引擎', proxy: '换代理' };
      toast.success(`已创建重试任务 (${strategyLabels[strategy]})`);
      fetchTasks();
    } catch {
      /* handled by apiFetch */
    }
  }, [fetchTasks]);

  const handleCancel = useCallback(async (task: ScrapeTask) => {
    try {
      await apiFetch(`/api/scrape-tasks/${task.id}/cancel`, { method: 'POST' });
      toast.success('任务已取消');
      fetchTasks();
    } catch {
      /* handled by apiFetch */
    }
  }, [fetchTasks]);

  const handleSelectChange = useCallback((taskId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(taskId);
      } else {
        next.delete(taskId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    const allIds = new Set(tasks.map((t) => t.id));
    setSelectedIds((prev) => {
      // If all are already selected, deselect all
      if (prev.size === allIds.size && tasks.every((t) => prev.has(t.id))) {
        return new Set();
      }
      return allIds;
    });
  }, [tasks]);

  const handleDeselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setShowBatchDeleteDialog(true);
  }, [selectedIds]);

  const confirmBatchDelete = useCallback(async () => {
    setBatchDeleting(true);
    try {
      const result = await apiFetch<{ deleted: number; skipped: number }>(
        '/api/scrape-tasks/batch-delete',
        {
          method: 'POST',
          body: JSON.stringify({ taskIds: Array.from(selectedIds) }),
          headers: { 'Content-Type': 'application/json' },
        },
      );
      const msg = `已删除 ${result.deleted} 条任务`;
      if (result.skipped > 0) {
        toast.warning(`${msg}，${result.skipped} 条运行中的任务已跳过`);
      } else {
        toast.success(msg);
      }
      setSelectedIds(new Set());
      setShowBatchDeleteDialog(false);
      fetchTasks();
    } catch {
      /* handled by apiFetch */
    } finally {
      setBatchDeleting(false);
    }
  }, [selectedIds, fetchTasks]);

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  const handleFilterChange = (status: TaskStatus | 'all') => {
    setStatusFilter(status);
    setPage(1);
    setSelectedIds(new Set());
  };

  const formatDate = useCallback((dateStr: string | null | undefined) =>
    safeFormatDate(dateStr, (d) => format(d, 'yyyy-MM-dd HH:mm:ss', { locale: zhCN })),
  []);

  const handleTaskDelete = useCallback((task: ScrapeTask) => {
    setDeleteTarget(task);
  }, [setDeleteTarget]);

  // ── Export handlers ──
  const completedTaskIds = tasks.filter((t) => t.status === 'completed').map((t) => t.id);

  const handleExportCurrent = useCallback((fmt: 'json' | 'csv') => {
    if (!expandedTaskId) {
      toast.error('请先展开一个任务');
      return;
    }
    const url = `/api/scrape-tasks/${expandedTaskId}/export?format=${fmt}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    toast.success(`正在导出当前任务 (${fmt.toUpperCase()})`);
  }, [expandedTaskId]);

  const handleExportAllCompleted = useCallback(async (fmt: 'json' | 'csv') => {
    if (completedTaskIds.length === 0) {
      toast.error('没有已完成的任务可导出');
      return;
    }
    if (completedTaskIds.length > 20) {
      toast.error('已完成任务超过20条，请分批导出或缩小筛选范围');
      return;
    }
    try {
      // For batch export, we need to POST, so we use a temporary form approach
      // or create an anchor with a data URL. Since the API requires POST, we'll
      // fetch the data and trigger download manually.
      const res = await fetch('/api/scrape-tasks/batch-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: completedTaskIds, format: fmt }),
      });
      if (!res.ok) {
        let errMsg = '导出失败';
        try {
          const errBody = await res.json() as { error?: string };
          errMsg = errBody.error || errMsg;
        } catch { /* ignore parse error */ }
        toast.error(errMsg);
        return;
      }
      const blob = await res.blob();
      const ext = fmt === 'csv' ? 'csv' : 'json';
      const mimeType = fmt === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
      const file = new File([blob], `batch-export.${ext}`, { type: mimeType });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = `batch-export.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast.success(`已导出 ${completedTaskIds.length} 条已完成任务 (${fmt.toUpperCase()})`);
    } catch {
      toast.error('导出失败，请稍后重试');
    }
  }, [completedTaskIds]);

  // ── Timeline, Heatmap & Error Analysis Data ──
  const failedTasks = useMemo(() => tasks.filter((t) => t.status === 'failed'), [tasks]);
  const errorPatterns = useMemo(() => {
    const patterns: Record<string, number> = {};
    for (const task of failedTasks) {
      const logs = task.logs || [];
      for (const logEntry of logs) {
        if (logEntry.level === 'error' || logEntry.message?.includes('error')) {
          const msg = logEntry.message || 'unknown';
          // Classify error pattern
          let pattern = 'other';
          if (msg.includes('captcha') || msg.includes('验证码')) pattern = 'captcha';
          else if (msg.includes('timeout') || msg.includes('超时')) pattern = 'timeout';
          else if (msg.includes('429') || msg.includes('rate')) pattern = 'rate_limit';
          else if (msg.includes('403') || msg.includes('forbidden')) pattern = 'blocked';
          else if (msg.includes('proxy')) pattern = 'proxy_error';
          else if (msg.includes('selector') || msg.includes('no content')) pattern = 'rule_error';
          else if (msg.includes('network') || msg.includes('ECONN')) pattern = 'network';
          patterns[pattern] = (patterns[pattern] || 0) + 1;
        }
      }
    }
    return patterns;
  }, [failedTasks]);

  const domainHealthMap = useMemo(() => {
    const domains: Record<string, { success: number; fail: number; total: number }> = {};
    for (const task of tasks) {
      const d = task.ruleId || 'unknown';
      if (!domains[d]) domains[d] = { success: 0, fail: 0, total: 0 };
      domains[d].total++;
      if (task.status === 'completed') domains[d].success++;
      else if (task.status === 'failed') domains[d].fail++;
    }
    return domains;
  }, [tasks]);

  return (
    <div className="space-y-4">
      <ScrapeStatsDashboard />

      {/* Domain Health Heatmap */}
      {Object.keys(domainHealthMap).length > 0 && (
        <div className="rounded-lg border bg-card p-3">
          <div className="flex items-center gap-2 mb-2">
            <Flame className="h-4 w-4 text-orange-500" />
            <span className="text-sm font-medium">域名健康度</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(domainHealthMap).map(([domain, health]) => {
              const ratio = health.total > 0 ? health.success / health.total : 0;
              const bgColor = ratio > 0.8 ? 'bg-green-500' : ratio > 0.5 ? 'bg-yellow-500' : ratio > 0.2 ? 'bg-orange-500' : 'bg-red-500';
              return (
                <div
                  key={domain}
                  className={`${bgColor} rounded px-2 py-0.5 text-xs text-white font-mono`}
                  title={`${domain}: ${health.success}/${health.total} 成功`}
                >
                  {domain.slice(0, 15)} {Math.round(ratio * 100)}%
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error Pattern Analysis */}
      {Object.keys(errorPatterns).length > 0 && (
        <div className="rounded-lg border bg-card p-3">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="text-sm font-medium">错误模式分析</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(errorPatterns)
              .sort(([, a], [, b]) => b - a)
              .map(([pattern, count]) => {
                const colors: Record<string, string> = {
                  captcha: 'bg-red-100 text-red-800',
                  rate_limit: 'bg-orange-100 text-orange-800',
                  blocked: 'bg-red-100 text-red-800',
                  timeout: 'bg-yellow-100 text-yellow-800',
                  proxy_error: 'bg-purple-100 text-purple-800',
                  rule_error: 'bg-blue-100 text-blue-800',
                  network: 'bg-gray-100 text-gray-800',
                  other: 'bg-gray-100 text-gray-800',
                };
                const icons: Record<string, React.ReactNode> = {
                  captcha: <AlertTriangle className="h-3 w-3" />,
                  rate_limit: <Clock className="h-3 w-3" />,
                  blocked: <XCircle className="h-3 w-3" />,
                  timeout: <Clock className="h-3 w-3" />,
                  proxy_error: <RotateCcw className="h-3 w-3" />,
                  rule_error: <AlertTriangle className="h-3 w-3" />,
                  network: <XCircle className="h-3 w-3" />,
                  other: <AlertTriangle className="h-3 w-3" />,
                };
                return (
                  <div key={pattern} className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${colors[pattern] || 'bg-gray-100 text-gray-800'}`}>
                    {icons[pattern]}
                    {pattern} ({count})
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Task Timeline for Running Tasks */}
      {hasRunningTasks && (
        <div className="rounded-lg border bg-card p-3">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-medium">运行中任务时间线</span>
          </div>
          <div className="space-y-1">
            {tasks.filter((t) => t.status === 'running').slice(0, 5).map((task) => (
              <div key={task.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="font-mono truncate max-w-[200px]">{task.id.slice(0, 12)}</span>
                <span className="truncate max-w-[300px]">{task.ruleId || '-'}</span>
                <span>{formatDate(task.createdAt)}</span>
                {task.totalChapters != null && task.newChapters != null && (
                  <span className="ml-auto">
                    <CheckCircle2 className="inline h-3 w-3 text-green-500 mr-1" />
                    {task.newChapters}/{task.totalChapters}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <TaskActionsHeader
        onBack={onBack}
        hasRunningTasks={hasRunningTasks}
        runningCount={runningCount}
        total={total}
        onRefresh={handleRefresh}
        selectedCount={selectedIds.size}
        onSelectAll={handleSelectAll}
        onDeselectAll={handleDeselectAll}
        onBatchDelete={handleBatchDelete}
      />

      <div className="flex items-center justify-between gap-3">
        <TaskStatusFilter
          statusFilter={statusFilter}
          onFilterChange={handleFilterChange}
        />
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleSelectAll}
          >
            全选
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs" disabled={tasks.length === 0}>
                <Download className="h-3.5 w-3.5" />
                导出
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!expandedTaskId}
                onClick={() => handleExportCurrent('json')}
              >
                <FileJson className="h-4 w-4 mr-2" />
                导出当前任务 (JSON)
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!expandedTaskId}
                onClick={() => handleExportCurrent('csv')}
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                导出当前任务 (CSV)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={completedTaskIds.length === 0}
                onClick={() => handleExportAllCompleted('json')}
              >
                <FileJson className="h-4 w-4 mr-2" />
                导出全部已完成 (JSON)
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={completedTaskIds.length === 0}
                onClick={() => handleExportAllCompleted('csv')}
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                导出全部已完成 (CSV)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

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
              onToggleExpand={handleToggleExpand}
              onDelete={handleTaskDelete}
              onRetry={handleRetry}
              onCancel={handleCancel}
              selected={selectedIds.has(task.id)}
              onSelectChange={handleSelectChange}
            />
          ))}
        </div>
      )}

      {!loading && totalPages > 1 && (
        <TaskPagination
          page={page}
          totalPages={totalPages}
          onPrev={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
        />
      )}

      {/* Single delete confirm */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="确定要删除这条任务记录吗？"
        description="删除后无法恢复。运行中的任务不可删除。"
        loading={deleting}
        onConfirm={handleDelete}
      />

      {/* Batch delete confirm */}
      <ConfirmDeleteDialog
        open={showBatchDeleteDialog}
        onOpenChange={(open) => !open && setShowBatchDeleteDialog(false)}
        title={`确定要删除选中的 ${selectedIds.size} 条任务吗？`}
        description="删除后无法恢复。运行中的任务将被自动跳过。"
        loading={batchDeleting}
        onConfirm={confirmBatchDelete}
      />
    </div>
  );
}
