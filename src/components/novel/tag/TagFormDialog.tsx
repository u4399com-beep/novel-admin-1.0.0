'use client';

import React from 'react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod/v4';
import { safeResolver } from '@/lib/safe-resolver';
import { Loader2, Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import type { Tag } from '@/types';

// ─── Zod Schema ────────────────────────────────────────────────────────────
const tagSchema = z.object({
  name: z.string().min(1, '标签名称不能为空').max(30, '标签名称不能超过30个字符'),
  color: z.string().min(1, '请选择颜色'),
});

export type TagFormValues = z.infer<typeof tagSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────────
function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

const TAG_PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#0ea5e9', '#6366f1', '#8b5cf6', '#d946ef',
  '#ec4899', '#f43f5e', '#78716c', '#64748b',
];

// ─── Props ────────────────────────────────────────────────────────────────────
interface TagFormDialogProps {
  open: boolean;
  editingTag: Tag | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: TagFormValues) => void;
}

// ─── Component ─────────────────────────────────────────────────────────────
export function TagFormDialog({
  open,
  editingTag,
  submitting,
  onClose,
  onSubmit: onSubmitProp,
}: TagFormDialogProps) {
  const form = useForm<TagFormValues>({
    resolver: safeResolver(tagSchema),
    defaultValues: {
      name: '',
      color: '#22c55e',
    },
  });

  // Reset form when dialog state changes
  useEffect(() => {
    if (open && editingTag) {
      form.reset({ name: editingTag.name, color: editingTag.color });
    } else if (open) {
      form.reset({ name: '', color: '#22c55e' });
    }
  }, [open, editingTag, form]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
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
          <form onSubmit={form.handleSubmit(onSubmitProp)} className="space-y-4">
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
                  <div className="space-y-3">
                    {/* Preview */}
                    <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
                      <span
                        className="inline-block h-5 w-5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/10"
                        style={{ backgroundColor: field.value }}
                      />
                      <span
                        className="rounded-md px-2 py-0.5 text-sm font-medium"
                        style={{ backgroundColor: field.value + '20', color: field.value }}
                      >
                        {form.watch('name') || '标签预览'}
                      </span>
                    </div>
                    {/* Preset color buttons */}
                    <div className="flex flex-wrap gap-1.5">
                      {TAG_PRESET_COLORS.map((c) => {
                        const isActive = field.value.toLowerCase() === c.toLowerCase();
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => field.onChange(c)}
                            className={`h-7 w-7 rounded-full border-2 transition-all hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                              isActive
                                ? 'border-foreground scale-110 ring-2 ring-ring ring-offset-2 ring-offset-background'
                                : 'border-transparent'
                            }`}
                            style={{ backgroundColor: c }}
                            aria-label={`选择颜色 ${c}`}
                          />
                        );
                      })}
                    </div>
                    {/* Custom color input */}
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={field.value}
                        onChange={(e) => field.onChange(e.target.value)}
                        className="h-8 w-8 cursor-pointer rounded-md border border-input bg-transparent p-0.5 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-none"
                      />
                      <span className="font-mono text-xs text-muted-foreground">
                        {field.value}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto text-xs"
                        onClick={() => field.onChange(hashColor(form.watch('name') || 'tag'))}
                      >
                        自动取色
                      </Button>
                    </div>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={submitting}
              >
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {submitting ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
