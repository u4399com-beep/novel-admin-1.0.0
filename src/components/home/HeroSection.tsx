'use client';

import { useReducer, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { SearchBar } from './hero/SearchBar';
import { FilterChips } from './hero/FilterChips';
import type { Category } from '@/types';

export type { Category } from '@/types';

// ─── Typing Animation Hook ─────────────────────────────────────────
const TYPING_MESSAGES = [
  '发现你的下一本好书',
  '万千小说, 尽在指尖',
  '沉浸式阅读体验',
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
          transition={{ duration: 0.8, repeat: Infinity, repeatType: 'reverse', ease: 'steps(2)' }}
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
  return (
    <div className="relative overflow-hidden">
      {/* Animated gradient border effect */}
      <div className="hero-gradient-border" aria-hidden="true" />
      {/* Subtle animated mesh gradient background */}
      <div className="absolute inset-0 pointer-events-none -z-10" aria-hidden="true">
        <div className="hero-gradient-blob hero-gradient-blob-1 hero-bg-animated" />
        <div className="hero-gradient-blob hero-gradient-blob-2 hero-bg-animated-2" />
      </div>
      {/* Dot pattern overlay */}
      <DotPattern />
      {/* Animated gradient behind the search bar area */}
      <div
        className="absolute inset-0 pointer-events-none -z-5 hero-search-gradient"
        aria-hidden="true"
      />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
        <TypingTagline />
      </div>
      <SearchBar search={search} onSearch={onSearch} />
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
