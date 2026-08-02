'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  BookOpen,
  FileText,
  Clock,
  ChevronLeft,
  ChevronRight,
  Loader2,
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

// ─── Component ───────────────────────────────────────────────────────

export default function NovelDetailClient({ novel, chapters }: { novel: Novel; chapters: Chapter[] }) {
  const router = useRouter();
  const gradient = getGradient(novel.title);
  const statusInfo = STATUS_MAP[novel.status] || STATUS_MAP.ongoing;

  // ─── Reader state ────────────────────────────────────────────────
  const [readerOpen, setReaderOpen] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [chapterContent, setChapterContent] = useState<string | null>(null);
  const [chapterTitle, setChapterTitle] = useState('');
  const [loadingChapter, setLoadingChapter] = useState(false);

  const openReader = useCallback(
    (index: number) => {
      setCurrentIndex(index);
      setChapterContent(null);
      setChapterTitle(chapters[index].title);
      setReaderOpen(true);
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
      }
    },
    [currentIndex, chapters.length, loadChapter]
  );

  // ─── Keyboard navigation ─────────────────────────────────────────
  useEffect(() => {
    if (!readerOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToChapter('prev');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToChapter('next');
      } else if (e.key === 'Escape') {
        setReaderOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readerOpen, goToChapter]);

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
        <section className="rounded-2xl border bg-gradient-to-br from-muted/40 via-background to-muted/20 p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
            {/* Cover */}
            <div className="shrink-0">
              <div className="w-48 h-64 overflow-hidden rounded-xl shadow-lg">
                {novel.coverUrl ? (
                  <img
                    src={novel.coverUrl}
                    alt={novel.title}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div
                    className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center`}
                  >
                    <span className="text-6xl font-bold text-white/90 select-none">
                      {novel.title.charAt(0)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Meta */}
            <div className="flex-1 min-w-0 space-y-4">
              <div className="flex items-start gap-3">
                <motion.h1
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-2xl sm:text-3xl font-bold leading-tight"
                >
                  {novel.title}
                </motion.h1>
                <Button
                  size="sm"
                  disabled={chapters.length === 0}
                  onClick={() => openReader(0)}
                  className="shrink-0 mt-1 gap-1.5"
                >
                  <BookOpen className="h-4 w-4" />
                  开始阅读
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{novel.author}</p>

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
                      className="text-xs px-2 py-0.5 rounded-full border"
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

              {/* Prominent stats below description */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
                <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-4 py-2">
                  <FileText className="h-4 w-4 text-primary" />
                  <div>
                    <div className="text-lg font-semibold leading-none">{formatWordCount(novel.wordCount)}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">总字数</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-4 py-2">
                  <BookOpen className="h-4 w-4 text-primary" />
                  <div>
                    <div className="text-lg font-semibold leading-none">{novel._count.chapters}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">总章节</div>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  更新于 {formatDate(novel.updatedAt)}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Chapter list section ────────────────────────────── */}
        <section className="py-8">
          <div className="flex items-center justify-between border-b pb-3 mb-4">
            <h2 className="text-lg font-semibold">章节目录</h2>
            <span className="text-sm text-muted-foreground">
              共 {chapters.length} 章
            </span>
          </div>

          {chapters.length === 0 ? (
            <div className="py-16 text-center">
              <FileText className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm text-muted-foreground">暂无章节</p>
            </div>
          ) : (
            <div className="max-h-[600px] overflow-y-auto rounded-lg border">
              {chapters.map((chapter, index) => (
                <motion.button
                  key={chapter.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(index * 0.02, 0.5) }}
                  onClick={() => openReader(index)}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/60 transition-colors border-b last:border-b-0 group ${index % 2 === 0 ? '' : 'bg-muted/30'}`}
                >
                  <span className="text-sm truncate group-hover:text-primary transition-colors">
                    第{chapter.sortOrder}章 {chapter.title}{chapter.wordCount > 0 ? ` (${chapter.wordCount}字)` : ''}
                  </span>
                </motion.button>
              ))}
            </div>
          )}
        </section>

        {/* ─── Bottom nav hint ─────────────────────────────────── */}
        <div className="border-t py-6 text-center text-xs text-muted-foreground">
          点击章节开始阅读
        </div>
      </div>

      {/* ─── Reader Dialog ────────────────────────────────────── */}
      <Dialog open={readerOpen} onOpenChange={setReaderOpen}>
        <DialogContent className="sm:max-w-3xl h-[85vh] max-h-[85vh] flex flex-col p-0 gap-0">
          {/* Progress indicator */}
          <div className="shrink-0 border-b px-6 py-2 bg-muted/40">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">
                第 {currentIndex + 1}/{chapters.length} 章
              </span>
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
            </div>
          </div>

          {/* Header */}
          <DialogHeader className="shrink-0 px-6 pt-4 pb-2">
            <DialogTitle className="text-base font-semibold truncate">
              {chapterTitle}
            </DialogTitle>
          </DialogHeader>

          {/* Content */}
          <ScrollArea className="flex-1">
            <div className="px-6 py-6 sm:px-10 sm:py-8">
              {loadingChapter ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="ml-3 text-sm text-muted-foreground">加载中...</span>
                </div>
              ) : chapterContent ? (
                <div className="mx-auto max-w-3xl">
                  <h3 className="text-lg font-semibold mb-6 pb-4 border-b text-center">{chapterTitle}</h3>
                  <article className="font-serif text-base leading-[1.9] text-foreground/90 whitespace-pre-wrap">
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
          </ScrollArea>

          {/* Footer nav */}
          <div className="shrink-0 border-t px-6 py-3 flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev || loadingChapter}
              onClick={() => goToChapter('prev')}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              上一章
            </Button>
            <span className="text-xs text-muted-foreground">
              ← → 键盘翻页 · Esc 关闭
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || loadingChapter}
              onClick={() => goToChapter('next')}
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
