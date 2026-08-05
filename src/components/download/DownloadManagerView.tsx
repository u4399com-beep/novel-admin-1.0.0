'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { DownloadList } from './DownloadList';
import { DownloadActions } from './DownloadActions';
import type { DownloadConfig } from '@/types';

export default function DownloadManagerView() {
  const [configs, setConfigs] = useState<DownloadConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DownloadConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DownloadConfig | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await fetch('/api/download-configs');
      if (res.ok) {
        const data = await res.json();
        setConfigs(Array.isArray(data) ? data : []);
      }
    } catch {
      toast.error('获取下载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchConfigs(); }, [fetchConfigs]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/download-configs/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '删除失败');
      }
      toast.success('配置已删除');
      fetchConfigs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败');
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

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">下载配置</h2>
          <p className="text-sm text-muted-foreground">管理小说导出下载的格式和内容配置</p>
        </div>
        <Button onClick={() => { setEditing(null); setFormOpen(true); }} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新建配置
        </Button>
      </div>

      <DownloadList
        configs={configs}
        onEdit={(config) => { setEditing(config); setFormOpen(true); }}
        onDelete={setDeleteTarget}
      />

      <DownloadActions
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onSaved={fetchConfigs}
      />

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
