'use client';

import { useState, useEffect, useCallback, useRef, useMemo, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowLeft, BookmarkCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BookmarkManager } from '@/components/BookmarkManager';
import {
  useReadingSettings,
  useReadingProgress,
  useChapterBookmarks,
} from '@/lib/use-reading-settings';
import { apiFetch, FetchError } from '@/lib/api-fetch';
import { getCoverGradient } from '@/lib/cover-gradient';
import type { Novel, Chapter } from './reader/types';
import { KeyboardShortcutsPanel } from './reader/KeyboardShortcutsPanel';
import { ChapterContentGrid } from '@/components/novel/detail/ChapterContentGrid';
import { NovelInfoSection } from './parts/NovelInfoSection';
import { ChapterListSection } from './parts/ChapterListSection';
import { ReaderDialog } from './parts/ReaderDialog';
import { useReaderFullscreen } from './parts/useReaderFullscreen';
import { useReaderKeyboard } from './parts/useReaderKeyboard';
import { recordReadingActivity, reportReadingGoal } from './parts/reading-activity';

// ─── Constants ─────────────────────────────────────────────────────

const SIDEBAR_PAGE_SIZE = 200;
const CHAPTERS_PER_PAGE = 100;

// ─── Component ───────────────────────────────────────────────────────

export default function NovelDetailClient({ novel, chapters: initialChapters, totalChapters: initialTotal }: { novel: Novel; chapters: Chapter[]; totalChapters?: number }) {
  const router = useRouter();
  const gradient = getCoverGradient(novel.title);
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

  // Reset bookmark manager when novel changes
  useEffect(() => {
    setBookmarkManagerOpen(false);
  }, [novel.id]);

  // ─── Track click count (fire-and-forget with timeout) ─────────
  useEffect(() => {
    const ac = new AbortController();
    apiFetch(`/api/public/novels/${novel.id}/click`, { method: 'POST', silent: true, timeout: 5000, signal: ac.signal }).catch(() => {});
    return () => ac.abort();
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
  const [showNotes, setShowNotes] = useState(false);
  const [sidebarPage, setSidebarPage] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(0);
  // ─── Full chapter list (may load more from server on demand) ────────
  const [allChapters, setAllChapters] = useState(initialChapters);
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
  const readStartTimeRef = useRef(Date.now());
  const [readDuration, setReadDuration] = useState(0);
  const isFirstReaderLoad = useRef(true);

  // ─── Favorite state (optimistic UI) ───────────────────────────────
  const [isFavorited, setIsFavorited] = useState(false);
  const [localFavoriteCount, setLocalFavoriteCount] = useState(novel.favoriteCount);
  const [favoriteLoading, setFavoriteLoading] = useState(false);

  const handleToggleFavorite = useCallback(async () => {
    if (favoriteLoading) return;
    const nextFav = !isFavorited;
    setIsFavorited(nextFav);
    setLocalFavoriteCount((c) => (nextFav ? c + 1 : Math.max(0, c - 1)));
    try {
      const res = await apiFetch<{ favoriteCount: number }>(`/api/novels/${novel.id}/favorite`, {
        method: 'POST',
        body: JSON.stringify({ favorite: nextFav }),
      });
      setLocalFavoriteCount(res.favoriteCount);
    } catch {
      setIsFavorited(!nextFav);
      setLocalFavoriteCount((c) => (nextFav ? Math.max(0, c - 1) : c + 1));
    } finally {
      setFavoriteLoading(false);
    }
  }, [favoriteLoading, isFavorited, novel.id]);

  // ─── Search match count ─────────────────────────────────────────
  const matchCount = useMemo(() => {
    if (!chapterContent || !searchQuery.trim()) return 0;
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = chapterContent.match(new RegExp(escaped, 'gi'));
    return matches ? matches.length : 0;
  }, [chapterContent, searchQuery]);

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
  }, [novel.id, initialTotal, initialChapters.length]);

  const safeLastChapterIndex = lastChapterIndex !== null && lastChapterIndex < allChapters.length
    ? lastChapterIndex : null;

  // ─── Chapter list pagination (client-side) ───────────────
  const [chapterPage, setChapterPage] = useState(1);
  const chapterTotalPages = Math.ceil(chapters.length / CHAPTERS_PER_PAGE);

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
      if (!chapters[index]) return;
      setCurrentIndex(index);
      setChapterContent(null);
      setChapterTitle(chapters[index].title);
      setReaderOpen(true);
      setShowSettings(false);
      setShowChapterSidebar(false);
      readStartTimeRef.current = Date.now();
    },
    [chapters]
  );

  const loadChapterAbortRef = useRef<AbortController | null>(null);

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

      requestAnimationFrame(() => {
        readerContentRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      });

      loadChapterAbortRef.current?.abort();
      const abortController = new AbortController();
      loadChapterAbortRef.current = abortController;

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
        setChapterContent(data.content || '');
        recordReadingActivity();
        const wordLen = data.content?.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length || 0;
        reportReadingGoal(wordLen);
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
    []
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
      }
    },
    [currentIndex, chapters.length, loadChapter]
  );

  // Save progress when changing chapters (skip first load to avoid saving stale chapter 0)
  useEffect(() => {
    if (isFirstReaderLoad.current) {
      isFirstReaderLoad.current = false;
      prevIndexRef.current = currentIndex;
      return;
    }
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

  // ─── Fullscreen ──────────────────────────────────────────────
  useReaderFullscreen(readerOpen, readerFullscreen, setReaderFullscreen);

  // ─── Close search handler (used by keyboard hook) ───────────────
  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setCurrentMatch(0);
  }, []);

  // ─── Keyboard navigation ─────────────────────────────────────────
  const handleEscape = useCallback(() => {
    if (searchOpen) {
      setSearchOpen(false); setSearchQuery(''); setCurrentMatch(0);
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
  }, [searchOpen, showSettings, showBookmarks, showChapterSidebar, readerFullscreen]);

  const handleCycleMatch = useCallback(() => {
    setCurrentMatch((p) => {
      const total = getMatchCount();
      return total > 0 ? (p + 1) % total : 0;
    });
  }, [getMatchCount]);

  useReaderKeyboard({
    readerOpen,
    searchOpen,
    showBookmarks,
    showChapterSidebar,
    readerFullscreen,
    goToChapter,
    getMatchCount,
    readerContentRef,
    onToggleShortcutsHelp: () => setShowShortcutsHelp((p) => !p),
    onCloseSearch: handleCloseSearch,
    onOpenSearch: () => { setSearchOpen(true); setSearchQuery(''); setCurrentMatch(0); },
    onCycleMatch: handleCycleMatch,
    onToggleBookmarks: () => setShowBookmarks((p) => !p),
    onToggleFullscreen: () => setReaderFullscreen((p) => !p),
    onToggleChapterSidebar: () => setShowChapterSidebar((p) => !p),
    onEscape: handleEscape,
  });

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < chapters.length - 1;

  // ─── Reading timer (updates every 30s) ──────────────────────────
  useEffect(() => {
    if (!readerOpen) return;
    const interval = setInterval(() => {
      setReadDuration(Math.floor((Date.now() - readStartTimeRef.current) / 1000));
    }, 30000);
    return () => clearInterval(interval);
  }, [readerOpen]);

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

  // ─── Close reader handler ────────────────────────────────────────
  const handleCloseReader = useCallback(() => {
    setReaderFullscreen(false);
    setSearchOpen(false);
    setSearchQuery('');
    setCurrentMatch(0);
    setReaderOpen(false);
  }, []);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        {/* ─── Back button ────────────────────────────── */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/')}
          className="mb-6 -ml-2 gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          返回首页
        </Button>

        {/* ─── Novel info section ─────────────────────────────── */}
        <NovelInfoSection
          novel={novel}
          chapters={chapters}
          safeLastChapterIndex={safeLastChapterIndex}
          gradient={gradient}
          coverRef={coverRef}
          onCoverMouseMove={handleCoverMouseMove}
          onCoverMouseLeave={handleCoverMouseLeave}
          isFavorited={isFavorited}
          localFavoriteCount={localFavoriteCount}
          onToggleFavorite={handleToggleFavorite}
          onOpenReader={openReader}
        />

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

        {/* ─── Chapter content grid ──────────────────────────── */}
        <div className="mt-4">
          <ChapterContentGrid
            chapters={chapters}
            currentChapterIndex={readerOpen ? currentIndex : safeLastChapterIndex}
            onOpenReader={openReader}
          />
        </div>

        {/* ─── Chapter list section ────────────────────────────── */}
        <ChapterListSection
          chapters={chapters}
          displayedChapters={displayedChapters}
          chapterPage={chapterPage}
          chapterTotalPages={chapterTotalPages}
          lastChapterIndex={lastChapterIndex}
          onOpenReader={openReader}
          isBookmarked={isBookmarked}
          filterBookmarks={filterBookmarks}
          onToggleFilterBookmarks={() => setFilterBookmarks((p) => !p)}
          bookmarks={bookmarks}
          onBookmarkManagerOpen={() => setBookmarkManagerOpen(true)}
          chaptersWithContent={chaptersWithContent}
          contentProgress={contentProgress}
          onChapterPageChange={setChapterPage}
        />

        {/* ─── Bottom nav hint ─────────────────────────────────── */}
        <div className="border-t py-6 text-center text-xs text-muted-foreground/70">
          点击章节开始阅读 · 支持键盘翻页
        </div>
      </div>

      {/* ─── Reader Dialog ────────────────────────────────────── */}
      <ReaderDialog
        open={readerOpen}
        readerFullscreen={readerFullscreen}
        readerDialogRef={readerDialogRef}
        scrollPercent={scrollPercent}
        currentIndex={currentIndex}
        chapters={chapters}
        hasPrev={hasPrev}
        hasNext={hasNext}
        loadingChapter={loadingChapter}
        showSettings={showSettings}
        showBookmarks={showBookmarks}
        showShortcutsHelp={showShortcutsHelp}
        showNotes={showNotes}
        showChapterSidebar={showChapterSidebar}
        showSearch={searchOpen}
        bookmarksCount={bookmarks.length}
        isCurrentBookmarked={isBookmarked(currentIndex)}
        chapterContent={chapterContent}
        chapterTitle={chapterTitle}
        chapterError={chapterError}
        settings={settings}
        currentTheme={currentTheme}
        currentFontCss={currentFont.css}
        searchQuery={searchQuery}
        searchMatchCount={matchCount}
        searchCurrentMatch={currentMatch}
        readDuration={readDuration}
        sidebarPage={sidebarPage}
        sidebarTotalPages={sidebarTotalPages}
        sidebarChapters={sidebarChapters}
        lastChapterIndex={lastChapterIndex}
        bookmarks={bookmarks}
        readerContentRef={readerContentRef}
        onClose={handleCloseReader}
        onGoToChapter={goToChapter}
        onLoadChapter={loadChapter}
        onSaveProgress={saveProgress}
        onToggleChapterSidebar={() => setShowChapterSidebar((p) => !p)}
        onToggleBookmarks={() => setShowBookmarks((p) => !p)}
        onToggleSettings={() => setShowSettings((p) => !p)}
        onToggleShortcutsHelp={() => setShowShortcutsHelp((p) => !p)}
        onToggleNotes={() => setShowNotes((p) => !p)}
        onToggleFullscreen={() => setReaderFullscreen((p) => !p)}
        onToggleBookmark={() => addBookmark(currentIndex, chapterTitle, scrollPercent / 100)}
        onRemoveBookmark={() => removeBookmark(currentIndex)}
        onClearAllBookmarks={clearAllBookmarks}
        onExportChapter={() => {
          const ch = chapters[currentIndex];
          if (ch) window.open(`/api/novels/${novel.id}/chapters?chapterId=${ch.id}&export=txt`);
        }}
        onUpdateSettings={updateSettings}
        onRetry={() => loadChapter(currentIndex)}
        onSidebarPageChange={setSidebarPage}
        onSearchQueryChange={setSearchQuery}
        onSearchCurrentMatchChange={setCurrentMatch}
        onCloseSearch={handleCloseSearch}
      />

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
