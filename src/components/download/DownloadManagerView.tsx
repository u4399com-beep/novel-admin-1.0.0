'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Loader2, FileText, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { apiFetch, FetchError } from '@/lib/api-fetch';
import type { DownloadConfig } from '@/types';

export default function DownloadManagerView() {
  const [configs, setConfigs] = useState<DownloadConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<DownloadConfig | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchConfigs = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<DownloadConfig[]>('/api/download-configs', { signal });
      if (!signal?.aborted) {
        setConfigs(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      if (err instanceof FetchError && err.status === 0) return;
      if (!signal?.aborted) toast.error('获取下载配置失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchConfigs(ac.signal);
    return () => ac.abort();
  }, [fetchConfigs]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/download-configs/${deleteTarget.id}`, { method: 'DELETE' });
      toast.success('配置已删除');
      setConfigs((prev) => prev.filter((c) => c.id !== deleteTarget.id));
    } catch {
      toast.error('删除失败');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (configs.length === 0) {
    return (
      <div className="p-4 sm:p-6 max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold">下载配置</h2>
            <p className="text-sm text-muted-foreground">管理小说导出下载的格式和内容配置</p>
          </div>
        </div>
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <FileText className="h-10 w-10 mb-3 opacity-30" />
          <p className="text-sm">暂无下载配置</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">下载配置</h2>
          <p className="text-sm text-muted-foreground">管理小说导出下载的格式和内容配置</p>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="text-left px-4 py-3 font-medium">名称</th>
              <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">格式</th>
              <th className="text-right px-4 py-3 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {configs.map((config) => (
              <tr key={config.id} className="border-b last:border-b-0 hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3 font-medium">{config.name}</td>
                <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell uppercase text-xs">{config.format}</td>
                <td className="px-4 py-3 text-right">
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(config)} aria-label="删除配置">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="确认删除"
        description={`确定要删除下载配置「${deleteTarget?.name}」吗？此操作不可撤销。`}
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
