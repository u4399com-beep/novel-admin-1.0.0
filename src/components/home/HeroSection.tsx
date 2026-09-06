'use client';

import { useReducer, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { SearchBar } from './hero/SearchBar';
import { FilterChips } from './hero/FilterChips';
import { BookOpen, Library, Flame } from 'lucide-react';
import type { Category } from '@/types';

export type { Category } from '@/types';

// ─── Typing Animation Hook ─────────────────────────────────────────
const TYPING_MESSAGES = [
  '发现你的下一本好书',
  '万千小说, 尽在指尖',
  '沉浸式阅读体验',
  '与百万读者共享精彩',
  '从第一页开始旅程',
];

type TypingState = { text: string; msgIndex: number; isDeleting: boolean };
type TypingAction = { type: 'tick' };

function typingReducer(state: TypingState, _action: TypingAction): TypingState {
  const { text, msgIndex, isDeleting } = state;
  const current = TYPING_MESSAGES[msgIndex];

  if (!isDeleting) {
    if (text.length < current.length) {
      return { ...state, text: current.slice(0, text.length + 1) };
    }
    return { ...state, isDeleting: true };
  } else {
    if (text.length > 0) {
      return { ...state, text: text.slice(0, -1) };
    }
    return { text: '', msgIndex: (msgIndex + 1) % TYPING_MESSAGES.length, isDeleting: false };
  }
}

function useTypingEffect(typingSpeed = 80, deleteSpeed = 50, pauseTime = 2000) {
  const [state, dispatch] = useReducer(typingReducer, { text: '', msgIndex: 0, isDeleting: false });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const current = TYPING_MESSAGES[state.msgIndex];
    const isDoneTyping = !state.isDeleting && state.text.length >= current.length;
    const speed = state.isDeleting ? deleteSpeed : typingSpeed;
    const delay = isDoneTyping ? pauseTime : speed;

    timeoutRef.current = setTimeout(() => dispatch({ type: 'tick' }), delay);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [state, typingSpeed, deleteSpeed, pauseTime]);

  return state.text;
}

// ─── Hot Search Tags ───────────────────────────────────────────────
const HOT_SEARCH_TAGS = [
  '斗破苍穹', '凡人修仙传', '诡秘之主', '遮天', '大奉打更人',
  '完美世界', '道诡异仙', '一念永恒', '仙逆', '庆余年',
];

// ─── Decorative Book SVG ────────────────────────────────────────
function BookIllustration() {
  return (
    <svg
      viewBox="0 0 80 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="h-10 w-10 sm:h-12 sm:w-12 text-primary/40"
      aria-hidden="true"
    >
      <motion.path
        d="M16 12C16 12 20 8 40 8C60 8 64 12 64 12V64C64 64 60 60 40 60C20 60 16 64 16 64V12Z"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.2, ease: 'easeInOut' }}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <motion.path
        d="M40 8V60"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8, delay: 0.4, ease: 'easeInOut' }}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <motion.path
        d="M22 20H36M22 28H36M22 36H32M44 20H58M44 28H58M44 36H52"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.8 }}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Small sparkle near the book */}
      <motion.circle
        cx="68"
        cy="16"
        r="2"
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 0.6 }}
        transition={{ duration: 0.4, delay: 1.2 }}
        fill="currentColor"
      />
      <motion.circle
        cx="12"
        cy="56"
        r="1.5"
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 0.4 }}
        transition={{ duration: 0.4, delay: 1.4 }}
        fill="currentColor"
      />
    </svg>
  );
}

// ─── Dot Pattern Background ─────────────────────────────────────
function DotPattern() {
  return (
    <div
      className="absolute inset-0 pointer-events-none -z-10 opacity-[0.03] dark:opacity-[0.05]"
      aria-hidden="true"
    >
      <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="hero-dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1" fill="currentColor" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#hero-dots)" />
      </svg>
    </div>
  );
}

// ─── Floating Particles Background ────────────────────────────
function FloatingParticles() {
  const particles = useMemo(() =>
    Array.from({ length: 18 }).map((_, i) => ({
      id: i,
      className: i % 3 === 0 ? 'hero-particle' : i % 3 === 1 ? 'hero-particle-2' : 'hero-particle-3',
      style: {
        left: `${(i * 17 + 5) % 100}%`,
        top: `${(i * 23 + 10) % 80 + 10}%`,
        animationDelay: `${i * 0.7}s`,
        animationDuration: `${6 + (i % 5)}s`,
      },
    })),
  []);

  return (
    <div className="absolute inset-0 pointer-events-none -z-10 overflow-hidden" aria-hidden="true">
      {particles.map((p) => (
        <div key={p.id} className={p.className} style={p.style} />
      ))}
    </div>
  );
}

