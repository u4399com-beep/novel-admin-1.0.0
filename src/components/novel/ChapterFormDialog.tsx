'use client';

import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod/v4';
import { safeResolver } from '@/lib/safe-resolver';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';
import { useAppStore } from '@/stores/app-store';
import type { Chapter } from '@/types';

const chapterSchema = z.object({
  title: z.string().min(1, '章节标题不能为空').max(200, '标题最多200个字符'),
  content: z.string().max(1000000, '内容过长'),
});

type ChapterFormValues = z.infer<typeof chapterSchema>;

export function ChapterFormDialog() {
  const chapterFormOpen = useAppStore((s) => s.chapterFormOpen);
  const setChapterFormOpen = useAppStore((s) => s.setChapterFormOpen);
  const editingChapter = useAppStore((s) => s.editingChapter);
  const setEditingChapter = useAppStore((s) => s.setEditingChapter);
  const selectedNovelId = useAppStore((s) => s.selectedNovelId);
  const triggerRefresh = useAppStore((s) => s.triggerRefresh);

  const isEditing = !!editingChapter;

  const form = useForm<ChapterFormValues>({
    resolver: safeResolver(chapterSchema),
    defaultValues: {
      title: '',
      content: '',
    },
  });

  const watchedContent = form.watch('content');
  const wordCount = watchedContent ? watchedContent.length : 0;

  // Reset form when dialog opens/closes or editingChapter changes
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);

  useEffect(() => {
    if (chapterFormOpen) {
      if (editingChapter) {
        // Fetch full chapter content since list API doesn't include it
        apiFetch<Chapter>(`/api/chapters/${editingChapter.id}`)
          .then((full) => {
            form.reset({
              title: full.title,
              content: full.content || '',
            });
            setFetchedContent(full.content || '');
          })
          .catch(() => {
            // Fallback to editingChapter data (content may be undefined)
            form.reset({
              title: editingChapter.title,
              content: '',
            });
            setFetchedContent(null);
          });
      } else {
        form.reset({
          title: '',
          content: '',
        });
        setFetchedContent(null);
      }
    } else {
      setFetchedContent(null);
    }
  }, [chapterFormOpen, editingChapter, form]);

  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) {
        setChapterFormOpen(false);
        setEditingChapter(null);
        form.reset({ title: '', content: '' });
      }
    },
    [setChapterFormOpen, setEditingChapter, form],
  );

  const onSubmit = async (values: ChapterFormValues) => {
    if (!selectedNovelId) return;

    try {
        if (isEditing && editingChapter) {
        // Update existing chapter
        const body: Record<string, unknown> = { title: values.title };
        // Only include content if we actually have it (fetched or new chapter)
        // Never send empty string for content on edit — it would erase existing content
        if (fetchedContent !== null || !isEditing) {
          body.content = values.content;
        }
        await apiFetch(`/api/chapters/${editingChapter.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        toast.success('章节已更新');
      } else {
        // Create new chapter
        await apiFetch(`/api/novels/${selectedNovelId}/chapters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: values.title,
            content: values.content,
          }),
        });

        toast.success('章节已创建');
      }

      handleClose(false);
      triggerRefresh('chapters');
      triggerRefresh('novels');
    } catch { /* handled by apiFetch */ }
  };

  return (
    <Dialog open={chapterFormOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{isEditing ? '编辑章节' : '新建章节'}</DialogTitle>
          <DialogDescription>
            {isEditing ? '修改章节的标题和内容' : '为新小说创建一个章节'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-4 flex-1 overflow-hidden"
          >
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>章节标题</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="请输入章节标题"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="content"
              render={({ field }) => (
                <FormItem className="flex-1 flex flex-col overflow-hidden">
                  <div className="flex items-center justify-between">
                    <FormLabel>章节内容</FormLabel>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {wordCount.toLocaleString()} 字
                    </span>
                  </div>
                  <FormControl>
                    <Textarea
                      placeholder="请输入章节内容..."
                      className="flex-1 min-h-[300px] resize-none font-mono text-sm leading-relaxed"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleClose(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {isEditing ? '保存修改' : '创建章节'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}