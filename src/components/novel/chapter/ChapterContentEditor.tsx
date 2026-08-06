'use client';

import { useMemo } from 'react';
import { Eye, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import type { UseFormReturn } from 'react-hook-form';

interface ChapterFormValues {
  title: string;
  content: string;
}

interface ChapterContentEditorProps {
  form: UseFormReturn<ChapterFormValues>;
  isPreview: boolean;
  setIsPreview: (v: boolean) => void;
  wordCount: number;
}

function formatWordCount(count: number): string {
  const thousands = (count / 1000).toFixed(1);
  return `${count.toLocaleString()}字 (约${thousands}千字)`;
}

export function ChapterContentEditor({ form, isPreview, setIsPreview, wordCount }: ChapterContentEditorProps) {
  const watchedContent = form.watch('content');

  const previewContent = useMemo(() => {
    if (!watchedContent) return null;
    return watchedContent.split('\n').map((paragraph, i) => (
      <p key={i} className={paragraph.trim() === '' ? 'h-4' : 'text-indent-[2em] mb-2 leading-[1.9]'}>
        {paragraph.trim()}
      </p>
    ));
  }, [watchedContent]);

  return (
    <FormField
      control={form.control}
      name="content"
      render={({ field }) => (
        <FormItem className="flex-1 flex flex-col overflow-hidden">
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
                  <><Type className="size-3.5" />编辑</>
                ) : (
                  <><Eye className="size-3.5" />预览</>
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
                  <p className="text-muted-foreground text-center py-8">暂无内容可预览</p>
                )}
              </div>
            ) : (
              <Textarea
                placeholder="请输入章节内容..."
                className="flex-1 min-h-[300px] resize-none font-mono text-sm leading-relaxed"
                {...field}
                aria-label="章节内容"
              />
            )}
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
