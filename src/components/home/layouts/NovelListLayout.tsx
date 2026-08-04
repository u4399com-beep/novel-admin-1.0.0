'use client';

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { BookOpen, FileText, ArrowRight } from 'lucide-react';
import { getCoverGradient, formatWordCount, getStatusInfo } from '@/components/home/shared-types';
import type { NovelCardData } from '@/components/home/shared-types';

const NovelListItem = React.memo(function NovelListItem({ novel, index }: { novel: NovelCardData; index: number }) {
  const gradient = getCoverGradient(novel.title);
  const statusInfo = getStatusInfo(novel.status);

  return (
    <motion.div
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: index * 0.03, ease: 'easeOut' as const }}
    >
      <Link href={`/novels/${novel.id}`} className="block group">
        <div className="flex items-center gap-4 rounded-lg border bg-card p-3 sm:p-4 transition-all duration-200 hover:shadow-sm hover:border-primary/15 hover:bg-accent/30">
          {/* Rank number */}
          <span className="hidden sm:flex w-6 shrink-0 items-center justify-center text-sm font-bold text-muted-foreground/40 tabular-nums">
            {index + 1}
          </span>

          {/* Cover - square thumbnail */}
          <div className="relative h-16 w-12 sm:h-20 sm:w-[60px] shrink-0 overflow-hidden rounded-md shadow-sm transition-transform duration-300 group-hover:scale-105">
            {novel.coverUrl ? (
              <img src={novel.coverUrl} alt={novel.title} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <div className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center`}>
                <span className="text-lg font-bold text-white/90 select-none">{novel.title.charAt(0)}</span>
              </div>
            )}
          </div>

          {/* Info section */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold leading-snug line-clamp-1 group-hover:text-primary transition-colors duration-200">
                  {novel.title}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">{novel.author}</p>
              </div>
              <span className={`inline-flex items-center shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusInfo.colorClass}`}>
                {statusInfo.label}
              </span>
            </div>
            {novel.description && (
              <p className="text-xs text-muted-foreground/70 mt-1 line-clamp-1 hidden sm:block">
                {novel.description}
              </p>
            )}
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-0.5"><BookOpen className="h-3 w-3" />{novel._count.chapters}章</span>
              <span className="flex items-center gap-0.5"><FileText className="h-3 w-3" />{formatWordCount(novel.wordCount)}</span>
              {novel.category && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{ backgroundColor: `${novel.category.color}12`, color: novel.category.color }}
                >
                  {novel.category.name}
                </span>
              )}
              {novel.tags.length > 0 && (
                <div className="hidden md:flex items-center gap-1">
                  {novel.tags.slice(0, 3).map(({ tag }) => (
                    <span key={tag.id} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${tag.color}15`, color: tag.color }}>
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Arrow */}
          <ArrowRight className="h-4 w-4 text-muted-foreground/30 shrink-0 group-hover:text-primary group-hover:translate-x-0.5 transition-all duration-200" />
        </div>
      </Link>
    </motion.div>
  );
});

export function NovelListLayout({ novels }: { novels: NovelCardData[] }) {
  return (
    <div className="flex flex-col gap-2.5 sm:gap-3">
      {novels.map((novel, i) => (
        <NovelListItem key={novel.id} novel={novel} index={i} />
      ))}
    </div>
  );
}
