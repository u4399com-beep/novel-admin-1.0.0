'use client';

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { BookOpen, FileText, ArrowRight, Sparkles } from 'lucide-react';
import { getCoverGradient, formatWordCount, getStatusInfo } from '@/components/home/shared-types';
import type { NovelCardData } from '@/components/home/shared-types';

const HeroCard = React.memo(function HeroCard({ novel }: { novel: NovelCardData }) {
  const gradient = getCoverGradient(novel.title);
  const statusInfo = getStatusInfo(novel.status);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' as const }}
    >
      <Link href={`/novels/${novel.id}`} className="block group">
        <div className="relative overflow-hidden rounded-2xl bg-card border shadow-lg hover:shadow-xl transition-all duration-500">
          <div className="relative h-48 sm:h-64 md:h-72 overflow-hidden">
            {novel.coverUrl ? (
              <img src={novel.coverUrl} alt={novel.title} className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105" loading="lazy" />
            ) : (
              <div className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center transition-transform duration-700 group-hover:scale-105`} />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />
            <div className="absolute top-4 left-4">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/90 text-white text-xs font-semibold backdrop-blur-sm shadow-lg">
                <Sparkles className="h-3 w-3" />
                编辑推荐
              </span>
            </div>
            <div className="absolute top-4 right-4">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${statusInfo.dotClass}`} />
            </div>
            <div className="absolute bottom-0 left-0 right-0 p-5 sm:p-6">
              {novel.category && (
                <span className="inline-block text-[11px] px-2 py-0.5 rounded-full font-medium mb-2.5" style={{ backgroundColor: `${novel.category.color}dd`, color: '#fff' }}>
                  {novel.category.name}
                </span>
              )}
              <h2 className="text-xl sm:text-2xl md:text-3xl font-bold text-white leading-tight mb-2 line-clamp-2 drop-shadow-lg">{novel.title}</h2>
              <div className="flex items-center gap-3 text-white/80 text-xs sm:text-sm">
                <span>{novel.author}</span>
                <span className="h-1 w-1 rounded-full bg-white/40" />
                <span className="flex items-center gap-1"><BookOpen className="h-3 w-3" />{novel._count.chapters} 章</span>
                <span className="h-1 w-1 rounded-full bg-white/40" />
                <span className="flex items-center gap-1"><FileText className="h-3 w-3" />{formatWordCount(novel.wordCount)}</span>
              </div>
              {novel.description && (
                <p className="mt-2.5 text-sm text-white/70 line-clamp-2 leading-relaxed max-w-2xl">{novel.description}</p>
              )}
              <div className="mt-4 flex items-center gap-2 text-primary-foreground text-xs font-medium group-hover:gap-3 transition-all duration-300">
                <span>开始阅读</span>
                <ArrowRight className="h-3.5 w-3.5 group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </div>
        </div>
      </Link>
    </motion.div>
  );
});

const MagazineCard = React.memo(function MagazineCard({ novel, index }: { novel: NovelCardData; index: number }) {
  const gradient = getCoverGradient(novel.title);
  const statusInfo = getStatusInfo(novel.status);
  const isReversed = index % 2 === 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 + index * 0.06, ease: 'easeOut' as const }}
    >
      <Link href={`/novels/${novel.id}`} className="block group">
        <div className={`flex gap-4 rounded-xl border bg-card p-3 transition-all duration-300 hover:shadow-md hover:border-primary/20 card-accent-bottom ${isReversed ? 'flex-row-reverse' : ''}`}>
          <div className="relative h-28 w-20 sm:h-32 sm:w-24 shrink-0 overflow-hidden rounded-lg shadow-sm">
            {novel.coverUrl ? (
              <img src={novel.coverUrl} alt={novel.title} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110" loading="lazy" />
            ) : (
              <div className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center transition-transform duration-500 group-hover:scale-110`}>
                <span className="text-2xl font-bold text-white/90 select-none">{novel.title.charAt(0)}</span>
              </div>
            )}
            <div className="absolute top-1.5 right-1.5">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusInfo.dotClass}`} />
            </div>
          </div>
          <div className={`flex-1 min-w-0 flex flex-col justify-between py-0.5 ${isReversed ? 'items-end text-right' : ''}`}>
            <div>
              {novel.category && (
                <span className="inline-block text-[10px] px-1.5 py-0.5 rounded font-medium mb-1" style={{ backgroundColor: `${novel.category.color}15`, color: novel.category.color }}>
                  {novel.category.name}
                </span>
              )}
              <h3 className="text-sm font-bold leading-snug line-clamp-2 group-hover:text-primary transition-colors duration-200">{novel.title}</h3>
              <p className="text-xs text-muted-foreground mt-1">{novel.author}</p>
            </div>
            <div className={`flex items-center gap-2.5 text-[11px] text-muted-foreground mt-2 ${isReversed ? 'flex-row-reverse' : ''}`}>
              <span className="flex items-center gap-0.5"><BookOpen className="h-3 w-3" />{novel._count.chapters}章</span>
              <span className="flex items-center gap-0.5"><FileText className="h-3 w-3" />{formatWordCount(novel.wordCount)}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusInfo.colorClass}`}>{statusInfo.label}</span>
            </div>
          </div>
        </div>
      </Link>
    </motion.div>
  );
});

export function NovelMagazineLayout({ novels }: { novels: NovelCardData[] }) {
  const [featured, ...rest] = novels;
  if (!featured) return null;

  return (
    <div className="space-y-6">
      <HeroCard novel={featured} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {rest.map((novel, i) => (
          <MagazineCard key={novel.id} novel={novel} index={i} />
        ))}
      </div>
    </div>
  );
}
