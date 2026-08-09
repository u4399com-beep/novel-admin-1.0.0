'use client';

import { type RefObject } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { NotesPanel } from '@/components/reading/NotesPanel';
import type { Chapter } from '../reader/types';
import type { ReadingSettings, ReadingTheme } from '@/lib/use-reading-settings';
import { ReaderToolbar } from '../reader/ReaderToolbar';
import { ChapterSidebar } from '../reader/ChapterSidebar';
import { BookmarksPanel } from '../reader/BookmarksPanel';
import { ReaderSearchBar } from '../reader/ReaderSearchBar';
import { ReaderContent } from '../reader/ReaderContent';
import { BottomNav } from '../reader/BottomNav';

export interface ReaderDialogProps {
  open: boolean;
  readerFullscreen: boolean;
  readerDialogRef: RefObject<HTMLDivElement | null>;
  scrollPercent: number;
  currentIndex: number;
  chapters: Chapter[];
  hasPrev: boolean;
  hasNext: boolean;
  loadingChapter: boolean;
  showSettings: boolean;
  showBookmarks: boolean;
  showShortcutsHelp: boolean;
  showNotes: boolean;
  showChapterSidebar: boolean;
  showSearch: boolean;
  bookmarksCount: number;
  isCurrentBookmarked: boolean;
  chapterContent: string | null;
  chapterTitle: string;
  chapterError: boolean;
  settings: ReadingSettings;
  currentTheme: ReadingTheme;
  currentFontCss: string;
  searchQuery: string;
  searchMatchCount: number;
  searchCurrentMatch: number;
  readDuration: number;
  sidebarPage: number;
  sidebarTotalPages: number;
  sidebarChapters: Chapter[];
  lastChapterIndex: number | null;
  bookmarks: import('../reader/types').BookmarkEntry[];
  readerContentRef: RefObject<HTMLDivElement | null>;
  // Callbacks
  onClose: () => void;
  onGoToChapter: (direction: 'prev' | 'next') => void;
  onLoadChapter: (index: number) => void;
  onSaveProgress: (index: number, percent: number) => void;
  onToggleChapterSidebar: () => void;
  onToggleBookmarks: () => void;
  onToggleSettings: () => void;
  onToggleShortcutsHelp: () => void;
  onToggleNotes: () => void;
  onToggleFullscreen: () => void;
  onToggleBookmark: () => void;
  onRemoveBookmark: () => void;
  onClearAllBookmarks: () => void;
  onExportChapter: () => void;
  onUpdateSettings: (partial: Partial<ReadingSettings>) => void;
  onRetry: () => void;
  onSidebarPageChange: (page: number | ((prev: number) => number)) => void;
  onSearchQueryChange: (query: string) => void;
  onSearchCurrentMatchChange: (match: number | ((prev: number) => number)) => void;
  onCloseSearch: () => void;
}

