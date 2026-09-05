'use client';

import { useState, useCallback, useRef, useEffect, useMemo, type CSSProperties } from 'react';
import { apiFetch } from '@/lib/api-fetch';

// ─── Reading Themes ─────────────────────────────────────────────────

export interface ReadingTheme {
  key: string;
  label: string;
  bg: string;
  text: string;
  preview: string;
  // Inline styles for guaranteed rendering (Tailwind JIT cannot scan dynamic class strings in objects)
  bgStyle: CSSProperties;
  bgStyleDark: CSSProperties;
  textStyle: CSSProperties;
  textStyleDark: CSSProperties;
}

export const READING_THEMES: ReadingTheme[] = [
  {
    key: 'light',
    label: '默认',
    bg: 'bg-white',
    text: 'text-zinc-800',
    preview: '#fff',
    bgStyle: { backgroundColor: '#ffffff' },
    bgStyleDark: { backgroundColor: '#18181b' }, // zinc-900
    textStyle: { color: '#3f3f46' }, // zinc-700
    textStyleDark: { color: '#e4e4e7' }, // zinc-200
  },
  {
    key: 'sepia',
    label: '护眼',
    bg: '', // Using inline styles only
    text: '',
    preview: '#f5f0e8',
    bgStyle: { backgroundColor: '#f5f0e8' },
    bgStyleDark: { backgroundColor: '#2a2520' },
    textStyle: { color: '#5b4636' },
    textStyleDark: { color: '#d4c5b0' },
  },
  {
    key: 'green',
    label: '绿意',
    bg: '',
    text: '',
    preview: '#e8f5e9',
    bgStyle: { backgroundColor: '#e8f5e9' },
    bgStyleDark: { backgroundColor: '#1a2e1c' },
    textStyle: { color: '#2e4a2f' },
    textStyleDark: { color: '#b0d4b2' },
  },
  {
    key: 'dark',
    label: '夜间',
    bg: 'bg-zinc-900',
    text: 'text-zinc-300',
    preview: '#18181b',
    bgStyle: { backgroundColor: '#18181b' }, // zinc-900
    bgStyleDark: { backgroundColor: '#09090b' }, // zinc-950
    textStyle: { color: '#d4d4d8' }, // zinc-300
    textStyleDark: { color: '#a1a1aa' }, // zinc-400
  },
];

// ─── Reader Templates ───────────────────────────────────────────────

export interface ReaderTemplate {
  key: string;
  label: string;
  description: string;
}

export const READER_TEMPLATES: ReaderTemplate[] = [
  { key: 'default', label: '经典', description: '弹窗式阅读器' },
  { key: 'guichuideng', label: '鬼吹灯', description: '仿鬼吹灯风格全屏阅读器' },
];

export interface ReadingSettings {
  fontSize: number;
  lineHeight: number;
  themeKey: string;
  fontFamily: string;
  readerTemplate: string;
}

const STORAGE_KEY = 'novel-reading-settings';

const DEFAULT_SETTINGS: ReadingSettings = {
  fontSize: 16,
  lineHeight: 1.9,
  themeKey: 'light',
  fontFamily: 'serif',
  readerTemplate: 'default',
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
        const { getSessionId } = await import('@/lib/reading-session');
        const sid = getSessionId();
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
  // Initialize from localStorage directly on client (lazy initializer).
  // On server, returns empty array. The lazy initializer only runs once
  // during mount, so there's no risk of cascading renders.
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>(() => {
    if (typeof window === 'undefined') return [];
    return loadBookmarks(novelId);
  });

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
