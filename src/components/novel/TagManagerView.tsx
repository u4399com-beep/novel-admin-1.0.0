'use client';

import { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod/v4';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus,
  Pencil,
  Trash2,
  Tags,
  BookOpen,
  Loader2,
  Palette,
} from 'lucide-react';

import { useAppStore } from '@/stores/app-store';
import type { Tag } from '@/types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
  CardDescription,
} from '@/components/ui/card';
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

// ─── Preset Colors ──────────────────────────────────────────────────────────
const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6',
  '#a855f7', '#d946ef', '#ec4899', '#f43f5e',
];

// ─── Zod Schema (zod v4) ────────────────────────────────────────────────────
const tagSchema = z.object({
  name: z.string().min(1, '标签名称不能为空').max(30, '标签名称不能超过30个字符'),
  color: z.string().min(1, '请选择颜色'),
});

type TagFormValues = z.infer<typeof tagSchema>;

// ─── Color Picker Component ─────────────────────────────────────────────────
function ColorPicker({ value, onChange }: { value: string; onChange: (val: string) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-10 cursor-pointer rounded-lg border border-input bg-transparent p-0.5 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-none"
          />
        </div>
        <Input
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) {
              onChange(v);
            }
          }}
          className="w-28 font-mono text-sm"
          placeholder="#000000"
          maxLength={7}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={`h-7 w-7 rounded-full border-2 transition-all hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              value.toLowerCase() === c.toLowerCase()
                ? 'border-foreground scale-110 ring-2 ring-ring ring-offset-2 ring-offset-background'
                : 'border-transparent'
            }`}
            style={{ backgroundColor: c }}
            aria-label={`选择颜色 ${c}`}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function TagManagerView() {
  const { refreshTags, triggerRefreshTags } = useAppStore();

  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ─── Fetch tags ───────────────────────────────────────────────────────
  const fetchTags = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/tags');
      if (!res.ok) throw new Error('获取标签失败');
      const data = await res.json();
      setTags(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '获取标签失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTags();
  }, [refreshTags, fetchTags]);

  // ─── Form ─────────────────────────────────────────────────────────────
  const form = useForm<TagFormValues>({
    resolver: zodResolver(tagSchema),
    defaultValues: {
      name: '',
      color: '#22c55e',
    },
  });

  const resetAndClose = useCallback(() => {
    form.reset({ name: '', color: '#22c55e' });
    setEditingTag(null);
    setDialogOpen(false);
  }, [form]);

  const openCreate = useCallback(() => {
    setEditingTag(null);
    form.reset({ name: '', color: '#22c55e' });
    setDialogOpen(true);
  }, [form]);

  const openEdit = useCallback(
    (tag: Tag) => {
      setEditingTag(tag);
      form.reset({ name: tag.name, color: tag.color });
      setDialogOpen(true);
    },
    [form]
  );

  // ─── Submit ───────────────────────────────────────────────────────────
  const onSubmit = async (values: TagFormValues) => {
    try {
      setSubmitting(true);
      const url = editingTag ? `/api/tags/${editingTag.id}` : '/api/tags';
      const method = editingTag ? 'PUT' : 'POST';
      const body = values;

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || (editingTag ? '更新失败' : '创建失败'));
      }

      toast.success(editingTag ? '标签已更新' : '标签已创建');
      resetAndClose();
      triggerRefreshTags();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Delete ───────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/tags/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || '删除失败');
      }
      toast.success('标签已删除');
      setDeleteTarget(null);
      triggerRefreshTags();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
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

      {/* Loading Skeleton */}
      {loading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="py-4">
              <CardContent className="flex items-center gap-3">
                <Skeleton className="h-5 w-5 rounded-full" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="ml-auto h-5 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && tags.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16"
        >
          <div className="bg-muted/50 flex h-16 w-16 items-center justify-center rounded-full">
            <Tags className="text-muted-foreground h-8 w-8" />
          </div>
          <h3 className="mt-4 text-lg font-medium">暂无标签</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            点击上方按钮创建你的第一个标签
          </p>
          <Button onClick={openCreate} variant="outline" className="mt-4">
            <Plus />
            新建标签
          </Button>
        </motion.div>
      )}

      {/* Tag Grid */}
      {!loading && tags.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          <AnimatePresence mode="popLayout">
            {tags.map((tag, idx) => (
              <motion.div
                key={tag.id}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.2, delay: idx * 0.02 }}
              >
                <Card
                  className="group relative overflow-hidden transition-all hover:shadow-md hover:border-foreground/20 cursor-default"
                  style={{
                    borderLeftWidth: '4px',
                    borderLeftColor: tag.color,
                  }}
                >
                  <CardHeader className="py-3 pb-0">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="inline-block h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/10 transition-transform group-hover:scale-125"
                        style={{ backgroundColor: tag.color }}
                      />
                      <CardTitle className="truncate text-sm font-semibold">
                        {tag.name}
                      </CardTitle>
                    </div>
                    <CardAction>
                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEdit(tag)}
                        >
                          <Pencil className="h-3 w-3" />
                          <span className="sr-only">编辑</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(tag)}
                        >
                          <Trash2 className="h-3 w-3" />
                          <span className="sr-only">删除</span>
                        </Button>
                      </div>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="py-3 pt-1">
                    <Badge variant="secondary" className="gap-1 text-xs">
                      <BookOpen className="h-3 w-3" />
                      {tag._count?.novels ?? 0} 本小说
                    </Badge>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !open && resetAndClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingTag ? '编辑标签' : '新建标签'}</DialogTitle>
            <DialogDescription>
              {editingTag
                ? '修改标签信息，保存后立即生效。'
                : '创建一个新的小说标签。'}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* Name */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      标签名称 <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="例如：系统流、重生、轻松..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Color */}
              <FormField
                control={form.control}
                name="color"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      <span className="inline-flex items-center gap-1.5">
                        <Palette className="h-4 w-4" />
                        颜色
                      </span>
                    </FormLabel>
                    <FormControl>
                      <ColorPicker value={field.value} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={resetAndClose}
                  disabled={submitting}
                >
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? '保存中...' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除标签</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除标签「{deleteTarget?.name}」吗？此操作无法撤销。该标签将从所有小说中移除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}