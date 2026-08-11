'use client';

import React from 'react';
import { motion } from 'framer-motion';
import {
  CheckCircle2,
  Circle,
  FileText,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DailyReadingGoal } from '@/components/DailyReadingGoal';
import { formatReadingTime } from '@/lib/format';
import type { Chapter, BookmarkEntry } from '../reader/types';

const CHAPTERS_PER_PAGE = 100;

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const itemVariants = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
};

/* ------------------------------------------------------------------ */
/*  Memoized Chapter Item                                             */
/* ------------------------------------------------------------------ */

interface MemoizedChapterItemProps {
  chapter: Chapter;
  globalIndex: number;
  isBookmarked: boolean;
  isLastChapter: boolean;
  onOpenReader: (index: number) => void;
}

const MemoizedChapterItem = React.memo(function MemoizedChapterItem({
  chapter,
  globalIndex,
  isBookmarked,
  isLastChapter,
  onOpenReader,
}: MemoizedChapterItemProps) {
  return (
    <motion.button
      variants={itemVariants}
      onClick={() => onOpenReader(globalIndex)}
      className={
        'chapter-row flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors border-b last:border-b-0 group ' +
        (globalIndex % 2 === 0 ? '' : 'bg-muted/30') +
        (isLastChapter ? ' bg-primary/5 border-l-2 border-l-primary' : '')
      }
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">{chapter.sortOrder}.</span>
        {chapter.wordCount > 0
          ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500/60" />
          : <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/30" />
        }
        <span className="text-sm truncate group-hover:text-primary transition-colors">
          {chapter.title}
        </span>
        {isBookmarked && (
          <BookmarkCheck className="h-3 w-3 shrink-0 text-amber-500" />
        )}
        {chapter.wordCount > 0 && (
          <span className="text-xs text-muted-foreground/60 shrink-0 tabular-nums">
            {chapter.wordCount}字{formatReadingTime(chapter.wordCount) && ` · ${formatReadingTime(chapter.wordCount)}`}
          </span>
        )}
      </div>
      {isLastChapter && (
        <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 text-primary border-primary/30 badge-transition">
          上次
        </Badge>
      )}
    </motion.button>
  );
});

/* ------------------------------------------------------------------ */
/*  Main exported component                                           */
/* ------------------------------------------------------------------ */

export interface ChapterListSectionProps {
  chapters: Chapter[];
  displayedChapters: Chapter[];
  chapterPage: number;
  chapterTotalPages: number;
  lastChapterIndex: number | null;
  onOpenReader: (index: number) => void;
  isBookmarked: (index: number) => boolean;
  filterBookmarks: boolean;
  onToggleFilterBookmarks: () => void;
  bookmarks: BookmarkEntry[];
  onBookmarkManagerOpen: () => void;
  chaptersWithContent: number;
  contentProgress: number;
  onChapterPageChange: (page: number | ((prev: number) => number)) => void;
}

export function ChapterListSection({
  chapters,
  displayedChapters,
  chapterPage,
  chapterTotalPages,
  lastChapterIndex,
  onOpenReader,
  isBookmarked,
  filterBookmarks,
  onToggleFilterBookmarks,
  bookmarks,
  onBookmarkManagerOpen,
  chaptersWithContent,
  contentProgress,
  onChapterPageChange,
}: ChapterListSectionProps) {
  const visibleChapters = chapters.slice(
    (chapterPage - 1) * CHAPTERS_PER_PAGE,
    chapterPage * CHAPTERS_PER_PAGE,
  );

  return (
    <section className="py-8">
      <div className="flex items-center justify-between border-b pb-3 mb-4">
        <h2 className="text-lg font-semibold tracking-tight">章节目录</h2>
        <div className="flex items-center gap-2">
          {chaptersWithContent > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="text-foreground font-medium tabular-nums">{chaptersWithContent}</span>/{chapters.length} 有内容
            </span>
          )}
          <span className="text-sm text-muted-foreground tabular-nums">
            共 {chapters.length} 章
          </span>
        </div>
      </div>

      {/* Content progress bar */}
      {chapters.length > 0 && (
        <div className="mb-4 flex items-center gap-3">
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden progress-bar-animated">
            <div
              className="h-full rounded-full bg-primary/70 progress-smooth"
              style={{ width: `${contentProgress}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">{contentProgress}%</span>
        </div>
      )}

      {/* Daily reading goal */}
      <div className="flex justify-center mb-4">
        <DailyReadingGoal />
      </div>

      {/* Chapter list header with bookmark filter */}
      {chapters.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-muted-foreground">
            章节目录{bookmarks.length > 0 && ` (${bookmarks.length}个书签)`}
          </span>
          <div className="flex items-center gap-2">
            <button
              role="switch"
              aria-checked={filterBookmarks}
              onClick={onToggleFilterBookmarks}
              className={`text-xs px-2 py-1 rounded-md transition-colors ${filterBookmarks ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
            >
              {filterBookmarks ? '显示全部' : '仅书签'}
            </button>
            {bookmarks.length > 0 && (
              <button
                onClick={onBookmarkManagerOpen}
                className="text-xs px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <BookmarkCheck className="h-3 w-3 inline-block mr-0.5 -mt-px" />
                书签管理
              </button>
            )}
          </div>
        </div>
      )}

      {displayedChapters.length === 0 ? (
        <div className="py-16 text-center">
          {filterBookmarks ? (
            <>
              <BookmarkCheck className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">暂无书签</p>
            </>
          ) : (
            <>
              <FileText className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">暂无章节</p>
            </>
          )}
        </div>
      ) : (
        <>
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="show"
            key={chapterPage}
            className="max-h-[600px] overflow-y-auto rounded-lg border scrollbar-thin chapter-list-scroll"
          >
            {visibleChapters.map((chapter, localIndex) => {
              const globalIndex = (chapterPage - 1) * CHAPTERS_PER_PAGE + localIndex;
              return (
                <MemoizedChapterItem
                  key={chapter.id}
                  chapter={chapter}
                  globalIndex={globalIndex}
                  isBookmarked={isBookmarked(globalIndex)}
                  isLastChapter={lastChapterIndex === globalIndex}
                  onOpenReader={onOpenReader}
                />
              );
            })}
          </motion.div>
          {/* Chapter pagination */}
          {chapterTotalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={chapterPage <= 1}
                onClick={() => onChapterPageChange((p: number) => p - 1)}
                className="gap-1"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                上一页
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                {chapterPage} / {chapterTotalPages}
                <span className="ml-1.5 text-xs">(第{(chapterPage - 1) * CHAPTERS_PER_PAGE + 1}-{Math.min(chapterPage * CHAPTERS_PER_PAGE, chapters.length)}章)</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={chapterPage >= chapterTotalPages}
                onClick={() => onChapterPageChange((p: number) => p + 1)}
                className="gap-1"
              >
                下一页
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
