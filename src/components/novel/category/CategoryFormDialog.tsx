'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod/v4';
import { safeResolver } from '@/lib/safe-resolver';
import { Loader2, SmilePlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ColorPicker } from '@/components/ui/color-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Category } from '@/types';

// ─── Zod Schema ──────────────────────────────────────────────────────────────
const categorySchema = z.object({
  name: z.string().min(1, '分类名称不能为空').max(50, '分类名称不能超过50个字符'),
  slug: z
    .string()
    .min(1, '分类标识符不能为空')
    .max(50, '分类标识符不能超过50个字符')
    .regex(/^[a-z0-9_-]+$/, '只能包含小写字母、数字、下划线和连字符'),
  icon: z.string().max(50, '图标名称不能超过50个字符').optional().default(''),
  description: z.string().max(200, '描述不能超过200个字符').optional().default(''),
  color: z.string().min(1, '请选择颜色'),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

export type CategoryFormData = z.infer<typeof categorySchema>;

// ─── Emoji presets ─────────────────────────────────────────────────────────────
const ICON_EMOJIS = [
  '📚', '📖', '✨', '🔥', '💪', '💕', '🌟', '⚔️',
  '🏰', '🐉', '🧙', '👑', '🗡️', '🌊', '🌙', '⚡',
  '🌸', '🍃', '👻', '🚀', '🎭', '🎵', '🎲', '🔮',
  '🐱', '🦊', '🐯', '🦅', '💎', '🎯', '🏆', '❤️',
];

// ─── Props ────────────────────────────────────────────────────────────────────
interface CategoryFormDialogProps {
  open: boolean;
  editingCategory: Category | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: (data: CategoryFormData) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function CategoryFormDialog({
  open,
  editingCategory,
  saving,
  onClose,
  onSubmit: onSubmitProp,
}: CategoryFormDialogProps) {
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    getValues,
    watch,
    formState: { errors },
  } = useForm<CategoryFormData>({
    resolver: safeResolver(categorySchema),
  });

  const selectedColor = watch('color');
  const watchedIcon = watch('icon');
  const watchedName = watch('name');

  // Auto-generate slug from name when creating (not editing)
  useEffect(() => {
    if (!editingCategory && watchedName) {
      const currentSlug = getValues('slug');
      if (!currentSlug) {
        const slug = watchedName
          .toLowerCase()
          .replace(/[\u4e00-\u9fa5]/g, '')
          .replace(/[^a-z0-9_-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');
        if (slug) setValue('slug', slug);
      }
    }
  }, [watchedName, editingCategory, setValue, getValues]);

  // Reset form when dialog state changes
  useEffect(() => {
    if (open && editingCategory) {
      reset({
        name: editingCategory.name,
        slug: editingCategory.slug,
        icon: editingCategory.icon ?? '',
        description: editingCategory.description ?? '',
        color: editingCategory.color,
        sortOrder: editingCategory.sortOrder,
      });
    } else if (open) {
      reset({ name: '', slug: '', icon: '', description: '', color: '#10b981', sortOrder: 0 });
    }
  }, [open, editingCategory, reset]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editingCategory ? '编辑分类' : '新建分类'}</DialogTitle>
          <DialogDescription>
            {editingCategory ? '修改分类信息' : '填写分类信息创建新分类'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmitProp)} className="space-y-4">
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

          {/* Slug */}
          <div className="space-y-2">
            <Label htmlFor="cat-slug">
              标识符 (Slug) <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cat-slug"
              placeholder="如: yanqing, dushi, xianxia"
              {...register('slug')}
            />
            <p className="text-xs text-muted-foreground">
              URL 友好标识符，只能包含小写字母、数字、下划线和连字符
            </p>
            {errors.slug && (
              <p className="text-xs text-destructive">{errors.slug.message}</p>
            )}
          </div>

          {/* Icon */}
          <div className="space-y-2">
            <Label htmlFor="cat-icon" className="flex items-center gap-1.5">
              <SmilePlus className="h-3.5 w-3.5" />
              图标
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="cat-icon"
                placeholder="点击下方选择 Emoji"
                {...register('icon')}
                className="flex-1"
              />
              {watchedIcon && (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-lg">
                  {watchedIcon}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-2">
              {ICON_EMOJIS.map((emoji) => {
                const isSelected = watchedIcon === emoji;
                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => setValue('icon', isSelected ? '' : emoji)}
                    className={`flex h-8 w-8 items-center justify-center rounded-md text-base transition-all hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isSelected
                        ? 'bg-primary/15 ring-2 ring-primary scale-110'
                        : 'hover:bg-muted'
                    }`}
                    aria-label={`选择图标 ${emoji}`}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              选择一个 Emoji 或手动输入 Lucide 图标名称（如 Sword、Flame）
            </p>
            {errors.icon && (
              <p className="text-xs text-destructive">{errors.icon.message}</p>
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
            <ColorPicker value={selectedColor} onChange={(v) => setValue('color', v)} />
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
              onClick={onClose}
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
  );
}
