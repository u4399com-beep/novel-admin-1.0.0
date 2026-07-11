'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod/v4';
import { zodResolver } from '@hookform/resolvers/zod';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus,
  Pencil,
  Trash2,
  FolderTree,
  Loader2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { toast } from 'sonner';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useAppStore } from '@/stores/app-store';
import type { Category } from '@/types';

// ─── Zod Schema ──────────────────────────────────────────────────────────────
const categorySchema = z.object({
  name: z.string().min(1, '分类名称不能为空').max(50, '分类名称不能超过50个字符'),
  description: z.string().max(200, '描述不能超过200个字符').optional().default(''),
  color: z.string().min(1, '请选择颜色'),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

type CategoryFormData = z.infer<typeof categorySchema>;

// ─── Preset colors ───────────────────────────────────────────────────────────
const presetColors = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#6366f1', '#8b5cf6',
  '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
];

// ─── Component ────────────────────────────────────────────────────────────────
export default function CategoryManagerView() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refreshCategories = useAppStore((s) => s.refreshCategories);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CategoryFormData>({
    resolver: zodResolver(categorySchema) as any,
    defaultValues: {
      name: '',
      description: '',
      color: '#10b981',
      sortOrder: 0,
    },
  });

  const selectedColor = watch('color');

  // ── Fetch categories ─────────────────────────────────────────────────────
  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/categories');
      if (!res.ok) throw new Error('获取分类失败');
      const data: Category[] = await res.json();
      setCategories(data);
    } catch {
      toast.error('获取分类列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories, refreshCategories]);

  // ── Open dialog for create/edit ──────────────────────────────────────────
  const openCreate = () => {
    setEditingCategory(null);
    reset({ name: '', description: '', color: '#10b981', sortOrder: 0 });
    setDialogOpen(true);
  };

  const openEdit = (cat: Category) => {
    setEditingCategory(cat);
    reset({
      name: cat.name,
      description: cat.description ?? '',
      color: cat.color,
      sortOrder: cat.sortOrder,
    });
    setDialogOpen(true);
  };

  // ── Submit handler ──────────────────────────────────────────────────────
  const onSubmit = async (data: CategoryFormData) => {
    try {
      setSaving(true);
      const body = {
        name: data.name.trim(),
        description: data.description?.trim() || null,
        color: data.color,
        sortOrder: data.sortOrder,
      };

      if (editingCategory) {
        const res = await fetch(`/api/categories/${editingCategory.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || '更新分类失败');
        }
        toast.success('分类已更新');
      } else {
        const res = await fetch('/api/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || '创建分类失败');
        }
        toast.success('分类已创建');
      }

      setDialogOpen(false);
      fetchCategories();
    } catch {
      toast.error(editingCategory ? '更新分类失败' : '创建分类失败');
    } finally {
      setSaving(false);
    }
  };

  // ── Delete handler ──────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      const res = await fetch(`/api/categories/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '删除分类失败');
      }
      toast.success('分类已删除');
      setDeleteTarget(null);
      fetchCategories();
    } catch {
      toast.error('删除分类失败');
    } finally {
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

      {/* Loading */}
      {loading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="overflow-hidden">
              <CardContent className="flex items-center gap-3 p-4">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && categories.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <FolderTree className="h-8 w-8 text-muted-foreground" />
          </div>
          <p className="mt-4 text-sm text-muted-foreground">还没有分类，创建第一个吧</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            新建分类
          </Button>
        </div>
      )}

      {/* Category Grid */}
      {!loading && categories.length > 0 && (
        <motion.div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          initial="hidden"
          animate="show"
          variants={{
            hidden: {},
            show: { transition: { staggerChildren: 0.04 } },
          }}
        >
          <AnimatePresence mode="popLayout">
            {categories.map((cat) => (
              <motion.div
                key={cat.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                <Card className="group relative overflow-hidden transition-shadow hover:shadow-md">
                  {/* Colored left border */}
                  <div
                    className="absolute left-0 top-0 h-full w-1"
                    style={{ backgroundColor: cat.color }}
                  />
                  <CardContent className="p-4 pl-5">
                    <div className="flex items-start gap-3">
                      {/* Color dot + Info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-3 w-3 shrink-0 rounded-full"
                            style={{ backgroundColor: cat.color }}
                          />
                          <h3 className="truncate text-sm font-semibold">{cat.name}</h3>
                        </div>
                        {cat.description && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {cat.description}
                          </p>
                        )}
                        <div className="mt-2 flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs">
                            {cat._count?.novels ?? 0} 本小说
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(cat.createdAt), {
                              addSuffix: true,
                              locale: zhCN,
                            })}
                          </span>
                        </div>
                      </div>

                      {/* Actions (visible on hover) */}
                      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEdit(cat)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(cat)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {/* ── Create/Edit Dialog ──────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) setEditingCategory(null);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCategory ? '编辑分类' : '新建分类'}</DialogTitle>
            <DialogDescription>
              {editingCategory ? '修改分类信息' : '填写分类信息创建新分类'}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="cat-name">
                分类名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cat-name"
                placeholder="输入分类名称"
                {...register('name')}
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="cat-desc">描述</Label>
              <Textarea
                id="cat-desc"
                placeholder="输入分类描述（可选）"
                rows={3}
                {...register('description')}
              />
              {errors.description && (
                <p className="text-xs text-destructive">{errors.description.message}</p>
              )}
            </div>

            {/* Color */}
            <div className="space-y-2">
              <Label>颜色</Label>
              <div className="flex flex-wrap items-center gap-2">
                {presetColors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`h-7 w-7 rounded-full border-2 transition-all ${
                      selectedColor === c
                        ? 'scale-110 border-foreground shadow-sm'
                        : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: c }}
                    onClick={() => setValue('color', c)}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={selectedColor}
                  onChange={(e) => setValue('color', e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded border border-input bg-transparent p-0.5"
                />
                <Input
                  placeholder="#000000"
                  className="flex-1 font-mono text-sm"
                  {...register('color')}
                />
              </div>
              {errors.color && (
                <p className="text-xs text-destructive">{errors.color.message}</p>
              )}
            </div>

            {/* Sort Order */}
            <div className="space-y-2">
              <Label htmlFor="cat-sort">排序</Label>
              <Input
                id="cat-sort"
                type="number"
                min={0}
                placeholder="0"
                {...register('sortOrder')}
              />
              {errors.sortOrder && (
                <p className="text-xs text-destructive">{errors.sortOrder.message}</p>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={saving}
              >
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {editingCategory ? '保存' : '创建'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation ────────────────────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => {
        if (!open) setDeleteTarget(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除分类「{deleteTarget?.name}」吗？此操作不可撤销。
              {deleteTarget && (deleteTarget._count?.novels ?? 0) > 0 && (
                <span className="mt-1 block text-destructive">
                  该分类下还有 {deleteTarget._count?.novels} 本小说。
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}