'use client';

import { useState, useEffect, useCallback, useRef, type MouseEvent, type ReactNode, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
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
  ChevronUp,
  ChevronDown,
  Maximize2,
  Minimize2,
  Loader2,
  Search,
  Settings2,
  List,
  BookmarkCheck,
  RotateCcw,
  X,
  Keyboard,
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
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { BackToTop } from '@/components/BackToTop';
import {
  useReadingSettings,
  useReadingProgress,
  useChapterBookmarks,
  FONT_FAMILIES,
  READING_THEMES,
} from '@/lib/use-reading-settings';
import { ReadingSettingsPanel } from '@/components/ReadingSettingsPanel';
import { DailyReadingGoal } from '@/components/DailyReadingGoal';
import { BookmarkManager } from '@/components/BookmarkManager';
import { formatWordCount, formatReadingTime } from '@/lib/format';
import { apiFetch, FetchError } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────

interface Tag {
  id: string;
  name: string;
  color: string;
}

interface Chapter {
  id: string;
  title: string;
  wordCount: number;
  sortOrder: number;
  createdAt: string;
}

interface Novel {
  id: string;
  title: string;
  author: string;
  description: string | null;
  coverUrl: string | null;
  coverPath: string | null;
  status: string;
  wordCount: number;
  clickCount: number;
  favoriteCount: number;
  category: { id: string; name: string; slug: string; color: string; icon: string | null } | null;
  tags: Tag[];
  _count: { chapters: number };
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  ongoing: { label: '连载中', variant: 'default' },
  completed: { label: '已完结', variant: 'secondary' },
  hiatus: { label: '暂停中', variant: 'outline' },
};

import { getCoverGradient } from '@/lib/cover-gradient';

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

function formatReadDuration(seconds: number): string {
  if (seconds < 60) return '';
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}min`;
}

// ─── Component ───────────────────────────────────────────────────────

const SIDEBAR_PAGE_SIZE = 200;
const CHAPTERS_PER_PAGE = 100;

// ─── Reader search highlight helper ─────────────────────────────────
// Splits text around matches and wraps them in <mark> elements (React, not raw HTML).
function highlightText(text: string, query: string, activeIndex: number): ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  let matchCount = 0;
  return parts.map((part, i) => {
    if (regex.test(part)) {
      regex.lastIndex = 0; // reset for next test
      const idx = matchCount++;
      const isActive = idx === activeIndex;
      return (
        <mark
          key={i}
          className={`rounded-sm px-0.5 ${isActive ? 'bg-amber-400/70 dark:bg-amber-500/60 ring-2 ring-amber-400/50' : 'bg-amber-200/70 dark:bg-amber-500/25'}`}
          data-match-index={idx}
        >
          {part}
        </mark>
      );
    }
    regex.lastIndex = 0;
    return part;
  });
}

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
  const displayedChapters = useMemo(() => {
    if (filterBookmarks && bookmarks.length > 0) return chapters.filter((_, idx) => isBookmarked(idx));
    return chapters;
  }, [chapters, bookmarks.length, filterBookmarks, isBookmarked]);

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
  const searchInputRef = useRef<HTMLInputElement>(null);
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
  const matchCount = useMemo(() => {
    if (!chapterContent || !searchQuery.trim()) return 0;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
    const matches = chapterContent.match(new RegExp(escaped, 'gi'));
    return matches ? matches.length : 0;
  }, [chapterContent, searchQuery]);

  const getMatchCount = useCallback(() => matchCount, [matchCount]);

  // ─── Reading settings ────────────────────────────────────────────
  const { settings, updateSettings, currentTheme, currentFont } = useReadingSettings();

  // ─── Reading progress ────────────────────────────────────────────
  const { lastChapterIndex, saveProgress } = useReadingProgress(novel.id, chapters);
  const { bookmarks, addBookmark, removeBookmark, clearAllBookmarks, isBookmarked } = useChapterBookmarks(novel.id);
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

  // ─── Auto-focus search input ─────────────────────────────────────
  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchOpen]);

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

  const handleSearchPrev = useCallback(() => {
    setCurrentMatch((p) => (matchCount > 0 ? (p - 1 + matchCount) % matchCount : 0));
  }, [matchCount]);

  const handleSearchNext = useCallback(() => {
    setCurrentMatch((p) => (matchCount > 0 ? (p + 1) % matchCount : 0));
  }, [matchCount]);

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
                第 {currentIndex + 1}/{chapters.length} 章
                <span className="ml-2 text-muted-foreground/60">{scrollPercent}%</span>
              </span>

              {/* Center: nav buttons */}
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 press-effect"
                  disabled={!hasPrev || loadingChapter}
                  onClick={() => goToChapter('prev')}
                  title="上一章 (←)"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 press-effect"
                  disabled={!hasNext || loadingChapter}
                  onClick={() => goToChapter('next')}
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
                      onClick={() => setShowChapterSidebar((p) => !p)}
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
                      onClick={() => setShowBookmarks((p) => !p)}
                    >
                      <BookmarkCheck className="h-3.5 w-3.5" />
                      {bookmarks.length > 0 && !showBookmarks && (
                        <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 flex items-center justify-center rounded-full bg-amber-500 text-[8px] font-bold text-white leading-none">
                          {bookmarks.length > 9 ? '9+' : bookmarks.length}
                        </span>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {showBookmarks ? '关闭书签列表 (B)' : `书签 (${bookmarks.length})`}
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={isBookmarked(currentIndex) ? '移除书签' : '添加书签'}
                      className={
                        'h-7 w-7 transition-colors press-effect ' +
                        (isBookmarked(currentIndex) ? 'text-amber-500' : '')
                      }
                      onClick={() => {
                        if (isBookmarked(currentIndex)) {
                          removeBookmark(currentIndex);
                        } else {
                          addBookmark(currentIndex, chapterTitle, scrollPercent / 100);
                        }
                      }}
                    >
                      {isBookmarked(currentIndex) ? (
                        <BookmarkCheck className="h-3.5 w-3.5 fill-amber-500" />
                      ) : (
                        <BookmarkCheck className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isBookmarked(currentIndex) ? '移除书签' : '添加书签'}
                  </TooltipContent>
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
                      onClick={() => setShowSettings((p) => !p)}
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
                      onClick={() => {
                        const ch = chapters[currentIndex];
                        if (ch) window.open(`/api/novels/${novel.id}/chapters?chapterId=${ch.id}&export=txt`);
                      }}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">导出TXT</TooltipContent>
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
                      onClick={() => setShowShortcutsHelp((p) => !p)}
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
                      onClick={() => setReaderFullscreen((p) => !p)}
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
                    <ReadingSettingsPanel settings={settings} onUpdate={updateSettings} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ── Chapter title ──────────────────────────────────── */}
          <DialogHeader className="shrink-0 px-6 pt-4 pb-2">
            <DialogTitle className="text-base font-semibold truncate">
              {chapterTitle}
            </DialogTitle>
          </DialogHeader>

          {/* ── Content area (with optional sidebar) ────────── */}
          <div className="flex-1 flex overflow-hidden relative">
            {/* Chapter sidebar */}
            <AnimatePresence>
              {showChapterSidebar && (
                <motion.div
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 220, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="shrink-0 border-r overflow-hidden"
                >
                  <div className="w-[220px] h-full overflow-y-auto p-3 flex flex-col">
                    <div className="text-xs font-medium text-muted-foreground mb-2 px-1">
                      目录 ({chapters.length}章)
                    </div>
                    <div className="flex-1 space-y-px">
                    {sidebarChapters.map((ch, idx) => {
                      const globalIdx = (sidebarPage - 1) * SIDEBAR_PAGE_SIZE + idx;
                      return (
                      <button
                        key={ch.id}
                        onClick={() => loadChapter(globalIdx)}
                        className={
                          'block w-full text-left text-xs px-2 py-1.5 rounded-md truncate transition-colors focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none ' +
                          (globalIdx === currentIndex
                            ? 'bg-primary/10 text-primary font-medium'
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
                      <div className="flex items-center justify-center gap-1 pt-2 border-t mt-2">
                        <button
                          className="h-6 w-6 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30"
                          disabled={sidebarPage <= 1}
                          onClick={() => setSidebarPage((p) => p - 1)}
                        ><ChevronLeft className="h-3 w-3" /></button>
                        <span className="text-[10px] text-muted-foreground tabular-nums">{sidebarPage}/{sidebarTotalPages}</span>
                        <button
                          className="h-6 w-6 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30"
                          disabled={sidebarPage >= sidebarTotalPages}
                          onClick={() => setSidebarPage((p) => p + 1)}
                        ><ChevronRight className="h-3 w-3" /></button>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Bookmarks panel (right side) */}
            <AnimatePresence>
              {showBookmarks && (
                <motion.div
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 200, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="shrink-0 border-l overflow-hidden"
                >
                  <div className="w-[200px] h-full overflow-y-auto p-3 flex flex-col">
                    <div className="flex items-center justify-between mb-2 px-1">
                      <div className="text-xs font-medium text-muted-foreground">
                        书签 ({bookmarks.length})
                      </div>
                      {bookmarks.length > 0 && (
                        <button
                          className="text-[10px] text-destructive/60 hover:text-destructive transition-colors"
                          onClick={() => clearAllBookmarks()}
                        >
                          清空
                        </button>
                      )}
                    </div>

                    {bookmarks.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center gap-2 py-8">
                        <BookmarkCheck className="h-6 w-6 text-muted-foreground/30" />
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
                                loadChapter(bm.chapterIndex);
                                saveProgress(bm.chapterIndex);
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
                                    removeBookmark(bm.chapterIndex);
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

            {/* Reader search bar */}
            <AnimatePresence>
              {searchOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.15 }}
                  className="shrink-0 px-3 py-2"
                >
                  <div className="glass-card flex items-center gap-2 rounded-lg border px-3 py-1.5">
                    <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => { setSearchQuery(e.target.value); setCurrentMatch(0); }}
                      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setSearchOpen(false); setSearchQuery(''); setCurrentMatch(0); } if (e.key === 'Enter') { e.preventDefault(); handleSearchNext(); } }}
                      placeholder="搜索本章内容..."
                      aria-label="搜索本章内容"
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none rounded"
                    />
                    {searchQuery.trim() && (
                      <>
                        <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                          {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '无结果'}
                        </span>
                        <button
                          onClick={handleSearchPrev}
                          disabled={matchCount === 0}
                          className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/80 disabled:opacity-30 transition-colors"
                          aria-label="上一个匹配"
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={handleSearchNext}
                          disabled={matchCount === 0}
                          className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/80 disabled:opacity-30 transition-colors"
                          aria-label="下一个匹配"
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => { setSearchOpen(false); setSearchQuery(''); setCurrentMatch(0); }}
                      className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/80 text-muted-foreground/60 hover:text-foreground transition-colors"
                      aria-label="关闭搜索"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Reader content */}
            <div ref={readerContentRef} className="flex-1 overflow-y-auto">
              <div className={`px-6 py-6 sm:px-10 sm:py-8 ${currentTheme.bg} min-h-full transition-colors duration-300`}>
                {loadingChapter ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    <span className="ml-3 text-sm text-muted-foreground">加载中...</span>
                  </div>
                ) : chapterError ? (
                  <div className="flex flex-col items-center justify-center py-20 gap-4">
                    <p className="text-sm text-muted-foreground">加载章节内容失败</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => loadChapter(currentIndex)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      重试
                    </Button>
                  </div>
                ) : chapterContent ? (
                  <div className="mx-auto max-w-3xl">
                    <h3 className={`text-lg font-semibold mb-6 pb-4 border-b text-center ${currentTheme.text} transition-colors duration-300`}>
                      {chapterTitle}
                    </h3>
                    <article
                      className={`whitespace-pre-wrap transition-all duration-300 ${currentTheme.text} ${currentFont.css}`}
                      style={{
                        fontSize: `${settings.fontSize}px`,
                        lineHeight: settings.lineHeight,
                      }}
                    >
                      {(() => {
                        const isSearching = searchOpen && searchQuery.trim();
                        let runningMatches = 0;
                        return chapterContent.split('\n').map((paragraph, i) => {
                          const text = paragraph.trim() || '\u00A0';
                          const matchOffset = runningMatches;
                          if (isSearching && paragraph.trim()) {
                            const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
                            const matches = paragraph.match(new RegExp(escaped, 'gi'));
                            runningMatches += matches ? matches.length : 0;
                          }
                          return (
                            <p
                              key={i}
                              className={paragraph.trim() ? 'text-indent-[2em] mb-0' : 'h-4'}
                            >
                              {isSearching && paragraph.trim()
                                ? highlightText(text, searchQuery, currentMatch - matchOffset)
                                : text}
                            </p>
                          );
                        });
                      })()}
                    </article>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* ── Bottom nav bar ────────────────────────────────── */}
          <div className="shrink-0 border-t px-4 py-2.5 flex items-center justify-between bg-muted/30 glass-card">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev || loadingChapter}
              onClick={() => goToChapter('prev')}
              className="h-8 tap-feedback press-effect"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              上一章
            </Button>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-muted-foreground hidden sm:block">
                ← → J/K 翻页 · ↑↓ 滚动 · B 书签 · F 全屏 · ? 帮助
              </span>
              <DailyReadingGoal />
              {formatReadDuration(readDuration) && (
                <span className="text-xs text-muted-foreground/60 flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatReadDuration(readDuration)}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || loadingChapter}
              onClick={() => goToChapter('next')}
              className="h-8 tap-feedback press-effect"
            >
              下一章
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Keyboard shortcuts help dialog */}
      <Dialog open={showShortcutsHelp} onOpenChange={setShowShortcutsHelp}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="h-4 w-4" />
              阅读器快捷键
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 pt-1">
            {[
              { keys: ['←', '→'], label: '上一章/下一章' },
              { keys: ['J', 'K'], label: '下一章/上一章' },
              { keys: ['↑', '↓'], label: '向上/下滚动' },
              { keys: ['B'], label: '书签面板' },
              { keys: ['F'], label: '全屏切换' },
              { keys: ['Ctrl+F'], label: '搜索内容' },
              { keys: ['?'], label: '本帮助面板' },
              { keys: ['Esc'], label: '关闭面板' },
            ].map((s) => (
              <div key={s.label} className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{s.label}</span>
                <div className="flex items-center gap-0.5">
                  {s.keys.map((k) => (
                    <kbd
                      key={k}
                      className="inline-flex h-5 min-w-5 select-none items-center justify-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground"
                    >
                      {k}
                    </kbd>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

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
