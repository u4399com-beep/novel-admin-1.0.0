'use client';

import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';

interface ChapterContentGridProps {
  chapters: Array<{ id: string; title: string; wordCount: number; sortOrder: number }>;
  currentChapterIndex?: number | null;
  onOpenReader?: (index: number) => void;
  maxDisplay?: number;
}

export function ChapterContentGrid({
  chapters,
  currentChapterIndex,
  onOpenReader,
  maxDisplay = 200,
}: ChapterContentGridProps) {
  if (chapters.length === 0) return null;

  const total = chapters.length;
  const displayChapters = chapters.slice(0, maxDisplay);
  const hasMore = total > maxDisplay;

  const chaptersWithContent = chapters.filter((c) => c.wordCount > 0).length;
  const contentPercent = Math.round((chaptersWithContent / total) * 100);
  const isComplete = chaptersWithContent === total;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35, duration: 0.35 }}
      className="rounded-lg border bg-muted/20 p-3"
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-foreground">章节录入概览</span>
        {isComplete && (
          <Badge variant="secondary" className="h-5 text-[10px] px-1.5 font-medium bg-primary/10 text-primary border-primary/20">
            100% 已录入
          </Badge>
        )}
        <span className="ml-auto text-xs font-medium tabular-nums">
          {contentPercent}%
        </span>
      </div>

      {/* Grid */}
      <div className="grid grid-flow-col grid-rows-[auto_1fr_auto] gap-px overflow-x-auto">
        {/* Row grouping: every ~40 items form a visual row */}
        <div className="flex flex-wrap max-w-full" style={{ maxWidth: 'calc(2.5rem * 40 + 39px)' }}>
          {displayChapters.map((chapter, idx) => {
            const hasContent = chapter.wordCount > 0;
            const isCurrent = currentChapterIndex === idx;

            return (
              <button
                key={chapter.id}
                type="button"
                disabled={!onOpenReader}
                onClick={() => onOpenReader?.(idx)}
                title={`第${chapter.sortOrder}章 ${chapter.title}${hasContent ? ` · ${chapter.wordCount.toLocaleString()}字` : ' · 暂无内容'}`}
                className={[
                  'h-2.5 w-2.5 sm:h-3 sm:w-3 rounded-[2px] transition-colors shrink-0',
                  hasContent
                    ? 'bg-primary'
                    : 'bg-muted-foreground/20',
                  isCurrent
                    ? 'ring-2 ring-primary ring-offset-1 ring-offset-background'
                    : '',
                  onOpenReader
                    ? 'cursor-pointer hover:ring-1 hover:ring-foreground/30'
                    : 'cursor-default',
                ].join(' ')}
                aria-label={`第${chapter.sortOrder}章 ${chapter.title}${hasContent ? ` · ${chapter.wordCount.toLocaleString()}字` : ' · 暂无内容'}`}
              />
            );
          })}
        </div>
      </div>

      {/* Truncation hint */}
      {hasMore && (
        <div className="mt-1.5 text-[10px] text-muted-foreground">
          仅显示前 {maxDisplay} 章，共 {total} 章…
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[1px] bg-primary shrink-0" />
          <span>有内容</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[1px] bg-muted-foreground/20 shrink-0" />
          <span>无内容</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[1px] bg-primary ring-2 ring-primary ring-offset-1 ring-offset-background shrink-0" />
          <span>当前章节</span>
        </div>
        <span className="ml-auto text-[10px] tabular-nums">
          {chaptersWithContent}/{total} 章
        </span>
      </div>
    </motion.div>
  );
}
