'use client';

import { useState, useEffect, useCallback, useRef, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Circle,
  FileText,
  Clock,
  Eye,
  ChevronLeft,
  ChevronRight,
  BookmarkCheck,
  Download,
  Heart,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BackToTop } from '@/components/BackToTop';
import { DailyReadingGoal } from '@/components/DailyReadingGoal';
import { BookmarkManager } from '@/components/BookmarkManager';
import {
  useReadingSettings,
  useReadingProgress,
  useChapterBookmarks,
} from '@/lib/use-reading-settings';
import { formatWordCount, formatReadingTime } from '@/lib/format';
import { apiFetch, FetchError } from '@/lib/api-fetch';
import { getCoverGradient } from '@/lib/cover-gradient';
import type { Novel, Chapter, Tag } from './reader/types';
import { ReaderToolbar } from './reader/ReaderToolbar';
import { ChapterSidebar } from './reader/ChapterSidebar';
import { BookmarksPanel } from './reader/BookmarksPanel';
import { ReaderSearchBar } from './reader/ReaderSearchBar';
import { ReaderContent } from './reader/ReaderContent';
import { BottomNav } from './reader/BottomNav';
import { KeyboardShortcutsPanel } from './reader/KeyboardShortcutsPanel';

// ─── Helpers ─────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  ongoing: { label: '连载中', variant: 'default' },
  completed: { label: '已完结', variant: 'secondary' },
  hiatus: { label: '暂停中', variant: 'outline' },
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Animation variants ─────────────────────────────────────────────

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const itemVariants = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
};

// ─── Component ───────────────────────────────────────────────────────

const SIDEBAR_PAGE_SIZE = 200;
const CHAPTERS_PER_PAGE = 100;

