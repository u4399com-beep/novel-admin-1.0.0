'use client';

import { type ReactNode, type RefObject } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReadingTheme } from '@/lib/use-reading-settings';
import { useTheme } from 'next-themes';

// ─── Highlight helper ──────────────────────────────────────────
function highlightText(text: string, query: string, activeIndex: number): ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  let matchCount = 0;
  return parts.map((part, i) => {
    if (regex.test(part)) {
      regex.lastIndex = 0; // reset for next test
      const idx = matchCount++;
      const isActive = idx === activeIndex;
      return (
        <mark
          key={i}
          className={`rounded-sm px-0.5 ${isActive ? 'bg-amber-400/70 dark:bg-amber-500/60 ring-2 ring-amber-400/50' : 'bg-amber-200/70 dark:bg-amber-500/25'}`}
          data-match-index={idx}
        >
          {part}
        </mark>
      );
    }
    regex.lastIndex = 0;
    return part;
  });
}

export interface ReaderContentProps {
  contentRef: RefObject<HTMLDivElement | null>;
  loading: boolean;
  error: boolean;
  content: string | null;
  chapterTitle: string;
  currentTheme: ReadingTheme;
  currentFontCss: string;
  fontSize: number;
  lineHeight: number;
  searchOpen: boolean;
  searchQuery: string;
  currentMatch: number;
  onRetry: () => void;
}

export function ReaderContent({
  contentRef,
  loading,
  error,
  content,
  chapterTitle,
  currentTheme,
  currentFontCss,
  fontSize,
  lineHeight,
  searchOpen,
  searchQuery,
  currentMatch,
  onRetry,
}: ReaderContentProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const isSepia = currentTheme.key === 'sepia';
  const themeBgStyle = isDark ? currentTheme.bgStyleDark : currentTheme.bgStyle;
  const themeTextStyle = isDark ? currentTheme.textStyleDark : currentTheme.textStyle;

  return (
    <div ref={contentRef} className={`flex-1 overflow-y-auto reader-content-area scroll-smooth ${isSepia ? 'reader-sepia-warm' : ''}`}>
      <div
        className={`px-6 py-6 sm:px-10 sm:py-8 ${currentTheme.bg} min-h-full transition-all duration-500 ease-in-out page-turn-enter`}
        style={themeBgStyle}
      >
        {loading ? (
          <div className="flex items-center justify-center py-20 gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/70 reader-loading-spinner" />
            <span className="ml-3 text-sm text-muted-foreground">加载中...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <p className="text-sm text-muted-foreground">加载章节内容失败</p>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={onRetry}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重试
            </Button>
          </div>
        ) : content ? (
          <div className="mx-auto max-w-3xl">
            <h3
              className={`text-lg font-semibold mb-6 pb-4 text-center tracking-tight ${currentTheme.text} transition-all duration-500 ease-in-out`}
              style={themeTextStyle}
            >
              {chapterTitle}
            </h3>
            <hr className="reader-chapter-divider" />
            <article
              className={`whitespace-pre-wrap transition-all duration-500 ease-in-out reader-optimal-typography ${currentTheme.text} ${currentFontCss}`}
              style={{
                fontSize: `${fontSize}px`,
                lineHeight: lineHeight || 1.8,
                letterSpacing: '0.01em',
                ...themeTextStyle,
              }}
            >
              {(() => {
                const isSearching = searchOpen && searchQuery.trim();
                let runningMatches = 0;
                return content.split('\n').map((paragraph, i) => {
                  const text = paragraph.trim() || '\u00A0';
                  const matchOffset = runningMatches;
                  if (isSearching && paragraph.trim()) {
                    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
                    const matches = paragraph.match(new RegExp(escaped, 'gi'));
                    runningMatches += matches ? matches.length : 0;
                  }
                  return (
                    <p
                      key={i}
                      className={paragraph.trim() ? 'text-indent-[2em] mb-0' : 'h-4'}
                    >
                      {isSearching && paragraph.trim()
                        ? highlightText(text, searchQuery, currentMatch - matchOffset)
                        : text}
                    </p>
                  );
                });
              })()}
            </article>
          </div>
        ) : null}
      </div>
    </div>
  );
}
