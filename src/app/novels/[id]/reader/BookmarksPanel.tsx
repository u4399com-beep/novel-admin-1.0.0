'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { BookmarkCheck, X } from 'lucide-react';
import type { BookmarkEntry, Chapter } from './types';

export interface BookmarksPanelProps {
  visible: boolean;
  bookmarks: BookmarkEntry[];
  chapters: Chapter[];
  currentIndex: number;
  onLoadChapter: (index: number) => void;
  onSaveProgress: (chapterIndex: number) => void;
  onRemoveBookmark: (chapterIndex: number) => void;
  onClearAllBookmarks: () => void;
}

export function BookmarksPanel({
  visible,
  bookmarks,
  chapters,
  currentIndex,
  onLoadChapter,
  onSaveProgress,
  onRemoveBookmark,
  onClearAllBookmarks,
}: BookmarksPanelProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 200, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="shrink-0 border-l overflow-hidden"
        >
          <div className="w-[200px] h-full overflow-y-auto p-3 flex flex-col scrollbar-thin">
            <div className="flex items-center justify-between mb-2 px-1">
              <div className="text-xs font-medium text-muted-foreground">
                书签 ({bookmarks.length})
              </div>
              {bookmarks.length > 0 && (
                <button
                  className="text-[10px] text-destructive/60 hover:text-destructive transition-colors"
                  onClick={onClearAllBookmarks}
                >
                  清空
                </button>
              )}
            </div>

            {bookmarks.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 py-8">
                <BookmarkCheck className="h-6 w-6 bookmark-empty-icon" />
                <p className="text-[11px] text-muted-foreground/60 text-center">点击工具栏书签图标<br />添加当前章节</p>
              </div>
            ) : (
              <div className="flex-1 space-y-1">
                {bookmarks.map((bm) => {
                  const ch = chapters[bm.chapterIndex];
                  if (!ch) return null;
                  const isCurrent = bm.chapterIndex === currentIndex;
                  return (
                    <button
                      key={bm.chapterIndex}
                      onClick={() => {
                        onLoadChapter(bm.chapterIndex);
                        onSaveProgress(bm.chapterIndex);
                      }}
                      className={
                        'block w-full text-left rounded-md px-2 py-2 transition-colors group ' +
                        (isCurrent
                          ? 'bg-amber-500/10 border border-amber-500/20'
                          : 'hover:bg-muted/50 border border-transparent')
                      }
                    >
                      <div className="flex items-start gap-1.5">
                        <BookmarkCheck className={`h-3 w-3 mt-0.5 shrink-0 ${isCurrent ? 'text-amber-500' : 'text-amber-500/50'}`} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-[11px] leading-tight truncate ${isCurrent ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-foreground'}`}>
                            {bm.chapterTitle}
                          </p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[9px] text-muted-foreground/60 tabular-nums">
                              {bm.scrollPercent}%
                            </span>
                            <span className="text-muted-foreground/30">·</span>
                            <span className="text-[9px] text-muted-foreground/60">
                              {new Date(bm.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                            </span>
                          </div>
                        </div>
                        <button
                          className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded hover:bg-destructive/10 text-muted-foreground/40 hover:text-destructive transition-all shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveBookmark(bm.chapterIndex);
                          }}
                          aria-label={`移除书签: ${bm.chapterTitle}`}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
