'use client';

import { useEffect, type RefObject } from 'react';

export interface UseReaderKeyboardProps {
  readerOpen: boolean;
  searchOpen: boolean;
  showBookmarks: boolean;
  showChapterSidebar: boolean;
  readerFullscreen: boolean;
  goToChapter: (direction: 'prev' | 'next') => void;
  getMatchCount: () => number;
  readerContentRef: RefObject<HTMLDivElement | null>;
  // Callbacks
  onToggleShortcutsHelp: () => void;
  onCloseSearch: () => void;
  onOpenSearch: () => void;
  onCycleMatch: () => void;
  onToggleBookmarks: () => void;
  onToggleFullscreen: () => void;
  onToggleChapterSidebar: () => void;
  onEscape: () => void;
}

/**
 * Registers keyboard shortcuts for the reader dialog.
 * Arrow keys / J/K for chapter nav, ↑↓ for scroll, B for bookmarks,
 * F for fullscreen, ? for shortcuts help, Escape to close panels.
 */
export function useReaderKeyboard({
  readerOpen,
  searchOpen,
  showBookmarks,
  showChapterSidebar,
  readerFullscreen,
  goToChapter,
  getMatchCount,
  readerContentRef,
  onToggleShortcutsHelp,
  onCloseSearch,
  onOpenSearch,
  onCycleMatch,
  onToggleBookmarks,
  onToggleFullscreen,
  onToggleChapterSidebar,
  onEscape,
}: UseReaderKeyboardProps) {
  useEffect(() => {
    if (!readerOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      const isInteractive = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        !!(e.target as HTMLElement).closest('[role="listbox"], [role="combobox"], [role="slider"]');

      if (e.key === 'ArrowLeft' && !isInteractive) {
        e.preventDefault();
        goToChapter('prev');
      } else if (e.key === 'ArrowRight' && !isInteractive) {
        e.preventDefault();
        goToChapter('next');
      } else if ((e.key === 'j' || e.key === 'J') && !e.metaKey && !e.ctrlKey && !isInteractive) {
        e.preventDefault();
        goToChapter('next');
      } else if ((e.key === 'k' || e.key === 'K') && !e.metaKey && !e.ctrlKey && !isInteractive) {
        e.preventDefault();
        goToChapter('prev');
      } else if (e.key === '?' && !e.metaKey && !e.ctrlKey && !isInteractive) {
        e.preventDefault();
        onToggleShortcutsHelp();
      } else if (e.key === 'ArrowUp' && !isInteractive) {
        e.preventDefault();
        const target = readerContentRef.current || window;
        target.scrollBy({ top: -200, behavior: 'smooth' });
      } else if (e.key === 'ArrowDown' && !isInteractive) {
        e.preventDefault();
        const target = readerContentRef.current || window;
        target.scrollBy({ top: 200, behavior: 'smooth' });
      } else if (e.key === 'Escape') {
        onEscape();
      } else if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !isInteractive) {
        e.preventDefault();
        onToggleChapterSidebar();
      } else if (e.key === 'b' && !e.metaKey && !e.ctrlKey) {
        const t = (e.target as HTMLElement).tagName;
        if (t !== 'INPUT' && t !== 'TEXTAREA') {
          e.preventDefault();
          onToggleBookmarks();
        }
      } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey) {
        const t = (e.target as HTMLElement).tagName;
        if (t !== 'INPUT' && t !== 'TEXTAREA') {
          e.preventDefault();
          onToggleFullscreen();
        }
      } else if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
        if (!searchOpen) {
          e.preventDefault();
          onOpenSearch();
        }
      } else if (e.key === 'Enter' && searchOpen && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onCycleMatch();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readerOpen, searchOpen, showBookmarks, showChapterSidebar, readerFullscreen, goToChapter, getMatchCount, readerContentRef, onToggleShortcutsHelp, onCloseSearch, onOpenSearch, onCycleMatch, onToggleBookmarks, onToggleFullscreen, onToggleChapterSidebar, onEscape]);
}
