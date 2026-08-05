'use client';

import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft,
  ChevronRight,
  List,
  BookmarkCheck,
  Settings2,
  Download,
  Keyboard,
  Maximize2,
  Minimize2,
  StickyNote,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { TranslateButton } from '@/components/translate/TranslateButton';
import { ReadingSettingsPanel } from '@/components/ReadingSettingsPanel';
import type { ReadingSettings } from '@/lib/use-reading-settings';

export interface ReaderToolbarProps {
  scrollPercent: number;
  currentIndex: number;
  totalChapters: number;
  hasPrev: boolean;
  hasNext: boolean;
  loadingChapter: boolean;
  showSettings: boolean;
  showBookmarks: boolean;
  showShortcutsHelp: boolean;
  showNotes: boolean;
  bookmarksCount: number;
  isCurrentBookmarked: boolean;
  chapterContent: string | null;
  settings: ReadingSettings;
  readerFullscreen: boolean;
  onGoToChapter: (direction: 'prev' | 'next') => void;
  onToggleChapterSidebar: () => void;
  onToggleBookmarks: () => void;
  onToggleSettings: () => void;
  onToggleShortcuts: () => void;
  onToggleNotes: () => void;
  onToggleBookmark: () => void;
  onRemoveBookmark: () => void;
  onExportChapter: () => void;
  onToggleFullscreen: () => void;
  onUpdateSettings: (partial: Partial<ReadingSettings>) => void;
}

export function ReaderToolbar({
  scrollPercent,
  currentIndex,
  totalChapters,
  hasPrev,
  hasNext,
  loadingChapter,
  showSettings,
  showBookmarks,
  showShortcutsHelp,
  showNotes,
  bookmarksCount,
  isCurrentBookmarked,
  chapterContent,
  settings,
  readerFullscreen,
  onGoToChapter,
  onToggleChapterSidebar,
  onToggleBookmarks,
  onToggleSettings,
  onToggleShortcuts,
  onToggleNotes,
  onToggleBookmark,
  onRemoveBookmark,
  onExportChapter,
  onToggleFullscreen,
  onUpdateSettings,
}: ReaderToolbarProps) {
  return (
    <div className="shrink-0 border-b bg-muted/30">
      {/* Progress bar */}
      <div className="h-0.5 bg-muted overflow-hidden">
        <motion.div
          className="h-full bg-primary"
          initial={false}
          animate={{ width: `${scrollPercent}%` }}
          transition={{ duration: 0.15 }}
        />
      </div>
      <div className="px-4 py-2 flex items-center justify-between gap-2">
        {/* Left: progress text */}
        <span className="text-xs text-muted-foreground font-medium tabular-nums min-w-0 truncate">
          第 {currentIndex + 1}/{totalChapters} 章
          <span className="ml-2 text-muted-foreground/60">{scrollPercent}%</span>
        </span>

        {/* Center: nav buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 press-effect"
            disabled={!hasPrev || loadingChapter}
            onClick={() => onGoToChapter('prev')}
            title="上一章 (←)"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 press-effect"
            disabled={!hasNext || loadingChapter}
            onClick={() => onGoToChapter('next')}
            title="下一章 (→)"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Right: tools */}
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 press-effect"
                aria-label="章节目录"
                onClick={onToggleChapterSidebar}
              >
                <List className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">章节目录</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="书签列表"
                className={
                  'h-7 w-7 relative transition-colors press-effect ' +
                  (showBookmarks ? ' bg-amber-500/10 text-amber-500' : '')
                }
                onClick={onToggleBookmarks}
              >
                <BookmarkCheck className="h-3.5 w-3.5" />
                {bookmarksCount > 0 && !showBookmarks && (
                  <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 flex items-center justify-center rounded-full bg-amber-500 text-[8px] font-bold text-white leading-none">
                    {bookmarksCount > 9 ? '9+' : bookmarksCount}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showBookmarks ? '关闭书签列表 (B)' : `书签 (${bookmarksCount})`}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={isCurrentBookmarked ? '移除书签' : '添加书签'}
                className={
                  'h-7 w-7 transition-colors press-effect ' +
                  (isCurrentBookmarked ? 'text-amber-500' : '')
                }
                onClick={isCurrentBookmarked ? onRemoveBookmark : onToggleBookmark}
              >
                {isCurrentBookmarked ? (
                  <BookmarkCheck className="h-3.5 w-3.5 fill-amber-500" />
                ) : (
                  <BookmarkCheck className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isCurrentBookmarked ? '移除书签' : '添加书签'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="阅读笔记"
                className={
                  'h-7 w-7 press-effect ' + (showNotes ? 'bg-amber-500/10 text-amber-500' : '')
                }
                onClick={onToggleNotes}
              >
                <StickyNote className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">阅读笔记</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="阅读设置"
                className={
                  'h-7 w-7 press-effect ' + (showSettings ? 'bg-primary/10 text-primary' : '')
                }
                onClick={onToggleSettings}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">阅读设置</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="导出本章TXT"
                className="h-7 w-7 press-effect"
                onClick={onExportChapter}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">导出TXT</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <TranslateButton
                  content={chapterContent || ''}
                  className="h-7 w-7 press-effect text-amber-600 hover:text-amber-700 dark:text-amber-400"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">翻译</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="快捷键帮助"
                className={
                  'h-7 w-7 press-effect ' + (showShortcutsHelp ? 'bg-primary/10 text-primary' : '')
                }
                onClick={onToggleShortcuts}
              >
                <Keyboard className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">快捷键 (?)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 press-effect"
                aria-label={readerFullscreen ? "退出全屏" : "全屏"}
                onClick={onToggleFullscreen}
              >
                {readerFullscreen ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">全屏 (F)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Settings panel (collapsible) */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 py-2.5 border-t bg-muted/20">
              <ReadingSettingsPanel settings={settings} onUpdate={onUpdateSettings} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
