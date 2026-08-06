'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';

// ─── Reading Themes ─────────────────────────────────────────────────

export interface ReadingTheme {
  key: string;
  label: string;
  bg: string;
  text: string;
  preview: string;
}

export const READING_THEMES: ReadingTheme[] = [
  {
    key: 'light',
    label: '默认',
    bg: 'bg-white dark:bg-zinc-900',
    text: 'text-zinc-800 dark:text-zinc-200',
    preview: '#fff',
  },
  {
    key: 'sepia',
    label: '护眼',
    bg: 'bg-[#f5f0e8] dark:bg-[#2a2520]',
    text: 'text-[#5b4636] dark:text-[#d4c5b0]',
    preview: '#f5f0e8',
  },
  {
    key: 'green',
    label: '绿意',
    bg: 'bg-[#e8f5e9] dark:bg-[#1a2e1c]',
    text: 'text-[#2e4a2f] dark:text-[#b0d4b2]',
    preview: '#e8f5e9',
  },
  {
    key: 'dark',
    label: '夜间',
    bg: 'bg-zinc-900 dark:bg-zinc-950',
    text: 'text-zinc-300 dark:text-zinc-400',
    preview: '#18181b',
  },
];

export interface ReadingSettings {
  fontSize: number;
  lineHeight: number;
  themeKey: string;
  fontFamily: string;
}

const STORAGE_KEY = 'novel-reading-settings';

const DEFAULT_SETTINGS: ReadingSettings = {
  fontSize: 16,
  lineHeight: 1.9,
  themeKey: 'light',
  fontFamily: 'serif',
};

function loadSettings(): ReadingSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<ReadingSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        fontSize: Math.max(12, Math.min(28, parsed.fontSize ?? 16)),
        lineHeight: Math.max(1.2, Math.min(3.0, parsed.lineHeight ?? 1.9)),
      };
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

export const FONT_FAMILIES = [
  { key: 'serif', label: '宋体', css: 'font-serif' },
  { key: 'sans', label: '黑体', css: 'font-sans' },
  { key: 'mono', label: '等宽', css: 'font-mono' },
];

export function useReadingSettings() {
  const [settings, setSettings] = useState<ReadingSettings>(DEFAULT_SETTINGS);

  // Hydrate from localStorage after mount (SSR-safe)
  useEffect(() => {
    const stored = loadSettings();
    if (JSON.stringify(stored) !== JSON.stringify(DEFAULT_SETTINGS)) {
      queueMicrotask(() => setSettings(stored));
    }
  }, []);

  const updateSettings = useCallback((partial: Partial<ReadingSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const currentTheme = READING_THEMES.find((t) => t.key === settings.themeKey) || READING_THEMES[0];
  const currentFont = FONT_FAMILIES.find((f) => f.key === settings.fontFamily) || FONT_FAMILIES[0];

  return { settings, updateSettings, currentTheme, currentFont };
}

// ─── Reading Progress ───────────────────────────────────────────────

function loadProgress(key: string, max?: number): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = localStorage.getItem(key);
    if (saved) {
      const index = parseInt(saved, 10);
      // When max is provided, validate bounds; otherwise return raw index (caller clamps later)
      if (!isNaN(index) && index >= 0 && (max === undefined || index < max)) return index;
    }
  } catch {
    // ignore
  }
  return null;
}

export function useReadingProgress(novelId: string, chapters: { id: string }[]) {
  const PROGRESS_KEY = `novel-progress-${novelId}`;
  // Use ref for chapters to avoid saveProgress identity changes on chapter list updates
  const chaptersRef = useRef(chapters);
  const [lastChapterIndex, setLastChapterIndex] = useState<number>(0);
  useEffect(() => { chaptersRef.current = chapters; }, [chapters]);

  // Hydrate from localStorage after mount (SSR-safe)
  useEffect(() => {
    const idx = loadProgress(PROGRESS_KEY, chapters.length);
    if (idx !== null) {
      queueMicrotask(() => setLastChapterIndex(idx));
    }
  }, [PROGRESS_KEY, chapters.length]);

  const saveProgress = useCallback(
    (chapterIndex: number, sp?: number) => {
      try {
        localStorage.setItem(PROGRESS_KEY, String(chapterIndex));
      } catch {
        // ignore
      }
      setLastChapterIndex(chapterIndex);

      // Persist to server (fire-and-forget, non-blocking)
      try {
        let sid = '';
        if (typeof localStorage !== 'undefined') {
          const SK = 'novel-session-id';
          sid = localStorage.getItem(SK) || '';
          if (!sid) {
            sid = crypto.randomUUID();
            localStorage.setItem(SK, sid);
          }
        }
        if (sid) {
          const chapterId = chaptersRef.current[chapterIndex]?.id || null;
          apiFetch('/api/public/reading-progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, novelId, chapterId, chapterIndex, scrollPercent: sp }),
            silent: true,
            timeout: 5000,
          }).catch(() => {});
        }
      } catch {
        // Server sync is best-effort
      }
    },
    [PROGRESS_KEY, novelId] // stable — reads chapters from ref
  );

  return { lastChapterIndex, saveProgress };
}

// ─── Chapter Bookmarks ──────────────────────────────────────────

const BOOKMARKS_PREFIX = 'novel-bookmarks-';
const MAX_BOOKMARKS = 100;

interface BookmarkEntry {
  chapterIndex: number;
  chapterTitle: string;
  timestamp: number;
  scrollPercent: number;
}

function loadBookmarks(novelId: string): BookmarkEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const saved = localStorage.getItem(`${BOOKMARKS_PREFIX}${novelId}`);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}

function saveBookmarks(novelId: string, bookmarks: BookmarkEntry[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`${BOOKMARKS_PREFIX}${novelId}`, JSON.stringify(bookmarks));
  } catch {
    // ignore
  }
}

export function useChapterBookmarks(novelId: string) {
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(
    () => loadBookmarks(novelId)
  );

  const addBookmark = useCallback(
    (chapterIndex: number, chapterTitle: string, scrollPercent: number) => {
    setBookmarks((prev) => {
      // Remove existing bookmark for this chapter
      const filtered = prev.filter((b) => b.chapterIndex !== chapterIndex);
      const entry: BookmarkEntry = {
        chapterIndex,
        chapterTitle,
        timestamp: Date.now(),
        scrollPercent: Math.round(scrollPercent * 10) / 10,
      };
      const next = [entry, ...filtered].slice(0, MAX_BOOKMARKS);
      saveBookmarks(novelId, next);
      return next;
    });
  },
  [novelId]
  );

  const removeBookmark = useCallback(
    (chapterIndex: number) => {
    setBookmarks((prev) => {
      const next = prev.filter((b) => b.chapterIndex !== chapterIndex);
      saveBookmarks(novelId, next);
      return next;
    });
  },
  [novelId]
  );

  const clearAllBookmarks = useCallback(
    () => {
      setBookmarks(() => {
        saveBookmarks(novelId, []);
        return [];
      });
    },
    [novelId]
  );

  const isBookmarked = useCallback(
    (chapterIndex: number) => bookmarks.some((b) => b.chapterIndex === chapterIndex),
    [bookmarks]
  );

  return { bookmarks, addBookmark, removeBookmark, clearAllBookmarks, isBookmarked };
}
