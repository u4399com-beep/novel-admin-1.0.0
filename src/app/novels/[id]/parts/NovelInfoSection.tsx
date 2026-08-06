'use client';

import { type MouseEvent, type RefObject } from 'react';
import { motion } from 'framer-motion';
import {
  BookOpen,
  FileText,
  Clock,
  Eye,
  BookmarkCheck,
  Download,
  Heart,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatWordCount } from '@/lib/format';
import type { Novel, Chapter } from '../reader/types';

const STATUS_MAP: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  ongoing: { label: '连载中', variant: 'default' },
  completed: { label: '已完结', variant: 'secondary' },
  hiatus: { label: '暂停中', variant: 'outline' },
};

export interface NovelInfoSectionProps {
  novel: Novel;
  chapters: Chapter[];
  safeLastChapterIndex: number | null;
  gradient: string;
  coverRef: RefObject<HTMLDivElement | null>;
  onCoverMouseMove: (e: MouseEvent<HTMLDivElement>) => void;
  onCoverMouseLeave: () => void;
  isFavorited: boolean;
  localFavoriteCount: number;
  onToggleFavorite: () => void;
  onOpenReader: (index: number) => void;
}

export function NovelInfoSection({
  novel,
  chapters,
  safeLastChapterIndex,
  gradient,
  coverRef,
  onCoverMouseMove,
  onCoverMouseLeave,
  isFavorited,
  localFavoriteCount,
  onToggleFavorite,
  onOpenReader,
}: NovelInfoSectionProps) {
  const statusInfo = STATUS_MAP[novel.status] || STATUS_MAP.ongoing;

  return (
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
            onMouseMove={onCoverMouseMove}
            onMouseLeave={onCoverMouseLeave}
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
              onClick={() => onOpenReader(safeLastChapterIndex ?? 0)}
              className="shrink-0 mt-1 gap-1.5"
            >
              <BookOpen className="h-4 w-4" />
              {safeLastChapterIndex !== null ? '继续阅读' : '开始阅读'}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className={`shrink-0 mt-1 h-9 w-9 transition-colors ${isFavorited ? 'text-red-500 hover:text-red-600' : 'text-muted-foreground hover:text-red-400'}`}
              onClick={onToggleFavorite}
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
  );
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
