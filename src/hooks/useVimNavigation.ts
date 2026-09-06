'use client';

import { useEffect, useCallback, useRef } from 'react';

/**
 * Vim-style keyboard navigation hook.
 *
 * Supported shortcuts:
 * - j / ↓: Scroll down
 * - k / ↑: Scroll up
 * - gg: Scroll to top
 * - G: Scroll to bottom
 * - /: Focus search input
 * - Escape: Close topmost dialog/panel
 * - d: Half-page down
 * - u: Half-page up
 * - n: Next search result
 * - N: Previous search result
 *
 * Returns shortcut descriptions for tooltip rendering.
 */

export interface VimNavigationOptions {
  /** Scroll step in pixels for j/k (default: 60) */
  scrollStep?: number;
  /** Half-page scroll height (default: window.innerHeight / 2) */
  halfPageHeight?: number;
  /** Selector for the search input to focus on / */
  searchInputSelector?: string;
  /** Callback when Escape is pressed */
  onEscape?: () => void;
  /** Callback when 'n' is pressed */
  onNextSearch?: () => void;
  /** Callback when 'N' is pressed */
  onPrevSearch?: () => void;
  /** Whether the hook is active (default: true) */
  enabled?: boolean;
}

export interface ShortcutHint {
  keys: string[];
  description: string;
}

export const VIM_SHORTCUT_HINTS: ShortcutHint[] = [
  { keys: ['j'], description: '向下滚动' },
  { keys: ['k'], description: '向上滚动' },
  { keys: ['d'], description: '向下半页' },
  { keys: ['u'], description: '向上半页' },
  { keys: ['gg'], description: '回到顶部' },
  { keys: ['G'], description: '滚到底部' },
  { keys: ['/'], description: '聚焦搜索' },
  { keys: ['n'], description: '下一个搜索' },
  { keys: ['N'], description: '上一个搜索' },
  { keys: ['Esc'], description: '关闭面板' },
];

export function useVimNavigation(options: VimNavigationOptions = {}) {
  const {
    scrollStep = 60,
    searchInputSelector = 'input[type="text"], input[aria-label*="搜索"]',
    onEscape,
    onNextSearch,
    onPrevSearch,
    enabled = true,
  } = options;

  const gPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gPressCount = useRef(0);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;

    // Ignore when typing in input/textarea
    const target = e.target as HTMLElement;
    const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    // Escape always works
    if (e.key === 'Escape') {
      if (isInput) {
        (target as HTMLInputElement).blur();
      }
      onEscape?.();
      return;
    }

    // Don't intercept other keys when in input
    if (isInput) return;

    switch (e.key) {
      case 'j':
        e.preventDefault();
        window.scrollBy({ top: scrollStep, behavior: 'smooth' });
        break;
      case 'k':
        e.preventDefault();
        window.scrollBy({ top: -scrollStep, behavior: 'smooth' });
        break;
      case 'd':
        e.preventDefault();
        window.scrollBy({ top: window.innerHeight / 2, behavior: 'smooth' });
        break;
      case 'u':
        e.preventDefault();
        window.scrollBy({ top: -window.innerHeight / 2, behavior: 'smooth' });
        break;
      case 'G':
        e.preventDefault();
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        break;
      case 'g':
        // Double-g for scroll to top (like vim)
        gPressCount.current++;
        if (gPressCount.current >= 2) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: 'smooth' });
          gPressCount.current = 0;
          if (gPressTimer.current) clearTimeout(gPressTimer.current);
        } else {
          // Reset count after 300ms if second g doesn't come
          if (gPressTimer.current) clearTimeout(gPressTimer.current);
          gPressTimer.current = setTimeout(() => {
            gPressCount.current = 0;
          }, 300);
        }
        break;
      case '/':
        e.preventDefault();
        {
          const searchInput = document.querySelector(searchInputSelector) as HTMLElement | null;
          searchInput?.focus();
        }
        break;
      case 'n':
        e.preventDefault();
        onNextSearch?.();
        break;
      case 'N':
        e.preventDefault();
        onPrevSearch?.();
        break;
    }
  }, [enabled, scrollStep, searchInputSelector, onEscape, onNextSearch, onPrevSearch]);

  useEffect(() => {
    if (!enabled) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (gPressTimer.current) clearTimeout(gPressTimer.current);
    };
  }, [handleKeyDown, enabled]);
}
