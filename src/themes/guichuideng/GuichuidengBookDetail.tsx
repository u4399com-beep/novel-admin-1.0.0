'use client';

import React from 'react';
import Link from 'next/link';
import { BookOpen, Download, List } from 'lucide-react';
import { NovelCover } from '@/components/shared/NovelCover';
import { formatWordCount } from '@/components/home/shared-types';
import type { Novel, Chapter } from '@/app/novels/[id]/reader/types';

interface GuichuidengBookDetailProps {
  novel: Novel;
  chapters: Chapter[];
  onStartReading: (chapterIndex: number) => void;
  onToggleFavorite?: () => void;
  isFavorite?: boolean;
}

export function GuichuidengBookDetail({
  novel,
  chapters,
  onStartReading,
  onToggleFavorite,
  isFavorite,
}: GuichuidengBookDetailProps) {
  const isCompleted = novel.status === 'completed';

  // Get latest 12 chapters for display
  const latestChapters = chapters.slice(-12).reverse();

  return (
    <div className="space-y-5">
      {/* ─── Book info card ──────────────────────────────────── */}
      <div className="border border-gray-200 rounded bg-white p-4">
        <div className="flex gap-5">
          {/* Cover */}
          <div className="shrink-0 relative w-[140px] h-[190px] sm:w-[160px] sm:h-[215px] overflow-hidden rounded shadow-md">
            <NovelCover
              coverUrl={novel.coverUrl}
              title={novel.title}
              textClassName="text-3xl"
            />
            {isCompleted && (
              <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[10px] font-bold rounded-sm bg-green-500 text-white">
                完结
              </span>
            )}
          </div>

          {/* Info panel */}
          <div className="flex-1 min-w-0 flex flex-col">
            <h1 className="text-xl font-bold text-gray-900 leading-tight">
              {novel.title}
            </h1>
            <div className="mt-3 space-y-2 text-sm text-gray-600">
              <p>
                <span className="text-gray-400">作者：</span>
                <span className="text-[#265d79] hover:text-[#c00] transition-colors">
                  {novel.author}
                </span>
              </p>
              <p>
                <span className="text-gray-400">分类：</span>
                <span>{novel.category?.name || '未分类'}</span>
              </p>
              <p>
                <span className="text-gray-400">状态：</span>
                <span className={isCompleted ? 'text-green-600' : 'text-orange-500'}>
                  {isCompleted ? '已完结' : '连载中'}
                </span>
              </p>
              <p>
                <span className="text-gray-400">字数：</span>
                <span>{formatWordCount(novel.wordCount)}</span>
              </p>
              <p>
                <span className="text-gray-400">章节：</span>
                <span>{novel._count.chapters}章</span>
              </p>
            </div>

            {/* Action buttons */}
            <div className="mt-auto pt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={() => onStartReading(0)}
                className="px-6 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium rounded transition-colors"
              >
                开始阅读
              </button>
              <button
                onClick={onToggleFavorite}
                className={`px-4 py-2 text-sm font-medium rounded border transition-colors ${
                  isFavorite
                    ? 'border-orange-400 text-orange-500 bg-orange-50 hover:bg-orange-100'
                    : 'border-gray-300 text-gray-600 hover:border-orange-300 hover:text-orange-500'
                }`}
              >
                {isFavorite ? '已在书架' : '加入书架'}
              </button>
              <Link
                href={`/novels/${novel.id}/export/txt`}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded border border-gray-300 text-gray-600 hover:border-orange-300 hover:text-orange-500 transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                TXT下载
              </Link>
            </div>
          </div>
        </div>

        {/* Description */}
        {novel.description && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <h2 className="text-sm font-semibold text-gray-800 mb-2">内容简介</h2>
            <p className="text-sm text-gray-600 leading-relaxed">
              {novel.description}
            </p>
          </div>
        )}
      </div>

      {/* ─── Latest chapters ─────────────────────────────────── */}
      <div className="border border-gray-200 rounded bg-white">
        <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
          <List className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-800">最新章节</h2>
        </div>
        <div className="p-3">
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-0">
            {latestChapters.map((chapter, i) => (
              <li key={chapter.id}>
                <button
                  onClick={() => onStartReading(chapters.length - latestChapters.length + i)}
                  className="flex items-center gap-1 w-full py-2 text-left text-sm text-[#265d79] hover:text-[#c00] transition-colors line-clamp-1"
                >
                  <span className="text-gray-300 text-xs shrink-0">{chapters.length - latestChapters.length + i + 1}.</span>
                  <span className="line-clamp-1">{chapter.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ─── All chapters ────────────────────────────────────── */}
      <div className="border border-gray-200 rounded bg-white">
        <div className="px-4 py-2.5 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-gray-800">
            全部章节 ({chapters.length})
          </h2>
        </div>
        <div className="p-3 max-h-[500px] overflow-y-auto custom-scrollbar">
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-0">
            {chapters.map((chapter, i) => (
              <li key={chapter.id}>
                <button
                  onClick={() => onStartReading(i)}
                  className="flex items-center gap-1 w-full py-1.5 text-left text-sm text-[#265d79] hover:text-[#c00] transition-colors line-clamp-1"
                >
                  <span className="text-gray-300 text-xs shrink-0">{i + 1}.</span>
                  <span className="line-clamp-1">{chapter.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ─── Tags ────────────────────────────────────────────── */}
      {novel.tags.length > 0 && (
        <div className="border border-gray-200 rounded bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-800 mb-2">标签</h2>
          <div className="flex flex-wrap gap-2">
            {novel.tags.map((t) => (
              <span
                key={t.id}
                className="px-2 py-0.5 text-xs rounded-full border border-gray-200 text-gray-600"
              >
                {t.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
