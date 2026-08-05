'use client';

import { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';

export interface ReaderSearchBarProps {
  visible: boolean;
  searchQuery: string;
  matchCount: number;
  currentMatch: number;
  onSearchQueryChange: (query: string) => void;
  onCurrentMatchChange: (match: number | ((prev: number) => number)) => void;
  onClose: () => void;
}

export function ReaderSearchBar({
  visible,
  searchQuery,
  matchCount,
  currentMatch,
  onSearchQueryChange,
  onCurrentMatchChange,
  onClose,
}: ReaderSearchBarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus search input when opened
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [visible]);

  const handleSearchPrev = () => {
    onCurrentMatchChange((p) => (matchCount > 0 ? (p - 1 + matchCount) % matchCount : 0));
  };

  const handleSearchNext = () => {
    onCurrentMatchChange((p) => (matchCount > 0 ? (p + 1) % matchCount : 0));
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.15 }}
          className="shrink-0 px-3 py-2"
        >
          <div className="glass-card flex items-center gap-2 rounded-lg border px-3 py-1.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => { onSearchQueryChange(e.target.value); onCurrentMatchChange(0); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } if (e.key === 'Enter') { e.preventDefault(); handleSearchNext(); } }}
              placeholder="搜索本章内容..."
              aria-label="搜索本章内容"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:outline-none rounded"
            />
            {searchQuery.trim() && (
              <>
                <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
                  {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '无结果'}
                </span>
                <button
                  onClick={handleSearchPrev}
                  disabled={matchCount === 0}
                  className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/80 disabled:opacity-30 transition-colors"
                  aria-label="上一个匹配"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={handleSearchNext}
                  disabled={matchCount === 0}
                  className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/80 disabled:opacity-30 transition-colors"
                  aria-label="下一个匹配"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted/80 text-muted-foreground/60 hover:text-foreground transition-colors"
              aria-label="关闭搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}