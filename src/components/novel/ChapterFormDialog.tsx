'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import { Form } from '@/components/ui/form';
import { useAppStore } from '@/stores/app-store';
import type { Chapter } from '@/types';
import { ChapterMetaFields } from './chapter/ChapterMetaFields';
import { ChapterContentEditor } from './chapter/ChapterContentEditor';

const chapterSchema = z.object({
  title: z.string().min(1, '章节标题不能为空').max(200, '标题最多200个字符'),
  content: z.string().max(500000, '内容不能超过50万字'),
});

type ChapterFormValues = z.infer<typeof chapterSchema>;

// ─── Extract chapter number from title ─────────────────────────────────────

function extractChapterNumber(title: string): number | null {
  const patterns = [
    /第([一二三四五六七八九十百千万零\d]+)章/,
    /chapter\s*(\d+)/i,
    /(\d+)\s*$/,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) {
      const raw = match[1];
      const chineseMap: Record<string, number> = {
        '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
        '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
        '十': 10, '百': 100, '千': 1000, '万': 10000,
      };
      const numericMatch = raw.match(/^\d+$/);
      if (numericMatch) return parseInt(numericMatch[0], 10);
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
    defaultValues: { title: '', content: '' },
  });

  const watchedContent = form.watch('content');
  const wordCount = watchedContent ? watchedContent.length : 0;

  const [isPreview, setIsPreview] = useState(false);
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [titlePlaceholder, setTitlePlaceholder] = useState('请输入章节标题');

  useEffect(() => {
    if (!chapterFormOpen || isEditing || !selectedNovelId) return;
    const ac = new AbortController();
    const fetchChapterCount = async () => {
      try {
        const data = await apiFetch<{ chapters?: Chapter[] }>(`/api/novels/${selectedNovelId}/chapters`, { signal: ac.signal });
        if (ac.signal.aborted) return;
        const chapters = data.chapters || [];
        if (chapters.length === 0) {
          setTitlePlaceholder('请输入章节标题，如：第一章 开始');
          return;
        }
        let maxNum = 0;
        for (const ch of chapters) {
          const num = extractChapterNumber(ch.title);
          if (num !== null && num > maxNum) maxNum = num;
        }
        setTitlePlaceholder(`第${maxNum + 1}章`);
      } catch {
        setTitlePlaceholder('请输入章节标题');
      }
    };
    fetchChapterCount();
    return () => ac.abort();
  }, [chapterFormOpen, isEditing, selectedNovelId]);

  useEffect(() => {
    if (chapterFormOpen) {
      setIsPreview(false);
      if (editingChapter) {
        setIsLoadingContent(true);
        const ac = new AbortController();
        abortRef.current = ac;
        apiFetch<Chapter>(`/api/chapters/${editingChapter.id}`, { signal: ac.signal })
          .then((full) => {
            if (ac.signal.aborted) return;
            form.reset({ title: full.title, content: full.content || '' });
            setFetchedContent(full.content || '');
          })
          .catch(() => {
            if (ac.signal.aborted) return;
            form.reset({ title: editingChapter.title, content: '' });
            setFetchedContent(null);
          })
          .finally(() => {
            if (!ac.signal.aborted) setIsLoadingContent(false);
          });
        return () => { ac.abort(); abortRef.current = null; };
      } else {
        form.reset({ title: '', content: '' });
        setFetchedContent(null);
      }
    } else {
      setFetchedContent(null);
      setIsLoadingContent(false);
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
        const body: Record<string, unknown> = { title: values.title };
        if (fetchedContent !== null && values.content !== fetchedContent) {
          body.content = values.content;
        } else if (fetchedContent === null && values.content.trim()) {
          body.content = values.content;
        }
        await apiFetch(`/api/chapters/${editingChapter.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        toast.success('章节已更新');
      } else {
        await apiFetch(`/api/novels/${selectedNovelId}/chapters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: values.title, content: values.content }),
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

        {isLoadingContent && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">正在加载章节内容...</span>
          </div>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 flex-1 overflow-hidden">
            <ChapterMetaFields form={form} titlePlaceholder={titlePlaceholder} />
            <ChapterContentEditor form={form} isPreview={isPreview} setIsPreview={setIsPreview} wordCount={wordCount} />
            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={() => handleClose(false)}>取消</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="size-4 animate-spin" />}
                {isEditing ? '保存修改' : '创建章节'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