export default function NovelDetailClient({ novel, chapters: initialChapters, totalChapters: initialTotal }: { novel: Novel; chapters: Chapter[]; totalChapters?: number }) {
  const router = useRouter();
  const gradient = getCoverGradient(novel.title);
  const statusInfo = STATUS_MAP[novel.status] || STATUS_MAP.ongoing;
  const coverRef = useRef<HTMLDivElement>(null);

  // ─── Track recently viewed ─────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const RECENT_KEY = 'novel-recently-viewed';
    const MAX_RECENT = 12;
    try {
      const list: Array<{ id: string; title: string; author: string; coverUrl: string | null; category: { name: string; color: string } | null; viewedAt: number }> = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      const filtered = list.filter((n) => n.id !== novel.id);
      filtered.unshift({
        id: novel.id,
        title: novel.title,
        author: novel.author,
        coverUrl: novel.coverUrl,
        category: novel.category ? { name: novel.category.name, color: novel.category.color } : null,
        viewedAt: Date.now(),
      });
      localStorage.setItem(RECENT_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT)));
    } catch { /* ignore */ }
  }, [novel.id, novel.title, novel.author, novel.coverUrl, novel.category?.name, novel.category?.color]);

  // ─── Track click count (fire-and-forget with timeout) ─────────
  useEffect(() => {
    apiFetch(`/api/public/novels/${novel.id}/click`, { method: 'POST', silent: true, timeout: 5000 }).catch(() => {});
  }, [novel.id]);

  // ─── 3D Cover tilt handlers ──────────────────────────────────
  const handleCoverMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!coverRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    const rotateY = x * 15;
    const rotateX = -y * 15;
    coverRef.current.style.transform = `rotateY(${rotateY}deg) rotateX(${rotateX}deg)`;
  }, []);

  const handleCoverMouseLeave = useCallback(() => {
    if (!coverRef.current) return;
    coverRef.current.style.transform = 'rotateY(0deg) rotateX(0deg)';
  }, []);

  const [filterBookmarks, setFilterBookmarks] = useState(false);
  const [bookmarkManagerOpen, setBookmarkManagerOpen] = useState(false);

  // ─── Reader state ───────────────────────────────────────────────
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerFullscreen, setReaderFullscreen] = useState(false);
  const [showChapterSidebar, setShowChapterSidebar] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [sidebarPage, setSidebarPage] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(0);
  // ─── Full chapter list (may load more from server on demand) ────────
  const [allChapters, setAllChapters] = useState(initialChapters);
  // Use alias so all existing references work without changes
  const chapters = allChapters;
  const [chapterContent, setChapterContent] = useState<string | null>(null);
  const [chapterError, setChapterError] = useState(false);
  const [chapterTitle, setChapterTitle] = useState('');
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [scrollPercent, setScrollPercent] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState(0);
  const readerContentRef = useRef<HTMLDivElement>(null);
  const readerDialogRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestore = useRef<number | null>(null);
  const [readStartTime] = useState(() => Date.now());
  const [readDuration, setReadDuration] = useState(0);

  // ─── Favorite state (optimistic UI) ───────────────────────────────
  const [isFavorited, setIsFavorited] = useState(false);
  const [localFavoriteCount, setLocalFavoriteCount] = useState(novel.favoriteCount);
  const [favoriteLoading, setFavoriteLoading] = useState(false);

  const handleToggleFavorite = useCallback(async () => {
    if (favoriteLoading) return;
    const nextFav = !isFavorited;
    // Optimistic update
    setIsFavorited(nextFav);
    setLocalFavoriteCount((c) => (nextFav ? c + 1 : Math.max(0, c - 1)));
    try {
      const res = await apiFetch<{ favoriteCount: number }>(`/api/novels/${novel.id}/favorite`, {
        method: 'POST',
        body: JSON.stringify({ favorite: nextFav }),
      });
      setLocalFavoriteCount(res.favoriteCount);
    } catch {
      // Revert on error
      setIsFavorited(!nextFav);
      setLocalFavoriteCount((c) => (nextFav ? Math.max(0, c - 1) : c + 1));
    } finally {
      setFavoriteLoading(false);
    }
  }, [favoriteLoading, isFavorited, novel.id]);

  // ─── Search match count ─────────────────────────────────────────
  const matchCount = (() => {
    if (!chapterContent || !searchQuery.trim()) return 0;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = chapterContent.match(new RegExp(escaped, 'gi'));
    return matches ? matches.length : 0;
  })();

  const getMatchCount = useCallback(() => matchCount, [matchCount]);

  // ─── Reading settings ────────────────────────────────────────────
  const { settings, updateSettings, currentTheme, currentFont } = useReadingSettings();

  // ─── Reading progress ────────────────────────────────────────────
  const { lastChapterIndex, saveProgress } = useReadingProgress(novel.id, chapters);
  const { bookmarks, addBookmark, removeBookmark, clearAllBookmarks, isBookmarked } = useChapterBookmarks(novel.id);

  const displayedChapters = (() => {
    if (filterBookmarks && bookmarks.length > 0) return chapters.filter((_, idx) => isBookmarked(idx));
    return chapters;
  })();

  // Fetch remaining chapters if SSR only provided 200
  useEffect(() => {
    const total = initialTotal ?? novel._count.chapters;
    if (total <= 200 || initialChapters.length >= total) return;
    const ac = new AbortController();
    apiFetch<{ chapters?: Chapter[] }>(`/api/public/novels/${novel.id}/chapters?pageSize=${total}`, { signal: ac.signal }).then((data) => {
      if (data.chapters) setAllChapters(data.chapters);
    }).catch(() => {});
    return () => ac.abort();
  }, []);

  // Clamp to valid range (chapters may have been deleted since progress was saved)
  const safeLastChapterIndex = lastChapterIndex !== null && lastChapterIndex < allChapters.length
    ? lastChapterIndex : null;

  // ─── Chapter list pagination (client-side) ───────────────
  const [chapterPage, setChapterPage] = useState(1);
  const chapterTotalPages = Math.ceil(chapters.length / CHAPTERS_PER_PAGE);
  const visibleChapters = chapters.slice(
    (chapterPage - 1) * CHAPTERS_PER_PAGE,
    chapterPage * CHAPTERS_PER_PAGE,
  );
  // Auto-jump to page containing lastChapterIndex
  useEffect(() => {
    if (lastChapterIndex !== null && chapters.length > 0 && lastChapterIndex >= chapterPage * CHAPTERS_PER_PAGE) {
      setChapterPage(Math.floor(lastChapterIndex / CHAPTERS_PER_PAGE) + 1);
    }
  }, [lastChapterIndex, chapterPage, chapters.length]);

  // ─── Reader sidebar pagination ──────────────────────────────
  const sidebarTotalPages = Math.ceil(chapters.length / SIDEBAR_PAGE_SIZE);
  const sidebarChapters = chapters.slice(
    (sidebarPage - 1) * SIDEBAR_PAGE_SIZE,
    sidebarPage * SIDEBAR_PAGE_SIZE,
  );
  // Auto-jump sidebar page when chapter changes
  useEffect(() => {
    const targetPage = Math.floor(currentIndex / SIDEBAR_PAGE_SIZE) + 1;
    setSidebarPage(targetPage);
  }, [currentIndex]);

  // Chapter content progress (wordCount > 0 as proxy for "has content")
  const chaptersWithContent = chapters.filter((c) => c.wordCount > 0).length;
  const contentProgress = chapters.length > 0
    ? Math.round((chaptersWithContent / chapters.length) * 100) : 0;

  const openReader = useCallback(
    (index: number) => {
      setCurrentIndex(index);
      setChapterContent(null);
      setChapterTitle(chapters[index].title);
      setReaderOpen(true);
      setShowSettings(false);
      setShowChapterSidebar(false);
    },
    [chapters]
  );

  const loadChapterAbortRef = useRef<AbortController | null>(null);

  const HEATMAP_KEY = 'reading-heatmap';
  function recordReadingActivity() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const raw = localStorage.getItem(HEATMAP_KEY);
      const data = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      data[today] = (data[today] || 0) + 1;
      localStorage.setItem(HEATMAP_KEY, JSON.stringify(data));
    } catch { /* ignore */ }
  }

  // 记录阅读目标到服务器（fire-and-forget，不阻塞阅读体验）
  function reportReadingGoal(words: number) {
    apiFetch('/api/reading-goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chaptersRead: 1, words }),
      silent: true,
      timeout: 5000,
    }).catch(() => { /* 静默 */ });
  }

  // Use ref for chapters so loadChapter identity stays stable when remaining chapters load (H2 fix)
  const chaptersRef = useRef(chapters);
  const prevIndexRef = useRef(currentIndex);
  chaptersRef.current = chapters;

  const loadChapter = useCallback(
    async (index: number) => {
      const chs = chaptersRef.current;
      if (index < 0 || index >= chs.length) return;
      const chapter = chs[index];
      setCurrentIndex(index);
      setChapterContent(null);
      setChapterError(false);
      setChapterTitle(chapter.title);
      setLoadingChapter(true);
      setSearchOpen(false);
      setSearchQuery('');
      setCurrentMatch(0);

      // Scroll reader content to top on chapter change (H3 fix)
      requestAnimationFrame(() => {
        readerContentRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      });

      // Cancel any in-flight chapter load
      loadChapterAbortRef.current?.abort();
      const abortController = new AbortController();
      loadChapterAbortRef.current = abortController;

      // Check if there's a saved scroll position for this chapter
      try {
        const SK = 'novel-session-id';
        const sid = localStorage.getItem(SK) || '';
        if (sid) {
          const resp = await fetch(`/api/public/reading-progress?sessionId=${encodeURIComponent(sid)}`, {
            signal: abortController.signal,
          });
          if (resp.ok) {
            const data = await resp.json();
            const rawProgress = data.progress || [];
            const items = Array.isArray(rawProgress)
              ? rawProgress as Array<{ chapterIndex: number; scrollPercent: number | null }>
              : [];
            const saved = items.find((p: { chapterIndex: number }) => p.chapterIndex === index);
            if (saved && typeof saved.scrollPercent === 'number' && saved.scrollPercent > 0) {
              pendingScrollRestore.current = saved.scrollPercent;
            }
          }
        }
      } catch { /* best-effort, abort is ok */ }

      try {
        const data = await apiFetch<{ content?: string }>(`/api/public/chapters/${chapter.id}`, {
          signal: abortController.signal,
        });
        setChapterContent(data.content || '（本章暂无内容）');
        recordReadingActivity();
        reportReadingGoal(data.content?.length || 0);
        // Restore saved scroll position after content renders
        if (pendingScrollRestore.current !== null) {
          const sp = pendingScrollRestore.current;
          pendingScrollRestore.current = null;
          requestAnimationFrame(() => {
            const el = readerContentRef.current;
            if (el && el.scrollHeight > el.clientHeight) {
              el.scrollTo({
                top: (sp / 100) * (el.scrollHeight - el.clientHeight),
                behavior: 'instant' as ScrollBehavior,
              });
            }
          });
        }
      } catch (err) {
        if (!(err instanceof FetchError && err.status === 0)) {
          setChapterError(true);
          setChapterContent('');
        }
      } finally {
        if (!abortController.signal.aborted) setLoadingChapter(false);
      }
    },
    [] // stable — reads chapters from ref
  );

  // Load chapter content when dialog opens
  useEffect(() => {
    if (readerOpen) {
      loadChapter(currentIndex);
    }
    return () => {
      loadChapterAbortRef.current?.abort();
    };
  }, [readerOpen, loadChapter]);

  const goToChapter = useCallback(
    (direction: 'prev' | 'next') => {
      const newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
      if (newIndex >= 0 && newIndex < chapters.length) {
        loadChapter(newIndex);
        // Progress save is handled by the useEffect below — no duplicate save here (M3 fix)
      }
    },
    [currentIndex, chapters.length, loadChapter]
  );

  // Save progress when changing chapters
  useEffect(() => {
    if (readerOpen && !loadingChapter && chapterContent) {
      saveProgress(prevIndexRef.current, scrollPercent);
    }
    prevIndexRef.current = currentIndex;
  }, [currentIndex, readerOpen, loadingChapter, chapterContent, saveProgress, scrollPercent]);

  // ─── Scroll progress tracking (throttled via rAF) ───────────────
  useEffect(() => {
    if (!readerOpen) return;
    const container = readerContentRef.current;
    if (!container) return;
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const el = container;
        if (!el) return;
        if (el.scrollTop === 0) { setScrollPercent(0); ticking = false; return; }
        const scrollable = el.scrollHeight - el.clientHeight;
        if (scrollable <= 0) { setScrollPercent(100); ticking = false; return; }
        setScrollPercent(Math.round((el.scrollTop / scrollable) * 1000) / 10);
        ticking = false;
      });
    }
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [readerOpen]);

  // ─── Fullscreen API ──────────────────────────────────────────────
  useEffect(() => {
    if (!readerOpen) return;
    if (readerFullscreen) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    }
  }, [readerFullscreen, readerOpen]);

  useEffect(() => {
    function handleFullscreenChange() {
      if (!document.fullscreenElement && readerFullscreen) {
        setReaderFullscreen(false);
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (document.fullscreenElement) document.exitFullscreen?.();
    };
  }, [readerFullscreen]);

  // ─── Keyboard navigation ─────────────────────────────────────────
  useEffect(() => {
    if (!readerOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      // Don't intercept when user is interacting with form elements
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
        setShowShortcutsHelp((p) => !p);
      } else if (e.key === 'ArrowUp' && !isInteractive) {
        // Scroll reader content up
        e.preventDefault();
        const target = readerContentRef.current || window;
        target.scrollBy({ top: -200, behavior: 'smooth' });
      } else if (e.key === 'ArrowDown' && !isInteractive) {
        // Scroll reader content down
        e.preventDefault();
        const target = readerContentRef.current || window;
        target.scrollBy({ top: 200, behavior: 'smooth' });
      } else if (e.key === 'Escape') {
        if (searchOpen) {
          setSearchOpen(false);
          setSearchQuery('');
          setCurrentMatch(0);
        } else if (showSettings) {
          setShowSettings(false);
        } else if (showBookmarks) {
          setShowBookmarks(false);
        } else if (showChapterSidebar) {
          setShowChapterSidebar(false);
        } else if (readerFullscreen) {
          setReaderFullscreen(false);
        } else {
          setReaderOpen(false);
        }
      } else if (e.key === 'b' && !e.metaKey && !e.ctrlKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          setShowBookmarks((p) => !p);
        }
      } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          setReaderFullscreen((p) => !p);
        }
      } else if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
        if (!searchOpen) {
          e.preventDefault();
          setSearchOpen(true);
          setSearchQuery('');
          setCurrentMatch(0);
        }
        // When search is already open, let browser Ctrl+F work natively
      } else if (e.key === 'Enter' && searchOpen && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Ctrl+Enter / Cmd+Enter cycles to next match
        setCurrentMatch((p) => {
          const total = getMatchCount();
          return total > 0 ? (p + 1) % total : 0;
        });
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readerOpen, readerFullscreen, showChapterSidebar, showBookmarks, showSettings, goToChapter, searchOpen, getMatchCount]);

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < chapters.length - 1;

  // ─── Reading timer (updates every 30s) ──────────────────────────
  useEffect(() => {
    if (!readerOpen) return;
    const interval = setInterval(() => {
      setReadDuration(Math.floor((Date.now() - readStartTime) / 1000));
    }, 30000);
    return () => clearInterval(interval);
  }, [readerOpen, readStartTime]);

  // ─── Scroll active match into view ───────────────────────────────
  useEffect(() => {
    if (!searchOpen || matchCount === 0) return;
    const container = readerContentRef.current;
    if (!container) return;
    const activeMark = container.querySelector(`[data-match-index="${currentMatch}"]`);
    if (activeMark) {
      activeMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentMatch, searchOpen, matchCount]);

  // ─── Close search handler ────────────────────────────────────────
  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setCurrentMatch(0);
  }, []);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        {/* ─── Back button ────────────────────────────── */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/')}
          className="mb-6 -ml-2 gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          返回首页
        </Button>

        {/* ─── Novel info section ─────────────────────────────── */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' as const }}
          className="rounded-2xl border bg-gradient-to-br from-muted/40 via-background to-muted/20 p-6 sm:p-8 glass-card"
        >
          <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
            {/* Cover with 3D tilt */}
            <div className="shrink-0">
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, delay: 0.1 }}
                className="w-48 h-64 overflow-hidden rounded-xl shadow-lg cursor-grab active:cursor-grabbing"
                style={{ perspective: '800px' }}
                onMouseMove={handleCoverMouseMove}
                onMouseLeave={handleCoverMouseLeave}
              >
                <div
                  ref={coverRef}
                  className="w-full h-full transition-transform duration-200 ease-out [transform-style:preserve-3d]"
                >
                  {novel.coverUrl ? (
                    <img
                      src={novel.coverUrl}
                      alt={novel.title}
                      className="h-full w-full object-cover [backface-visibility:hidden]"
                    />
                  ) : (
                    <div
                      className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center [backface-visibility:hidden]`}
                    >
                      <span className="text-6xl font-bold text-white/90 select-none">
                        {novel.title.charAt(0)}
                      </span>
                    </div>
                  )}
                </div>
              </motion.div>
              {/* Cover shadow that responds to tilt */}
              <div className="mx-3 mt-2 h-4 rounded-full bg-gradient-to-r from-transparent via-black/10 to-transparent blur-sm transition-all duration-300" />
            </div>

            {/* Meta */}
            <div className="flex-1 min-w-0 space-y-4">
              <div className="flex items-start gap-3">
                <motion.h1
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.15 }}
                  className="text-2xl sm:text-3xl font-bold leading-tight"
                >
                  {novel.title}
                </motion.h1>
                <Button
                  size="sm"
                  disabled={chapters.length === 0}
                  onClick={() => openReader(safeLastChapterIndex ?? 0)}
                  className="shrink-0 mt-1 gap-1.5"
                >
                  <BookOpen className="h-4 w-4" />
                  {safeLastChapterIndex !== null ? '继续阅读' : '开始阅读'}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className={`shrink-0 mt-1 h-9 w-9 transition-colors ${isFavorited ? 'text-red-500 hover:text-red-600' : 'text-muted-foreground hover:text-red-400'}`}
                  onClick={handleToggleFavorite}
                  aria-label={isFavorited ? '取消收藏' : '收藏'}
                >
                  <Heart className={`h-5 w-5 ${isFavorited ? 'fill-current' : ''}`} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0 mt-1 h-9 w-9 text-muted-foreground hover:text-foreground transition-colors export-btn"
                  onClick={() => window.open(`/api/novels/${novel.id}/export/epub`)}
                  aria-label="导出"
                >
                  <Download className="h-5 w-5" />
                </Button>
              </div>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="text-sm text-muted-foreground"
              >
                {novel.author}
              </motion.p>

              {/* Status & Category */}
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
                {novel.category && (
                  <span
                    className="inline-flex items-center text-xs px-2 py-0.5 rounded-full"
                    style={{
                      backgroundColor: `${novel.category.color}18`,
                      color: novel.category.color,
                    }}
                  >
                    {novel.category.icon && <span className="mr-1">{novel.category.icon}</span>}
                    {novel.category.name}
                  </span>
                )}
              </div>

              {/* Tags */}
              {novel.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {novel.tags.map((tag) => (
                    <span
                      key={tag.id}
                      className="badge-interactive tag-pill-glow text-xs px-2 py-0.5 rounded-full border"
                      style={{
                        borderColor: `${tag.color}40`,
                        color: tag.color,
                        backgroundColor: `${tag.color}10`,
                      }}
                    >
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Description */}
              {novel.description && (
                <div className="pt-2">
                  <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    简介
                  </h2>
                  <p className="text-sm leading-relaxed text-foreground/80 whitespace-pre-line">
                    {novel.description}
                  </p>
                </div>
              )}

              {/* Stats */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.25 }}
                  className="flex items-center gap-2 rounded-lg bg-muted/60 px-4 py-2"
                >
                  <FileText className="h-4 w-4 text-primary" />
                  <div>
                    <div className="text-lg font-semibold leading-none tabular-nums">{formatWordCount(novel.wordCount)}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">总字数</div>
                  </div>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="flex items-center gap-2 rounded-lg bg-muted/60 px-4 py-2"
                >
                  <BookOpen className="h-4 w-4 text-primary" />
                  <div>
                    <div className="text-lg font-semibold leading-none tabular-nums">{novel._count.chapters}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">总章节</div>
                  </div>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.35 }}
                  className="flex items-center gap-2 rounded-lg bg-muted/60 px-4 py-2"
                >
                  <Eye className="h-4 w-4 text-primary" />
                  <div>
                    <div className="text-lg font-semibold leading-none tabular-nums">{novel.clickCount.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">点击</div>
                  </div>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                  className="flex items-center gap-2 rounded-lg bg-muted/60 px-4 py-2"
                >
                  <BookmarkCheck className="h-4 w-4 text-primary" />
                  <div>
                    <div className="text-lg font-semibold leading-none tabular-nums">{localFavoriteCount.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">收藏</div>
                  </div>
                </motion.div>
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.45 }}
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
                >
                  <Clock className="h-3.5 w-3.5" />
                  更新于 {formatDate(novel.updatedAt)}
                </motion.span>
              </div>
            </div>
          </div>
        </motion.section>

        {/* ─── Reading progress indicator ──────────────────────── */}
        {safeLastChapterIndex !== null && chapters.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="mt-4 flex items-center gap-2 px-4 py-2.5 rounded-lg bg-primary/5 border border-primary/10"
          >
            <BookmarkCheck className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm text-muted-foreground">
              上次阅读到{' '}
              <button
                onClick={() => openReader(safeLastChapterIndex)}
                className="text-primary hover:underline font-medium"
              >
                第{chapters[safeLastChapterIndex].sortOrder}章 {chapters[safeLastChapterIndex].title}
              </button>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs"
              onClick={() => openReader(safeLastChapterIndex)}
            >
              继续阅读
            </Button>
          </motion.div>
        )}

        {/* ─── Chapter list section ────────────────────────────── */}
        <section className="py-8">
          <div className="flex items-center justify-between border-b pb-3 mb-4">
            <h2 className="text-lg font-semibold">章节目录</h2>
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
                  onClick={() => setFilterBookmarks((p) => !p)}
                  className={`text-xs px-2 py-1 rounded-md transition-colors ${filterBookmarks ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
                >
                  {filterBookmarks ? '显示全部' : '仅书签'}
                </button>
                {bookmarks.length > 0 && (
                  <button
                    onClick={() => setBookmarkManagerOpen(true)}
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
                className="max-h-[600px] overflow-y-auto rounded-lg border scrollbar-thin"
              >
                {visibleChapters.map((chapter, localIndex) => {
                  const globalIndex = (chapterPage - 1) * CHAPTERS_PER_PAGE + localIndex;
                  return (
                    <motion.button
                      key={chapter.id}
                      variants={itemVariants}
                      onClick={() => openReader(globalIndex)}
                      className={
                        'chapter-row flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors border-b last:border-b-0 group ' +
                        (globalIndex % 2 === 0 ? '' : 'bg-muted/30') +
                        (lastChapterIndex === globalIndex ? ' bg-primary/5 border-l-2 border-l-primary' : '')
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
                        {isBookmarked(globalIndex) && (
                          <BookmarkCheck className="h-3 w-3 shrink-0 text-amber-500" />
                        )}
                        {chapter.wordCount > 0 && (
                          <span className="text-xs text-muted-foreground/60 shrink-0 tabular-nums">
                            {chapter.wordCount}字{formatReadingTime(chapter.wordCount) && ` · ${formatReadingTime(chapter.wordCount)}`}
                          </span>
                        )}
                      </div>
                      {lastChapterIndex === globalIndex && (
                        <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 text-primary border-primary/30 badge-transition">
                          上次
                        </Badge>
                      )}
                    </motion.button>
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
                    onClick={() => setChapterPage((p) => p - 1)}
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
                    onClick={() => setChapterPage((p) => p + 1)}
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

        {/* ─── Bottom nav hint ─────────────────────────────────── */}
        <div className="border-t py-6 text-center text-xs text-muted-foreground">
          点击章节开始阅读 · 支持键盘翻页
        </div>
      </div>

      <BackToTop threshold={300} />

      {/* ─── Reader Dialog ────────────────────────────────────── */}
      <Dialog open={readerOpen} onOpenChange={(open) => { if (!open) { setReaderFullscreen(false); setSearchOpen(false); setSearchQuery(''); setCurrentMatch(0); setReaderOpen(false); } }}>
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
            bookmarksCount={bookmarks.length}
            isCurrentBookmarked={isBookmarked(currentIndex)}
            chapterContent={chapterContent}
            settings={settings}
            readerFullscreen={readerFullscreen}
            onGoToChapter={goToChapter}
            onToggleChapterSidebar={() => setShowChapterSidebar((p) => !p)}
            onToggleBookmarks={() => setShowBookmarks((p) => !p)}
            onToggleSettings={() => setShowSettings((p) => !p)}
            onToggleShortcuts={() => setShowShortcutsHelp((p) => !p)}
            onToggleBookmark={() => addBookmark(currentIndex, chapterTitle, scrollPercent / 100)}
            onRemoveBookmark={() => removeBookmark(currentIndex)}
            onExportChapter={() => {
              const ch = chapters[currentIndex];
              if (ch) window.open(`/api/novels/${novel.id}/chapters?chapterId=${ch.id}&export=txt`);
            }}
            onToggleFullscreen={() => setReaderFullscreen((p) => !p)}
            onUpdateSettings={updateSettings}
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
              onLoadChapter={loadChapter}
              onSidebarPageChange={setSidebarPage}
            />

            {/* Bookmarks panel (right side) */}
            <BookmarksPanel
              visible={showBookmarks}
              bookmarks={bookmarks}
              chapters={chapters}
              currentIndex={currentIndex}
              onLoadChapter={loadChapter}
              onSaveProgress={saveProgress}
              onRemoveBookmark={removeBookmark}
              onClearAllBookmarks={clearAllBookmarks}
            />

            {/* Reader search bar */}
            <ReaderSearchBar
              visible={searchOpen}
              searchQuery={searchQuery}
              matchCount={matchCount}
              currentMatch={currentMatch}
              onSearchQueryChange={setSearchQuery}
              onCurrentMatchChange={setCurrentMatch}
              onClose={handleCloseSearch}
            />

            {/* Reader content */}
            <ReaderContent
              contentRef={readerContentRef}
              loading={loadingChapter}
              error={chapterError}
              content={chapterContent}
              chapterTitle={chapterTitle}
              currentTheme={currentTheme}
              currentFontCss={currentFont.css}
              fontSize={settings.fontSize}
              lineHeight={settings.lineHeight}
              searchOpen={searchOpen}
              searchQuery={searchQuery}
              currentMatch={currentMatch}
              onRetry={() => loadChapter(currentIndex)}
            />
          </div>

          {/* ── Bottom nav bar ────────────────────────────────── */}
          <BottomNav
            hasPrev={hasPrev}
            hasNext={hasNext}
            loadingChapter={loadingChapter}
            onGoToChapter={goToChapter}
            readDuration={readDuration}
          />
        </DialogContent>
      </Dialog>

      {/* Keyboard shortcuts help dialog */}
      <KeyboardShortcutsPanel
        open={showShortcutsHelp}
        onOpenChange={setShowShortcutsHelp}
      />

      {/* Bookmark manager dialog */}
      <BookmarkManager
        bookmarks={bookmarks}
        chapters={chapters.map((ch) => ({
          id: ch.id,
          title: ch.title,
          sortOrder: ch.sortOrder,
        }))}
        onJump={openReader}
        onRemove={removeBookmark}
        open={bookmarkManagerOpen}
        onOpenChange={setBookmarkManagerOpen}
      />
    </main>
  );
}
