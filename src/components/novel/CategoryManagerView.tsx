'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { useAppStore } from '@/stores/app-store';
import type { Category } from '@/types';
import { CategoryFormDialog } from './category/CategoryFormDialog';
import type { CategoryFormData } from './category/CategoryFormDialog';
import { CategoryList } from './category/CategoryList';

// ─── Component ────────────────────────────────────────────────────────────────
export default function CategoryManagerView() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const triggerRefresh = useAppStore((s) => s.triggerRefresh);
  const refreshCategories = useAppStore((s) => s.refreshVersions['categories'] ?? 0);

  // ── Fetch categories ─────────────────────────────────────────────────────
  const fetchCategories = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const data = await apiFetch<Category[]>('/api/categories', { signal });
      if (signal?.aborted) return;
      setCategories(data);
    } catch {
      if (signal?.aborted) return;
      /* handled by apiFetch */
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchCategories(ac.signal);
    return () => ac.abort();
  }, [fetchCategories, refreshCategories]);

  // ── Open dialog for create/edit ──────────────────────────────────────────
  const openCreate = () => {
    setEditingCategory(null);
    setDialogOpen(true);
  };

  const openEdit = (cat: Category) => {
    setEditingCategory(cat);
    setDialogOpen(true);
  };

  // ── Submit handler ──────────────────────────────────────────────────────
  const onSubmit = async (data: CategoryFormData) => {
    try {
      setSaving(true);
      const body = {
        name: data.name.trim(),
        slug: data.slug.trim(),
        icon: data.icon?.trim() || null,
        description: data.description?.trim() || null,
        color: data.color,
        sortOrder: data.sortOrder,
      };

      if (editingCategory) {
        await apiFetch(`/api/categories/${editingCategory.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast.success('分类已更新');
      } else {
        await apiFetch('/api/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast.success('分类已创建');
      }

      setDialogOpen(false);
      triggerRefresh('categories');
    } catch { /* handled by apiFetch */ } finally {
      setSaving(false);
    }
  };

  // ── Delete handler ──────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await apiFetch(`/api/categories/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      toast.success('分类已删除');
      setDeleteTarget(null);
      triggerRefresh('categories');
    } catch { /* handled by apiFetch */ } finally {
      setDeleting(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">分类管理</h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          新建分类
        </Button>
      </div>

      {/* Category List (includes loading & empty states) */}
      <CategoryList
        categories={categories}
        loading={loading}
        onEdit={openEdit}
        onDelete={setDeleteTarget}
        onCreate={openCreate}
      />

      {/* Create/Edit Dialog */}
      <CategoryFormDialog
        open={dialogOpen}
        editingCategory={editingCategory}
        saving={saving}
        onClose={() => { setDialogOpen(false); setEditingCategory(null); }}
        onSubmit={onSubmit}
      />

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        description={
          deleteTarget
            ? `确定要删除分类「${deleteTarget.name}」吗？此操作不可撤销。${(deleteTarget._count?.novels ?? 0) > 0 ? ` 该分类下还有 ${deleteTarget._count?.novels} 本小说。` : ''}`
            : ''
        }
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
