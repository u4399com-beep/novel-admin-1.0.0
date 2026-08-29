'use client';

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { BookOpen, FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatWordCount, getStatusInfo } from '@/components/home/shared-types';
import { NovelCover } from '@/components/shared/NovelCover';
import type { NovelCardData } from '@/components/home/shared-types';
import { HighlightText } from '@/components/home/NovelGrid';

const NovelSiteItem = React.memo(function NovelSiteItem({
  novel,
  index,
  search,
}: {
  novel: NovelCardData;
  index: number;
  search: string;
}) {
  const statusInfo = getStatusInfo(novel.status);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.03, ease: 'easeOut' as const }}
    >
      <Link href={`/novels/${novel.id}`} className="block group">
        <div className="flex gap-4 rounded-md bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.12)] transition-all duration-200 hover:shadow-[0_2px_8px_rgba(0,0,0,0.15)]">
          {/* Cover image - left side */}
          <div className="relative h-[110px] w-[80px] shrink-0 overflow-hidden rounded shadow-sm">
            <NovelCover
              coverUrl={novel.coverUrl}
              title={novel.title}
              textClassName="text-2xl"
            />
          </div>

          {/* Info section - right side */}
          <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
            {/* Title */}
            <div>
              <h3 className="text-base font-semibold leading-snug line-clamp-1 group-hover:text-primary transition-colors duration-200">
                <HighlightText text={novel.title} query={search} />
              </h3>
              {/* Author + Category */}
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span className="hover:text-primary transition-colors">
                  <HighlightText text={novel.author} query={search} />
                </span>
                {novel.category && (
                  <>
                    <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded font-medium"
                      style={{
                        backgroundColor: `${novel.category.color}15`,
                        color: novel.category.color,
                      }}
                    >
                      {novel.category.name}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Description */}
            {novel.description && (
              <p className="text-[13px] text-muted-foreground leading-relaxed line-clamp-2 mt-1">
                {novel.description}
              </p>
            )}

            {/* Meta row: word count + status + chapters */}
            <div className="flex items-center gap-3 mt-1.5">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <FileText className="h-3 w-3" />
                {formatWordCount(novel.wordCount)}
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <BookOpen className="h-3 w-3" />
                {novel._count.chapters}章
              </span>
              <Badge
                variant="secondary"
                className={`text-[10px] px-1.5 py-0 h-5 rounded font-medium ${statusInfo.colorClass}`}
              >
                {statusInfo.label}
              </Badge>
            </div>
          </div>
        </div>
      </Link>
    </motion.div>
  );
});

export function NovelSiteLayout({
  novels,
  search,
}: {
  novels: NovelCardData[];
  search?: string;
}) {
  return (
    <div className="lg:flex lg:gap-6">
      {/* Main content area */}
      <div className="flex-1 min-w-0">
        {/* Section header */}
        <div className="mb-4 pb-1.5 border-b border-border/20">
          <h2 className="text-base font-semibold">小说列表</h2>
        </div>

        {/* Novel items in a card container */}
        <div className="bg-card rounded-md shadow-[0_1px_3px_rgba(0,0,0,0.08)] p-4">
          <div className="flex flex-col gap-0 divide-y divide-border/60">
            {novels.map((novel, i) => (
              <div
                key={novel.id}
                className={i > 0 ? 'pt-4 first:pt-0' : ''}
              >
                <NovelSiteItem
                  novel={novel}
                  index={i}
                  search={search ?? ''}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Sidebar placeholder - visible on lg+ */}
      <aside className="hidden lg:block w-[280px] shrink-0">
        <div className="sticky top-24 space-y-4">
          {/* Placeholder card 1 */}
          <div className="bg-card rounded-md shadow-[0_1px_3px_rgba(0,0,0,0.12)] p-4">
            <div className="mb-3 pb-1.5 border-b border-border/20">
              <h3 className="text-base font-semibold">热门推荐</h3>
            </div>
            <div className="space-y-3">
              {novels.slice(0, 5).map((novel, i) => (
                <Link
                  key={novel.id}
                  href={`/novels/${novel.id}`}
                  className="flex items-center gap-2 group"
                >
                  <span className="text-xs font-bold text-primary w-5 shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm text-foreground/80 line-clamp-1 group-hover:text-primary transition-colors">
                    {novel.title}
                  </span>
                </Link>
              ))}
            </div>
          </div>

          {/* Placeholder card 2 */}
          <div className="bg-card rounded-md shadow-[0_1px_3px_rgba(0,0,0,0.12)] p-4">
            <div className="mb-3 pb-1.5 border-b border-border/20">
              <h3 className="text-base font-semibold">最近更新</h3>
            </div>
            <div className="space-y-3">
              {novels.slice(0, 8).map((novel) => (
                <Link
                  key={novel.id}
                  href={`/novels/${novel.id}`}
                  className="flex items-center gap-2 group"
                >
                  <span className="text-sm text-foreground/80 line-clamp-1 group-hover:text-primary transition-colors">
                    {novel.title}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0 ml-auto">
                    {novel._count.chapters}章
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
