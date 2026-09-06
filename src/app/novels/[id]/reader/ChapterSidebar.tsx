'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { ChevronLeft, ChevronRight, Pin, PinOff } from 'lucide-react';
import type { Chapter } from './types';

export interface ChapterSidebarProps {
  visible: boolean;
  chapters: Chapter[];
  sidebarPage: number;
  sidebarTotalPages: number;
  currentIndex: number;
  lastChapterIndex: number | null;
  sidebarPageSize?: number;
  onLoadChapter: (index: number) => void;
  onSidebarPageChange: (page: number | ((prev: number) => number)) => void;
  floating?: boolean;
  onToggleFloating?: () => void;
}

export function ChapterSidebar({
  visible,
  chapters,
  sidebarPage,
  sidebarTotalPages,
  currentIndex,
  lastChapterIndex,
  sidebarPageSize = 200,
  onLoadChapter,
  onSidebarPageChange,
  floating = false,
  onToggleFloating,
}: ChapterSidebarProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 220, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className={`shrink-0 border-r overflow-hidden ${floating ? 'floating-toc' : ''}`}
        >
          <div className="w-[220px] h-full flex flex-col p-3">
            <div className="flex items-center justify-between mb-2 px-1 shrink-0">
              <span className="text-xs font-medium text-muted-foreground">
                目录 ({chapters.length}章)
              </span>
              {onToggleFloating && (
                <button
                  onClick={onToggleFloating}
                  className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
                  aria-label={floating ? '固定侧边栏' : '浮动侧边栏'}
                >
                  {floating ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                </button>
              )}
            </div>
            <div className="flex-1 space-y-px overflow-y-auto scrollbar-thin min-h-0">
            {chapters.map((ch, idx) => {
              const globalIdx = (sidebarPage - 1) * sidebarPageSize + idx;
              return (
              <button
                key={ch.id}
                onClick={() => onLoadChapter(globalIdx)}
                className={
                  'block w-full text-left text-xs px-2 py-1.5 rounded-md truncate transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none ' +
                  (globalIdx === currentIndex
                    ? 'bg-primary/10 text-primary font-medium sidebar-chapter-active'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50') +
                  (lastChapterIndex === globalIdx ? ' border-l-2 border-primary/50' : '')
                }
              >
                {ch.sortOrder}. {ch.title}
              </button>
              );
            })}
            </div>
            {sidebarTotalPages > 1 && (
              <div className="flex items-center justify-center gap-1 pt-2 border-t mt-2 shrink-0">
                <button
                  className="h-6 w-6 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30"
                  disabled={sidebarPage <= 1}
                  onClick={() => onSidebarPageChange((p) => p - 1)}
                ><ChevronLeft className="h-3 w-3" /></button>
                <span className="text-[10px] text-muted-foreground tabular-nums">{sidebarPage}/{sidebarTotalPages}</span>
                <button
                  className="h-6 w-6 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30"
                  disabled={sidebarPage >= sidebarTotalPages}
                  onClick={() => onSidebarPageChange((p) => p + 1)}
                ><ChevronRight className="h-3 w-3" /></button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
