'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod/v4';
import { safeResolver } from '@/lib/safe-resolver';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { Loader2, Eye, EyeOff, Type } from 'lucide-react';

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
import { Separator } from '@/components/ui/separator';
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

// ─── Format word count display ──────────────────────────────────────────────

function formatWordCount(count: number): string {
  const thousands = (count / 1000).toFixed(1);
  return `${count.toLocaleString()}字 (约${thousands}千字)`;
}

// ─── Extract chapter number from title ─────────────────────────────────────

function extractChapterNumber(title: string): number | null {
  // Match patterns like "第12章", "第十二章", "Chapter 12", etc.
  const patterns = [
    /第([一二三四五六七八九十百千万零\d]+)章/,
    /chapter\s*(\d+)/i,
    /(\d+)\s*$/,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const raw = match[1];
      // Try to convert Chinese numerals
      const chineseMap: Record<string, number> = {
        '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
        '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
        '十': 10, '百': 100, '千': 1000, '万': 10000,
      };
      const numericMatch = raw.match(/^\d+$/);
      if (numericMatch) return parseInt(numericMatch[0], 10);
      // Simple Chinese numeral conversion (supports 1-999)
      let result = 0;
      let current = 0;
      for (const char of raw) {
        if (chineseMap[char] !== undefined) {
          const val = chineseMap[char];
          if (val >= 10) {
            if (current === 0) current = 1;
            result += current * val;
            current = 0;
          } else {
            current = val;
          }
        }
      }
      result += current;
      return result > 0 ? result : null;
    }
  }
  return null;
}

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
  const watchedTitle = form.watch('title');
  const wordCount = watchedContent ? watchedContent.length : 0;

  // Preview mode toggle
  const [isPreview, setIsPreview] = useState(false);

  // Reset form when dialog opens/closes or editingChapter changes
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);

  // Auto-suggest next chapter number for new chapters
  const [titlePlaceholder, setTitlePlaceholder] = useState('请输入章节标题');

  // Fetch existing chapters to determine next chapter number
  useEffect(() => {
    if (!chapterFormOpen || isEditing || !selectedNovelId) return;

    const fetchChapterCount = async () => {
      try {
        const data = await apiFetch<{ chapters?: Chapter[] }>(`/api/novels/${selectedNovelId}/chapters`);
        const chapters = data.chapters || [];

        if (chapters.length === 0) {
          setTitlePlaceholder('请输入章节标题，如：第一章 开始');
          return;
        }

        // Find the highest chapter number
        let maxNum = 0;
        for (const ch of chapters) {
          const num = extractChapterNumber(ch.title);
          if (num !== null && num > maxNum) {
            maxNum = num;
          }
        }

        const nextNum = maxNum + 1;
        setTitlePlaceholder(`第${nextNum}章`);
      } catch {
        setTitlePlaceholder('请输入章节标题');
      }
    };

    fetchChapterCount();
  }, [chapterFormOpen, isEditing, selectedNovelId]);

  useEffect(() => {
    if (chapterFormOpen) {
      setIsPreview(false);
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
        setIsPreview(false);
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
        // Only send content if we successfully fetched it or user typed new content
        // Never send empty string for content on edit — it would erase existing content
        if (fetchedContent !== null || values.content.trim()) {
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

  // Rendered content for preview mode
  const previewContent = useMemo(() => {
    if (!watchedContent) return null;
    return watchedContent.split('\n').map((paragraph, i) => (
      <p
        key={i}
        className={paragraph.trim() === '' ? 'h-4' : 'text-indent-[2em] mb-2 leading-[1.9]'}
      >
        {paragraph.trim()}
      </p>
    ));
  }, [watchedContent]);

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
                      placeholder={titlePlaceholder}
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
                  {/* Content toolbar */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FormLabel className="mb-0">章节内容</FormLabel>
                      <Button
                        type="button"
                        variant={isPreview ? 'default' : 'outline'}
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => setIsPreview(!isPreview)}
                      >
                        {isPreview ? (
                          <>
                            <Type className="size-3.5" />
                            编辑
                          </>
                        ) : (
                          <>
                            <Eye className="size-3.5" />
                            预览
                          </>
                        )}
                      </Button>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatWordCount(wordCount)}
                    </span>
                  </div>

                  <Separator className="my-1" />

                  <FormControl>
                    {isPreview ? (
                      <div className="flex-1 min-h-[300px] overflow-y-auto max-h-[50vh] rounded-md border border-input bg-background p-4 text-foreground leading-[1.9] tracking-wide text-sm">
                        {watchedContent && watchedContent.trim() ? (
                          previewContent
                        ) : (
                          <p className="text-muted-foreground text-center py-8">
                            暂无内容可预览
                          </p>
                        )}
                      </div>
                    ) : (
                      <Textarea
                        placeholder="请输入章节内容..."
                        className="flex-1 min-h-[300px] resize-none font-mono text-sm leading-relaxed"
                        {...field}
                      />
                    )}
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
