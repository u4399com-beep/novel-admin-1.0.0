'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Eye, BookOpen, User, BookMarked, FileText, Sparkles, Heart } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatWordCount, getStatusInfo } from '@/components/home/shared-types';
import { NovelCover } from '@/components/shared/NovelCover';
import type { NovelCardData } from '@/components/home/shared-types';
import { HighlightText } from '@/components/home/NovelGrid';

// ─── Favorites (localStorage) ──────────────────────────────────
const FAVORITES_KEY = 'novel-favorites';

function getFavorites(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]'));
  } catch { return new Set(); }
}

function toggleFavorite(id: string, current: Set<string>): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
  return next;
}

// ─── Helpers ─────────────────────────────────────────────────────
function isNewNovel(createdAt: string): boolean {
  const now = Date.now();
  const created = new Date(createdAt).getTime();
  return (now - created) < 7 * 24 * 60 * 60 * 1000; // 7 days
}

// ─── NovelCard ───────────────────────────────────────────────────
const NovelCard = React.memo(function NovelCard({ novel, index, search }: { novel: NovelCardData; index: number; search: string }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [heartAnimating, setHeartAnimating] = useState(false);
  const [tiltStyle, setTiltStyle] = useState<React.CSSProperties>({});
  const enterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isTouchDevice = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    queueMicrotask(() => setFavorites(getFavorites()));
  }, []);

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

  const heartTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleFavorite = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFavorites((prev) => toggleFavorite(novel.id, prev));
    setHeartAnimating(true);
    if (heartTimer.current) clearTimeout(heartTimer.current);
    heartTimer.current = setTimeout(() => setHeartAnimating(false), 350);
  }, [novel.id]);

  useEffect(() => {
    return () => {
      if (enterTimer.current) clearTimeout(enterTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (heartTimer.current) clearTimeout(heartTimer.current);
    };
  }, []);

  // Tilt effect handlers
  const handleTiltMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (isTouchDevice.current) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setTiltStyle({ transform: `perspective(800px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg) scale(1.02)`, transition: 'transform 0.1s ease-out' });
  }, []);

  const handleTiltLeave = useCallback(() => {
    setTiltStyle({ transform: 'perspective(800px) rotateY(0deg) rotateX(0deg) scale(1)', transition: 'transform 0.4s ease-out' });
  }, []);

  const statusInfo = getStatusInfo(novel.status);
  const isFavorited = favorites.has(novel.id);

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Link href={`/novels/${novel.id}`} className="block" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onClick={handleTouchToggle}>
          <motion.div
            ref={cardRef}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: index * 0.04, type: 'spring', stiffness: 300, damping: 20 }}
            whileHover={{ y: -4 }}
            whileTap={{ scale: 0.98 }}
            onMouseMove={handleTiltMove}
            onMouseLeave={(e) => { handleTiltLeave(); handleMouseLeave(); }}
            style={tiltStyle}
            className="group cursor-pointer shine-hover card-depth novel-card-glow novel-card-load-anim hover:shadow-lg transition-shadow duration-300 ease-out glass-card"
          >
            <div className="relative aspect-[3/4] w-full overflow-hidden rounded-xl shadow-md transition-all duration-300 ease-out group-hover:ring-1 group-hover:ring-primary/20 cover-zoom hover-lift cover-shine">
              <NovelCover
                coverUrl={novel.coverUrl}
                title={novel.title}
                className="transition-all duration-500 group-hover:brightness-75 hover-brightness"
                gradientClassName="group-hover:brightness-110"
                textClassName="text-4xl"
              />
              {novel.category && (
                <div className="absolute top-2 left-2">
                  <span className="inline-block text-[10px] px-1.5 py-0.5 rounded-full font-medium backdrop-blur-sm animated-gradient-border" style={{ backgroundColor: `${novel.category.color}cc`, color: '#fff', boxShadow: `0 0 8px ${novel.category.color}40` }}>{novel.category.name}</span>
                </div>
              )}
              <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5">
                {isNewNovel(novel.createdAt) && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-500 text-white shadow-sm animate-fade-in-up">
                    <Sparkles className="h-2.5 w-2.5" />
                    NEW
                  </span>
                )}
                <span className={`inline-block h-2 w-2 rounded-full ${statusInfo.dotClass} status-${novel.status} badge-glow ${novel.status === 'ongoing' ? 'animate-pulse' : ''}`} title={statusInfo.label} />
              </div>
              {/* Quick-favorite heart button */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleFavorite}
                    className="absolute bottom-10 right-2 z-10 h-7 w-7 flex items-center justify-center rounded-full bg-black/40 backdrop-blur-sm text-white/70 hover:text-rose-400 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={isFavorited ? '取消收藏' : '收藏'}
                  >
                    <Heart
                      className={`h-3.5 w-3.5 ${isFavorited ? 'fill-rose-400 text-rose-400' : ''} ${heartAnimating ? 'heart-pop' : ''}`}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" className="text-xs">
                  {isFavorited ? '取消收藏' : '收藏'}
                </TooltipContent>
              </Tooltip>
              {/* Subtle gradient overlay on hover */}
              <div className="absolute inset-0 bg-gradient-to-t from-primary/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 ease-out pointer-events-none" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-all duration-300 opacity-0 group-hover:opacity-100">
                <span className="flex items-center gap-1.5 rounded-full bg-white/90 dark:bg-black/70 px-4 py-2 text-sm font-medium text-foreground backdrop-blur-sm shadow-lg translate-y-3 group-hover:translate-y-0 transition-transform duration-300">
                  <Eye className="h-4 w-4" /> 阅读
                </span>
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent p-3 pt-10">
                <p className="text-[11px] text-white/80 flex items-center gap-1">
                  <BookOpen className="h-3 w-3" /> {novel._count.chapters} 章
                </p>
                <div className="flex items-center justify-end mt-0.5">
                  <Badge
                    variant="secondary"
                    className="text-[9px] h-4 px-1.5 bg-white/15 text-white/80 border-0 backdrop-blur-sm hover:bg-white/20"
                  >
                    <FileText className="h-2.5 w-2.5 mr-0.5" />
                    {formatWordCount(novel.wordCount)}
                  </Badge>
                </div>
              </div>
            </div>
            <div className="mt-3 space-y-1 px-0.5 tab-content-enter">
              <h3 className="text-sm font-semibold leading-snug line-clamp-1 group-hover:text-primary transition-colors duration-200"><HighlightText text={novel.title} query={search} /></h3>
              {novel.description && <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-1">{novel.description}</p>}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="line-clamp-1"><HighlightText text={novel.author} query={search} /></span>
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                <span>{novel._count.chapters}章</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusInfo.colorClass} status-${novel.status} badge-glow`}>{statusInfo.label}</span>
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
          <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusInfo.colorClass} status-${novel.status} badge-glow`}>{statusInfo.label}</span>
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
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 sm:gap-6 stagger-in stagger-children">
      {novels.map((novel, i) => (
        <NovelCard key={novel.id} novel={novel} index={i} search={search ?? ''} />
      ))}
    </div>
  );
}
