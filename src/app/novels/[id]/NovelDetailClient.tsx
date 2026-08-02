'use client';

import { useState, useEffect, useCallback, useRef, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  BookOpen,
  FileText,
  Clock,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Loader2,
  Settings2,
  List,
  BookmarkCheck,
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
  FONT_FAMILIES,
  READING_THEMES,
} from '@/lib/use-reading-settings';
import { ReadingSettingsPanel } from '@/components/ReadingSettingsPanel';

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

const COVER_GRADIENTS = [
  'from-rose-500/80 to-orange-500/80',
  'from-emerald-500/80 to-teal-500/80',
  'from-violet-500/80 to-purple-500/80',
  'from-amber-500/80 to-yellow-500/80',
  'from-cyan-500/80 to-sky-500/80',
  'from-fuchsia-500/80 to-pink-500/80',
  'from-lime-500/80 to-green-500/80',
  'from-red-500/80 to-rose-500/80',
];

function getGradient(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash);
  return COVER_GRADIENTS[Math.abs(hash) % COVER_GRADIENTS.length];
}

function formatWordCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万字`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}千字`;
  return `${n}字`;
}

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

export default function NovelDetailClient({ novel, chapters }: { novel: Novel; chapters: Chapter[] }) {
  const router = useRouter();
  const gradient = getGradient(novel.title);
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
  }, [novel.id, novel.title, novel.author, novel.coverUrl, novel.category]);

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

  // ─── Reader state ────────────────────────────────────────────────
  const [readerOpen, setReaderOpen] = useState(false);
  const [readerFullscreen, setReaderFullscreen] = useState(false);
  const [showChapterSidebar, setShowChapterSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [chapterContent, setChapterContent] = useState<string | null>(null);
  const [chapterTitle, setChapterTitle] = useState('');
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [scrollPercent, setScrollPercent] = useState(0);
  const readerContentRef = useRef<HTMLDivElement>(null);
  const readerDialogRef = useRef<HTMLDivElement>(null);

  // ─── Reading settings ────────────────────────────────────────────
  const { settings, updateSettings, currentTheme, currentFont } = useReadingSettings();

  // ─── Reading progress ────────────────────────────────────────────
  const { lastChapterIndex, saveProgress } = useReadingProgress(novel.id, chapters);

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

  const loadChapter = useCallback(
    async (index: number) => {
      if (index < 0 || index >= chapters.length) return;
      const chapter = chapters[index];
      setCurrentIndex(index);
      setChapterContent(null);
      setChapterTitle(chapter.title);
      setLoadingChapter(true);

      try {
        const res = await fetch(`/api/public/chapters/${chapter.id}`);
        if (!res.ok) throw new Error('获取失败');
        const data = await res.json();
        setChapterContent(data.content || '（本章暂无内容）');
      } catch {
        setChapterContent('加载章节内容失败，请稍后重试。');
      } finally {
        setLoadingChapter(false);
      }
    },
    [chapters]
  );

  // Load chapter content when dialog opens
  useEffect(() => {
    if (readerOpen) {
      loadChapter(currentIndex);
    }
  }, [readerOpen, loadChapter]);

  const goToChapter = useCallback(
    (direction: 'prev' | 'next') => {
      const newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
      if (newIndex >= 0 && newIndex < chapters.length) {
        loadChapter(newIndex);
        saveProgress(newIndex);
      }
    },
    [currentIndex, chapters.length, loadChapter, saveProgress]
  );

  // Save progress when changing chapters
  useEffect(() => {
    if (readerOpen && !loadingChapter && chapterContent) {
      saveProgress(currentIndex);
    }
  }, [currentIndex, readerOpen, loadingChapter, chapterContent, saveProgress]);

  // ─── Scroll progress tracking ────────────────────────────────────
  useEffect(() => {
    if (!readerOpen) return;
    const container = readerContentRef.current;
    if (!container) return;
    function onScroll() {
      const el = container;
      if (!el) return;
      if (el.scrollTop === 0) { setScrollPercent(0); return; }
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable <= 0) { setScrollPercent(100); return; }
      setScrollPercent(Math.round((el.scrollTop / scrollable) * 100));
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
      } else if (e.key === 'Escape') {
        if (readerFullscreen) {
          setReaderFullscreen(false);
        } else if (showChapterSidebar) {
          setShowChapterSidebar(false);
        } else if (showSettings) {
          setShowSettings(false);
        } else {
          setReaderOpen(false);
        }
      } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          setReaderFullscreen((p) => !p);
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readerOpen, readerFullscreen, showChapterSidebar, showSettings, goToChapter]);

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < chapters.length - 1;

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
          className="rounded-2xl border bg-gradient-to-br from-muted/40 via-background to-muted/20 p-6 sm:p-8"
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
                  onClick={() => openReader(lastChapterIndex ?? 0)}
                  className="shrink-0 mt-1 gap-1.5"
                >
                  <BookOpen className="h-4 w-4" />
                  {lastChapterIndex !== null ? '继续阅读' : '开始阅读'}
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
                      className="badge-interactive text-xs px-2 py-0.5 rounded-full border"
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
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.35 }}
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
        {lastChapterIndex !== null && chapters.length > 0 && (
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
                onClick={() => openReader(lastChapterIndex)}
                className="text-primary hover:underline font-medium"
              >
                第{chapters[lastChapterIndex].sortOrder}章 {chapters[lastChapterIndex].title}
              </button>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs"
              onClick={() => openReader(lastChapterIndex)}
            >
              继续阅读
            </Button>
          </motion.div>
        )}

        {/* ─── Chapter list section ────────────────────────────── */}
        <section className="py-8">
          <div className="flex items-center justify-between border-b pb-3 mb-4">
            <h2 className="text-lg font-semibold">章节目录</h2>
            <span className="text-sm text-muted-foreground tabular-nums">
              共 {chapters.length} 章
            </span>
          </div>

          {chapters.length === 0 ? (
            <div className="py-16 text-center">
              <FileText className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">暂无章节</p>
            </div>
          ) : (
            <motion.div
              variants={containerVariants}
              initial="hidden"
              animate="show"
              className="max-h-[600px] overflow-y-auto rounded-lg border"
            >
              {chapters.map((chapter, index) => (
                <motion.button
                  key={chapter.id}
                  variants={itemVariants}
                  onClick={() => openReader(index)}
                  className={
                    'chapter-row flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors border-b last:border-b-0 group ' +
                    (index % 2 === 0 ? '' : 'bg-muted/30') +
                    (lastChapterIndex === index ? ' bg-primary/5 border-l-2 border-l-primary' : '')
                  }
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{chapter.sortOrder}.</span>
                    <span className="text-sm truncate group-hover:text-primary transition-colors">
                      {chapter.title}
                    </span>
                    {chapter.wordCount > 0 && (
                      <span className="text-xs text-muted-foreground/60 shrink-0 tabular-nums">
                        {chapter.wordCount}字
                      </span>
                    )}
                  </div>
                  {lastChapterIndex === index && (
                    <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 text-primary border-primary/30">
                      上次
                    </Badge>
                  )}
                </motion.button>
              ))}
            </motion.div>
          )}
        </section>

        {/* ─── Bottom nav hint ─────────────────────────────────── */}
        <div className="border-t py-6 text-center text-xs text-muted-foreground">
          点击章节开始阅读 · 支持键盘翻页
        </div>
      </div>

      <BackToTop threshold={300} />

      {/* ─── Reader Dialog ────────────────────────────────────── */}
      <Dialog open={readerOpen} onOpenChange={(open) => { if (!open) { setReaderFullscreen(false); setReaderOpen(false); } }}>
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
                  className="h-7 w-7"
                  disabled={!hasPrev || loadingChapter}
                  onClick={() => goToChapter('prev')}
                  title="上一章 (←)"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
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
                      className="h-7 w-7"
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
                      className={
                        'h-7 w-7 ' + (showSettings ? 'bg-primary/10 text-primary' : '')
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
                      className="h-7 w-7"
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
                  <div className="w-[220px] h-full overflow-y-auto p-3">
                    <div className="text-xs font-medium text-muted-foreground mb-2 px-1">
                      目录 ({chapters.length}章)
                    </div>
                    {chapters.map((ch, idx) => (
                      <button
                        key={ch.id}
                        onClick={() => {
                          loadChapter(idx);
                          saveProgress(idx);
                        }}
                        className={
                          'block w-full text-left text-xs px-2 py-1.5 rounded-md truncate transition-colors ' +
                          (idx === currentIndex
                            ? 'bg-primary/10 text-primary font-medium'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50') +
                          (lastChapterIndex === idx ? ' border-l-2 border-primary/50' : '')
                        }
                      >
                        {ch.sortOrder}. {ch.title}
                      </button>
                    ))}
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
                      {chapterContent.split('\n').map((paragraph, i) => (
                        <p
                          key={i}
                          className={paragraph.trim() ? 'text-indent-[2em] mb-0' : 'h-4'}
                        >
                          {paragraph.trim() || '\u00A0'}
                        </p>
                      ))}
                    </article>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* ── Bottom nav bar ────────────────────────────────── */}
          <div className="shrink-0 border-t px-4 py-2.5 flex items-center justify-between bg-muted/30">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev || loadingChapter}
              onClick={() => goToChapter('prev')}
              className="h-8"
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              上一章
            </Button>
            <span className="text-[11px] text-muted-foreground hidden sm:block">
              ← → 翻页 · F 全屏 · Esc 关闭
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || loadingChapter}
              onClick={() => goToChapter('next')}
              className="h-8"
            >
              下一章
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
