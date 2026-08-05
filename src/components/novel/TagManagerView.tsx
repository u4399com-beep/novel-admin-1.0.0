'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { useAppStore } from '@/stores/app-store';
import type { Tag } from '@/types';
import { TagFormDialog } from './tag/TagFormDialog';
import type { TagFormValues } from './tag/TagFormDialog';
import { TagList } from './tag/TagList';

// ─── Main Component ─────────────────────────────────────────────────────────
export default function TagManagerView() {
  const refreshTags = useAppStore((s) => s.refreshVersions['tags'] ?? 0);
  const triggerRefresh = useAppStore((s) => s.triggerRefresh);

  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ─── Fetch tags ───────────────────────────────────────────────────────
  const fetchTags = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const data = await apiFetch<Tag[]>('/api/tags', { signal });
      if (signal?.aborted) return;
      setTags(data);
    } catch { /* handled by apiFetch */ } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchTags(ac.signal);
    return () => ac.abort();
  }, [refreshTags, fetchTags]);

  // ─── Open dialog ──────────────────────────────────────────────────────
  const openCreate = useCallback(() => {
    setEditingTag(null);
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback(
    (tag: Tag) => {
      setEditingTag(tag);
      setDialogOpen(true);
    },
    [],
  );

  // ─── Submit ───────────────────────────────────────────────────────────
  const onSubmit = async (values: TagFormValues) => {
    try {
      setSubmitting(true);
      const url = editingTag ? `/api/tags/${editingTag.id}` : '/api/tags';
      const method = editingTag ? 'PUT' : 'POST';

      await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });

      toast.success(editingTag ? '标签已更新' : '标签已创建');
      setDialogOpen(false);
      setEditingTag(null);
      triggerRefresh('tags');
    } catch { /* handled by apiFetch */ } finally {
      setSubmitting(false);
    }
  };

  // ─── Delete ───────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    try {
      setDeleting(true);
      await apiFetch(`/api/tags/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      toast.success('标签已删除');
      setDeleteTarget(null);
      triggerRefresh('tags');
    } catch { /* handled by apiFetch */ } finally {
      setDeleting(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">标签管理</h2>
          <p className="text-muted-foreground text-sm mt-1">
            管理小说标签，灵活标记和筛选内容
          </p>
        </div>
        <Button onClick={openCreate} size="default">
          <Plus />
          新建标签
        </Button>
      </div>

      {/* Tag List (includes loading & empty states) */}
      <TagList
        tags={tags}
        loading={loading}
        onEdit={openEdit}
        onDelete={setDeleteTarget}
        onCreate={openCreate}
      />

      {/* Add/Edit Dialog */}
      <TagFormDialog
        open={dialogOpen}
        editingTag={editingTag}
        submitting={submitting}
        onClose={() => { setDialogOpen(false); setEditingTag(null); }}
        onSubmit={onSubmit}
      />

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="确认删除标签"
        description={deleteTarget ? `确定要删除标签「${deleteTarget.name}」吗？此操作无法撤销。该标签将从所有小说中移除。` : ''}
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
