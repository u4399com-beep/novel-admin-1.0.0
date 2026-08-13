'use client';

import { useEffect, useRef, type RefObject } from 'react';

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
 *
 * Uses refs for all callbacks so the effect only re-registers when readerOpen changes.
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
  // Store all callbacks in refs to avoid re-registering on every chapter change
  const cbRef = useRef({
    goToChapter, getMatchCount, readerContentRef,
    searchOpen, showBookmarks, showChapterSidebar, readerFullscreen,
    onToggleShortcutsHelp, onCloseSearch, onOpenSearch, onCycleMatch,
    onToggleBookmarks, onToggleFullscreen, onToggleChapterSidebar, onEscape,
  });
  // Update ref in effect to satisfy react-hooks/refs rule
  useEffect(() => {
    cbRef.current = {
      goToChapter, getMatchCount, readerContentRef,
      searchOpen, showBookmarks, showChapterSidebar, readerFullscreen,
      onToggleShortcutsHelp, onCloseSearch, onOpenSearch, onCycleMatch,
      onToggleBookmarks, onToggleFullscreen, onToggleChapterSidebar, onEscape,
    };
  });

  useEffect(() => {
    if (!readerOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      const cb = cbRef.current;
      const tag = (e.target as HTMLElement).tagName;
      const isInteractive = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        !!(e.target as HTMLElement).closest('[role="listbox"], [role="combobox"], [role="slider"]');

      if (e.key === 'ArrowLeft' && !isInteractive) {
        e.preventDefault();
        cb.goToChapter('prev');
      } else if (e.key === 'ArrowRight' && !isInteractive) {
        e.preventDefault();
        cb.goToChapter('next');
      } else if ((e.key === 'j' || e.key === 'J') && !e.metaKey && !e.ctrlKey && !isInteractive) {
        e.preventDefault();
        cb.goToChapter('next');
      } else if ((e.key === 'k' || e.key === 'K') && !e.metaKey && !e.ctrlKey && !isInteractive) {
        e.preventDefault();
        cb.goToChapter('prev');
      } else if (e.key === '?' && !e.metaKey && !e.ctrlKey && !isInteractive) {
        e.preventDefault();
        cb.onToggleShortcutsHelp();
      } else if (e.key === 'ArrowUp' && !isInteractive) {
        e.preventDefault();
        const target = cb.readerContentRef.current || window;
        target.scrollBy({ top: -200, behavior: 'smooth' });
      } else if (e.key === 'ArrowDown' && !isInteractive) {
        e.preventDefault();
        const target = cb.readerContentRef.current || window;
        target.scrollBy({ top: 200, behavior: 'smooth' });
      } else if (e.key === 'Escape') {
        cb.onEscape();
      } else if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !isInteractive) {
        e.preventDefault();
        cb.onToggleChapterSidebar();
      } else if (e.key === 'b' && !e.metaKey && !e.ctrlKey) {
        const t = (e.target as HTMLElement).tagName;
        if (t !== 'INPUT' && t !== 'TEXTAREA') {
          e.preventDefault();
          cb.onToggleBookmarks();
        }
      } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !isInteractive) {
        const t = (e.target as HTMLElement).tagName;
        if (t !== 'INPUT' && t !== 'TEXTAREA') {
          e.preventDefault();
          cb.onToggleFullscreen();
        }
      } else if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
        if (!cb.searchOpen) {
          e.preventDefault();
          cb.onOpenSearch();
        }
      } else if (e.key === 'Enter' && cb.searchOpen && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        cb.onCycleMatch();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readerOpen]);
}
