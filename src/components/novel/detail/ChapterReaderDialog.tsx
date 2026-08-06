'use client';

import { useState, useEffect } from 'react';
import { BookX, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { Chapter } from '@/types';

export interface ChapterReaderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chapter: Chapter | null;
  chapters: Chapter[];
  onNavigate: (chapter: Chapter) => void;
}

export function ChapterReaderDialog({
  open,
  onOpenChange,
  chapter,
  chapters,
  onNavigate,
}: ChapterReaderDialogProps) {
  // Component is remounted via key prop on every open / chapter-nav, so
  // initial state is always fresh.
  const hasInlineContent = !!(chapter?.content?.trim());
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(!hasInlineContent);

  const chapterIndex = chapter ? chapters.findIndex((c) => c.id === chapter.id) : -1;
  const prevChapter = chapterIndex > 0 ? chapters[chapterIndex - 1] : null;
  const nextChapter = chapterIndex >= 0 && chapterIndex < chapters.length - 1 ? chapters[chapterIndex + 1] : null;

  // Derive what to display: prefer inline content, fall back to fetched
  const inlineContent = chapter?.content?.trim() || null;
  const displayContent = open ? (inlineContent ?? content) : '';
  const isLoading = open && !inlineContent && loading;
  const wordCount = displayContent.length;

  // Fetch chapter content when it is not already available inline
  useEffect(() => {
    if (!chapter || !open) return;
    if (chapter.content?.trim()) return;

    const ac = new AbortController();
    const loadContent = async () => {
      try {
        const data = await apiFetch<{ title: string; content: string }>(`/api/chapters/${chapter.id}`, { signal: ac.signal });
        setContent(data.content || '');
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setContent('');
      } finally {
        setLoading(false);
      }
    };

    loadContent();

    return () => ac.abort();
  }, [chapter, open]);

  // Keyboard navigation
  useEffect(() => {
    if (!open || !chapter) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && prevChapter) {
        e.preventDefault();
        onNavigate(prevChapter);
      } else if (e.key === 'ArrowRight' && nextChapter) {
        e.preventDefault();
        onNavigate(nextChapter);
      } else if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, chapter, prevChapter, nextChapter, onNavigate, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-0 shrink-0">
          <DialogTitle className="text-lg font-semibold leading-tight">
            {chapter?.title ?? ''}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {chapter && (
              <span>第 {chapterIndex + 1} / {chapters.length} 章</span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-5/6" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-5/6" />
            </div>
          ) : displayContent.trim() ? (
            <div
              className="mx-auto max-w-prose text-foreground leading-[1.9] tracking-wide text-[15px]"
              style={{ fontFamily: '"Noto Serif SC", "Source Han Serif SC", "STSong", Georgia, serif' }}
            >
              {displayContent.split('\n').map((paragraph, i) => (
                <p
                  key={i}
                  className={paragraph.trim() === '' ? 'h-4' : 'text-indent-[2em] mb-1'}
                >
                  {paragraph.trim()}
                </p>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <BookX className="size-10 mb-3 opacity-30" />
              <p className="text-sm">该章节暂无内容</p>
            </div>
          )}
        </div>

        {/* Footer with word count and navigation */}
        <div className="shrink-0 border-t px-6 py-3 flex items-center justify-between bg-muted/30">
          <span className="text-xs text-muted-foreground tabular-nums">
            {wordCount.toLocaleString()} 字
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1"
              disabled={!prevChapter}
              onClick={() => prevChapter && onNavigate(prevChapter)}
            >
              <ChevronLeft className="size-3.5" />
              上一章
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1"
              disabled={!nextChapter}
              onClick={() => nextChapter && onNavigate(nextChapter)}
            >
              下一章
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
