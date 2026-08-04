'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Eye, BookOpen, User, BookMarked, FileText } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { getCoverGradient, formatWordCount, getStatusInfo } from '@/components/home/shared-types';
import type { NovelCardData } from '@/components/home/shared-types';
import { HighlightText } from '@/components/home/NovelGrid';

const NovelCard = React.memo(function NovelCard({ novel, index, search }: { novel: NovelCardData; index: number; search: string }) {
  const gradient = getCoverGradient(novel.title);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isTouchDevice = useRef(false);

  useEffect(() => {
    const onTouch = () => { isTouchDevice.current = true; };
    window.addEventListener('touchstart', onTouch, { once: true });
    return () => window.removeEventListener('touchstart', onTouch);
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (isTouchDevice.current) return;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    enterTimer.current = setTimeout(() => setPopoverOpen(true), 400);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (isTouchDevice.current) return;
    if (enterTimer.current) clearTimeout(enterTimer.current);
    leaveTimer.current = setTimeout(() => setPopoverOpen(false), 200);
  }, []);

  const handlePopoverEnter = useCallback(() => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  const handlePopoverLeave = useCallback(() => {
    if (isTouchDevice.current) return;
    leaveTimer.current = setTimeout(() => setPopoverOpen(false), 150);
  }, []);

  const handleTouchToggle = useCallback((e: React.MouseEvent) => {
    if (!isTouchDevice.current) return;
    e.preventDefault();
    e.stopPropagation();
    setPopoverOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    return () => {
      if (enterTimer.current) clearTimeout(enterTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    };
  }, []);

  const statusInfo = getStatusInfo(novel.status);

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Link href={`/novels/${novel.id}`} className="block" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onClick={handleTouchToggle}>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: index * 0.04 }}
            className="group cursor-pointer shine-hover card-depth"
          >
            <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl shadow-md transition-all duration-300 ease-out group-hover:ring-1 group-hover:ring-primary/20 cover-zoom hover-lift cover-shine">
              {novel.coverUrl ? (
                <img src={novel.coverUrl} alt={novel.title} className="h-full w-full object-cover transition-all duration-500 group-hover:brightness-75 hover-brightness" loading="lazy" />
              ) : (
                <div className={`h-full w-full bg-gradient-to-br ${gradient} flex items-center justify-center transition-all duration-500 group-hover:brightness-110 hover-brightness`}>
                  <span className="text-4xl font-bold text-white/90 select-none">{novel.title.charAt(0)}</span>
                </div>
              )}
              {novel.category && (
                <div className="absolute top-2 left-2">
                  <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full font-medium backdrop-blur-sm" style={{ backgroundColor: `${novel.category.color}cc`, color: '#fff' }}>{novel.category.name}</span>
                </div>
              )}
              <div className="absolute top-2.5 right-2.5">
                <span className={`inline-block h-2 w-2 rounded-full ${statusInfo.dotClass} status-${novel.status}`} title={statusInfo.label} />
              </div>
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-all duration-300 opacity-0 group-hover:opacity-100">
                <span className="flex items-center gap-1.5 rounded-full bg-white/90 dark:bg-black/70 px-4 py-2 text-sm font-medium text-foreground backdrop-blur-sm shadow-lg translate-y-3 group-hover:translate-y-0 transition-transform duration-300">
                  <Eye className="h-4 w-4" /> 阅读
                </span>
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent p-3 pt-10">
                <p className="text-[11px] text-white/80 flex items-center gap-1">
                  <BookOpen className="h-3 w-3" /> {novel._count.chapters} 章 · {formatWordCount(novel.wordCount)}
                </p>
              </div>
            </div>
            <div className="mt-3 space-y-1 px-0.5 tab-content-enter">
              <h3 className="text-sm font-semibold leading-snug line-clamp-1 group-hover:text-primary transition-colors duration-200"><HighlightText text={novel.title} query={search} /></h3>
              {novel.description && <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-1">{novel.description}</p>}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="line-clamp-1"><HighlightText text={novel.author} query={search} /></span>
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                <span>{novel._count.chapters}章</span>
              </div>
            </div>
          </motion.div>
        </Link>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4" side="right" sideOffset={8} align="start" onMouseEnter={handlePopoverEnter} onMouseLeave={handlePopoverLeave} onOpenAutoFocus={(e) => e.preventDefault()}>
        <h4 className="font-bold text-sm leading-snug mb-1 line-clamp-1">{novel.title}</h4>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5 mb-2"><User className="h-3 w-3 shrink-0" /><span className="line-clamp-1">{novel.author}</span></p>
        {novel.description && <p className="text-xs text-muted-foreground/90 leading-relaxed line-clamp-3 mb-2 truncate-2">{novel.description}</p>}
        {novel.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {novel.tags.map(({ tag }) => (
              <span key={tag.id} className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${tag.color}20`, color: tag.color, border: `1px solid ${tag.color}40` }}>{tag.name}</span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 pt-2 border-t">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><BookMarked className="h-3 w-3" />{novel._count.chapters} 章</span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><FileText className="h-3 w-3" />{formatWordCount(novel.wordCount)}</span>
          <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusInfo.colorClass} status-${novel.status}`}>{statusInfo.label}</span>
        </div>
        <Link href={`/novels/${novel.id}`} className="mt-2 block w-full text-center text-xs font-medium text-primary hover:text-primary/80 hover:underline rounded-md py-1.5 bg-primary/5 hover:bg-primary/10 transition-colors">
          查看详情
        </Link>
      </PopoverContent>
    </Popover>
  );
});

export function NovelGridLayout({ novels, search }: { novels: NovelCardData[]; search?: string }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6 stagger-in">
      {novels.map((novel, i) => (
        <NovelCard key={novel.id} novel={novel} index={i} search={search ?? ''} />
      ))}
    </div>
  );
}
