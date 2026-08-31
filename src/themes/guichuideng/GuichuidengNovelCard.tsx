'use client';

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { FileText, BookOpen } from 'lucide-react';
import { NovelCover } from '@/components/shared/NovelCover';
import { formatWordCount, getStatusInfo } from '@/components/home/shared-types';
import { HighlightText } from '@/components/home/NovelGrid';
import type { NovelCardData } from '@/components/home/shared-types';

// ─── Single Novel Card (guichuideng style: cover left, info right) ─────

const GuichuidengItem = React.memo(function GuichuidengItem({
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
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.02, ease: 'easeOut' as const }}
    >
      <div className="flex gap-3 py-4 border-b border-gray-100 last:border-b-0 group">
        {/* Cover image */}
        <div className="shrink-0 relative h-[120px] w-[88px] overflow-hidden rounded shadow-sm">
          <Link href={`/novels/${novel.id}`} className="block">
            <NovelCover
              coverUrl={novel.coverUrl}
              title={novel.title}
              textClassName="text-2xl"
            />
          </Link>
        </div>

        {/* Info panel */}
        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
          {/* Title + Author row */
          <div className="flex items-baseline gap-2 flex-wrap">
            <Link
              href={`/novels/${novel.id}`}
              className="text-base font-medium text-[#265d79] hover:text-[#c00] transition-colors line-clamp-1"
            >
              <HighlightText text={novel.title} query={search} />
            </Link>
            <span className="text-sm text-gray-500 shrink-0">
              /&nbsp;
              <span className="hover:text-[#c00] transition-colors">
                <HighlightText text={novel.author} query={search} />
              </span>
            </span>
            {novel.status === 'completed' && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-sm bg-green-100 text-green-700 shrink-0">
                已完结
              </span>
            )}
          </div>

          {/* Description */
          {novel.description && (
            <div className="mt-1">
              <Link
                href={`/novels/${novel.id}`}
                className="text-sm text-gray-600 leading-relaxed line-clamp-2 hover:text-gray-900 transition-colors"
              >
                {novel.description}
              </Link>
            </div>
          )}

          {/* Meta info */}
          <div className="mt-1.5 flex items-center gap-3 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3" />
              {formatWordCount(novel.wordCount)}
            </span>
            <span className="flex items-center gap-1">
              <BookOpen className="h-3 w-3" />
              {novel._count.chapters}章
            </span>
            {novel.category && (
              <span className="text-[11px]" style={{ color: novel.category.color }}>
                {novel.category.name}
              </span>
            )}
            {novel.status !== 'completed' && (
              <span className={`text-[10px] ${statusInfo.colorClass}`}>
                {statusInfo.label}
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
});

// ─── Full Layout with sidebar ──────────────────────────────────

export function GuichuidengNovelCard({
  novels,
  search,
}: {
  novels: NovelCardData[];
  search?: string;
}) {
  return (
    <div className="lg:flex lg:gap-5">
      {/* Main list */}
      <div className="flex-1 min-w-0">
        <div className="border border-gray-200 rounded bg-white p-3">
          {novels.map((novel, i) => (
            <GuichuidengItem
              key={novel.id}
              novel={novel}
              index={i}
              search={search ?? ''}
            />
          ))}
        </div>
      </div>

      {/* Sidebar (desktop only) */}
      <aside className="hidden lg:block w-[250px] shrink-0">
        <div className="sticky top-[52px] space-y-4">
          <div className="border border-gray-200 rounded bg-white">
            <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50">
              <h3 className="text-sm font-semibold text-gray-800">热门推荐</h3>
            </div>
            <div className="p-3 space-y-2.5">
              {novels.slice(0, 6).map((novel, i) => (
                <Link
                  key={novel.id}
                  href={`/novels/${novel.id}`}
                  className="flex items-center gap-2 group"
                >
                  <span className="text-xs font-bold text-orange-500 w-4 shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm text-gray-600 line-clamp-1 group-hover:text-[#c00] transition-colors">
                    {novel.title}
                  </span>
                </Link>
              ))}
            </div>
          </div>
          <div className="border border-gray-200 rounded bg-white">
            <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50">
              <h3 className="text-sm font-semibold text-gray-800">最近更新</h3>
            </div>
            <div className="p-3 space-y-2.5">
              {novels.slice(0, 8).map((novel) => (
                <Link
                  key={novel.id}
                  href={`/novels/${novel.id}`}
                  className="flex items-center justify-between gap-2 group"
                >
                  <span className="text-sm text-gray-600 line-clamp-1 group-hover:text-[#c00] transition-colors">
                    {novel.title}
                  </span>
                  <span className="text-[10px] text-gray-400 shrink-0">
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
