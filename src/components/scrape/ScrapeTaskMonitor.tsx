'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { safeFormatDate } from '@/lib/format';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';

import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
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
      const data = await apiFetch<{ taskId: string }>(`/api/scrape-tasks/${task.id}/retry`, { method: 'POST' });
      toast.success('已创建重试任务');
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

  return (
    <div className="space-y-4">
      <ScrapeStatsDashboard />

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

      <TaskStatusFilter
        statusFilter={statusFilter}
        onFilterChange={handleFilterChange}
        onSelectAll={handleSelectAll}
      />

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
