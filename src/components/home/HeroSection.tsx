'use client';

import { useReducer, useEffect, useRef } from 'react';
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
    // Pause at full text — trigger delete on next tick
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

// ─── TypingTagline Component ────────────────────────────────────────
function TypingTagline() {
  const displayText = useTypingEffect();
  return (
    <p className="text-sm text-muted-foreground/80 font-medium">
      {displayText}
      <span className="inline-block w-[2px] h-4 ml-0.5 bg-primary/70 animate-[blink_0.8s_step-end_infinite] align-middle" />
    </p>
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
        <div className="hero-gradient-blob hero-gradient-blob-1" />
        <div className="hero-gradient-blob hero-gradient-blob-2" />
      </div>
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