export function ReaderDialog({
  open,
  readerFullscreen,
  readerDialogRef,
  scrollPercent,
  currentIndex,
  chapters,
  hasPrev,
  hasNext,
  loadingChapter,
  showSettings,
  showBookmarks,
  showShortcutsHelp,
  showNotes,
  showChapterSidebar,
  showSearch,
  bookmarksCount,
  isCurrentBookmarked,
  chapterContent,
  chapterTitle,
  chapterError,
  settings,
  currentTheme,
  currentFontCss,
  searchQuery,
  searchMatchCount,
  searchCurrentMatch,
  readDuration,
  sidebarPage,
  sidebarTotalPages,
  sidebarChapters,
  lastChapterIndex,
  bookmarks,
  readerContentRef,
  onClose,
  onGoToChapter,
  onLoadChapter,
  onSaveProgress,
  onToggleChapterSidebar,
  onToggleBookmarks,
  onToggleSettings,
  onToggleShortcutsHelp,
  onToggleNotes,
  onToggleFullscreen,
  onToggleBookmark,
  onRemoveBookmark,
  onClearAllBookmarks,
  onExportChapter,
  onUpdateSettings,
  onRetry,
  onSidebarPageChange,
  onSearchQueryChange,
  onSearchCurrentMatchChange,
  onCloseSearch,
}: ReaderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        ref={readerDialogRef}
        className={
          'flex flex-col p-0 gap-0 transition-all duration-300 ' +
          (readerFullscreen
            ? 'w-screen h-screen !max-w-[100vw] !max-h-[100vh] rounded-none'
            : 'sm:max-w-3xl h-[85vh] max-h-[85vh]')
        }
      >
        {/* ── Top bar ─────────────────────────────────────────── */}
        <ReaderToolbar
          scrollPercent={scrollPercent}
          currentIndex={currentIndex}
          totalChapters={chapters.length}
          hasPrev={hasPrev}
          hasNext={hasNext}
          loadingChapter={loadingChapter}
          showSettings={showSettings}
          showBookmarks={showBookmarks}
          showShortcutsHelp={showShortcutsHelp}
          showNotes={showNotes}
          bookmarksCount={bookmarksCount}
          isCurrentBookmarked={isCurrentBookmarked}
          chapterContent={chapterContent}
          settings={settings}
          readerFullscreen={readerFullscreen}
          onGoToChapter={onGoToChapter}
          onToggleChapterSidebar={onToggleChapterSidebar}
          onToggleBookmarks={onToggleBookmarks}
          onToggleSettings={onToggleSettings}
          onToggleShortcuts={onToggleShortcutsHelp}
          onToggleNotes={onToggleNotes}
          onToggleBookmark={onToggleBookmark}
          onRemoveBookmark={onRemoveBookmark}
          onExportChapter={onExportChapter}
          onToggleFullscreen={onToggleFullscreen}
          onUpdateSettings={onUpdateSettings}
        />

        {/* ── Chapter title ──────────────────────────────────── */}
        <DialogHeader className="shrink-0 px-6 pt-4 pb-2">
          <DialogTitle className="text-base font-semibold truncate">
            {chapterTitle}
          </DialogTitle>
        </DialogHeader>

        {/* ── Content area (with optional sidebar) ────────── */}
        <div className="flex-1 flex overflow-hidden relative">
          {/* Chapter sidebar */}
          <ChapterSidebar
            visible={showChapterSidebar}
            chapters={sidebarChapters}
            sidebarPage={sidebarPage}
            sidebarTotalPages={sidebarTotalPages}
            currentIndex={currentIndex}
            lastChapterIndex={lastChapterIndex}
            onLoadChapter={onLoadChapter}
            onSidebarPageChange={onSidebarPageChange}
          />

          {/* Bookmarks panel (right side) */}
          <BookmarksPanel
            visible={showBookmarks}
            bookmarks={bookmarks}
            chapters={chapters}
            currentIndex={currentIndex}
            onLoadChapter={onLoadChapter}
            onSaveProgress={(idx) => onSaveProgress(idx, 0)}
            onRemoveBookmark={onRemoveBookmark}
            onClearAllBookmarks={onClearAllBookmarks}
          />

          {/* Reader search bar */}
          <ReaderSearchBar
            visible={showSearch}
            searchQuery={searchQuery}
            matchCount={searchMatchCount}
            currentMatch={searchCurrentMatch}
            onSearchQueryChange={onSearchQueryChange}
            onCurrentMatchChange={onSearchCurrentMatchChange}
            onClose={onCloseSearch}
          />

          {/* Reader content */}
          <ReaderContent
            contentRef={readerContentRef}
            loading={loadingChapter}
            error={chapterError}
            content={chapterContent}
            chapterTitle={chapterTitle}
            currentTheme={currentTheme}
            currentFontCss={currentFontCss}
            fontSize={settings.fontSize}
            lineHeight={settings.lineHeight}
            searchOpen={showSearch}
            searchQuery={searchQuery}
            currentMatch={searchCurrentMatch}
            onRetry={onRetry}
          />

          {/* Notes panel */}
          <NotesPanel
            chapterId={chapters[currentIndex]?.id || ''}
            visible={showNotes}
            className="card-glass"
          />
        </div>

        {/* ── Bottom nav bar ────────────────────────────────── */}
        <BottomNav
          hasPrev={hasPrev}
          hasNext={hasNext}
          loadingChapter={loadingChapter}
          onGoToChapter={onGoToChapter}
          readDuration={readDuration}
        />
      </DialogContent>
    </Dialog>
  );
}