// ─── Stats Bar with Icons ───────────────────────────────────────
function HeroStatsBar({ total, loadingNovels }: { total: number; loadingNovels: boolean }) {
  // Animate count when total changes (via key trick)
  return (
    <div className="flex items-center gap-4 sm:gap-6 justify-center py-2">
      <div className="flex items-center gap-1.5">
        <BookOpen className="h-3.5 w-3.5 text-primary/70 stat-icon-pop" />
        <span className="text-xs text-muted-foreground">共</span>
        <span key={total} className="text-xs font-semibold text-foreground tabular-nums stat-count-animate">
          {loadingNovels ? '–' : total.toLocaleString()}
        </span>
        <span className="text-xs text-muted-foreground">本小说</span>
      </div>
      <div className="h-3 w-px bg-border/50" />
      <div className="flex items-center gap-1.5">
        <Library className="h-3.5 w-3.5 text-primary/60" />
        <span className="text-xs text-muted-foreground">在线阅读</span>
      </div>
      <div className="h-3 w-px bg-border/50" />
      <div className="flex items-center gap-1.5">
        <Flame className="h-3.5 w-3.5 text-amber-500/70" />
        <span className="text-xs text-muted-foreground">每日更新</span>
      </div>
    </div>
  );
}

// ─── TypingTagline Component ────────────────────────────────────────
function TypingTagline() {
  const displayText = useTypingEffect();
  return (
    <div className="flex items-center gap-3">
      <BookIllustration />
      <motion.p
        className="text-sm sm:text-base text-muted-foreground/80 font-medium min-h-[1.5rem]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
      >
        {displayText}
        <motion.span
          className="inline-block w-[2px] h-4 ml-0.5 bg-primary/70 align-middle"
          animate={{ opacity: [1, 0] }}
          transition={{ duration: 0.8, repeat: Infinity, repeatType: 'reverse' as const }}
        />
      </motion.p>
    </div>
  );
}

export interface HeroSectionProps {
  search: string;
  onSearch: (term: string) => void;
  categories: Category[];
  loadingCategories: boolean;
  loadingNovels: boolean;
  activeCategorySlug: string;
  activeStatus: string;
  activeWordCount: string;
  activeSort: string;
  onCategoryChange: (slug: string) => void;
  onStatusChange: (status: string) => void;
  onWordCountChange: (wc: string) => void;
  onSortChange: (sort: string) => void;
  hasActiveFilter: boolean;
  resetAllFilters: () => void;
  total: number;
  filterSummary: string;
}

export function HeroSection({
  search,
  onSearch,
  categories,
  loadingCategories,
  loadingNovels,
  activeCategorySlug,
  activeStatus,
  activeWordCount,
  activeSort,
  onCategoryChange,
  onStatusChange,
  onWordCountChange,
  onSortChange,
  hasActiveFilter,
  resetAllFilters,
  total,
  filterSummary,
}: HeroSectionProps) {
  // Parallax scroll offset for background
  const [scrollY, setScrollY] = useState(0);
  useEffect(() => {
    let ticking = false;
    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        setScrollY(window.scrollY);
        ticking = false;
      });
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className="relative overflow-hidden">
      {/* Animated gradient border effect */}
      <div className="hero-gradient-border" aria-hidden="true" />
      {/* Parallax gradient blobs - move at 0.3x scroll speed */}
      <div
        className="absolute inset-0 pointer-events-none -z-10"
        style={{ transform: `translateY(${scrollY * 0.15}px)` }}
        aria-hidden="true"
      >
        <div className="hero-gradient-blob hero-gradient-blob-1 hero-bg-animated" />
        <div className="hero-gradient-blob hero-gradient-blob-2 hero-bg-animated-2" />
        {/* Third blob for richer gradient depth */}
        <div className="hero-gradient-blob hero-gradient-blob-3 hero-bg-animated-3" />
      </div>
      {/* Dot pattern overlay - parallax at 0.1x */}
      <div style={{ transform: `translateY(${scrollY * 0.05}px)` }} aria-hidden="true">
        <DotPattern />
      </div>
      {/* Multi-stop gradient overlay for sophisticated depth */}
      <div
        className="absolute inset-0 pointer-events-none -z-5"
        aria-hidden="true"
      >
        <div className="hero-search-gradient" />
        <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-transparent to-background/30" />
      </div>
      {/* Floating particles */}
      <FloatingParticles />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
        <TypingTagline />
      </div>
      <SearchBar search={search} onSearch={onSearch} />
      {/* Stats bar with icons */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <HeroStatsBar total={total} loadingNovels={loadingNovels} />
      </div>
      {/* Hot search tag cloud */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-3 pt-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-muted-foreground/50 shrink-0">热门:</span>
          {HOT_SEARCH_TAGS.map((tag, i) => (
            <motion.button
              key={tag}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: i * 0.03, duration: 0.2 }}
              onClick={() => onSearch(tag)}
              className="text-[11px] px-2.5 py-0.5 rounded-full border border-border/60 bg-muted/30 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-all duration-200 cursor-pointer hover:scale-105 active:scale-95"
            >
              {tag}
            </motion.button>
          ))}
        </div>
      </div>
      <FilterChips
        categories={categories}
        loadingCategories={loadingCategories}
        loadingNovels={loadingNovels}
        activeCategorySlug={activeCategorySlug}
        activeStatus={activeStatus}
        activeWordCount={activeWordCount}
        activeSort={activeSort}
        onCategoryChange={onCategoryChange}
        onStatusChange={onStatusChange}
        onWordCountChange={onWordCountChange}
        onSortChange={onSortChange}
        hasActiveFilter={hasActiveFilter}
        resetAllFilters={resetAllFilters}
        total={total}
        filterSummary={filterSummary}
      />
    </div>
  );
}
