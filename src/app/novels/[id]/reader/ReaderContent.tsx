'use client';

import { type ReactNode, type RefObject, useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, RotateCcw, StickyNote, Volume2, VolumeX, Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReadingTheme } from '@/lib/use-reading-settings';
import { useTheme } from 'next-themes';

// ─── Text-to-Speech Hook (Web Speech API) ──────────────────────
function useTextToSpeech() {
  const [speaking, setSpeaking] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const speak = useCallback((text: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const cleaned = text.replace(/\s+/g, ' ').slice(0, 5000);
    const utterance = new SpeechSynthesisUtterance(cleaned);
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }, []);

  const stop = useCallback(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  return { speaking, speak, stop };
}

// ─── Highlight Color Picker ──────────────────────────────────
const HIGHLIGHT_COLORS = [
  { key: 'yellow', label: '黄色', className: 'highlight-yellow' },
  { key: 'green', label: '绿色', className: 'highlight-green' },
  { key: 'blue', label: '蓝色', className: 'highlight-blue' },
  { key: 'pink', label: '粉色', className: 'highlight-pink' },
  { key: 'orange', label: '橙色', className: 'highlight-orange' },
] as const;
type HighlightColorKey = typeof HIGHLIGHT_COLORS[number]['key'];

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
  chapterDirection: 'forward' | 'backward' | null;
  currentTheme: ReadingTheme;
  currentFontCss: string;
  fontSize: number;
  lineHeight: number;
  searchOpen: boolean;
  searchQuery: string;
  currentMatch: number;
  onRetry: () => void;
  onQuickNote?: (text: string) => void;
  onSmoothScrollToTop?: () => void;
}

export function ReaderContent({
  contentRef,
  loading,
  error,
  content,
  chapterTitle,
  chapterDirection,
  currentTheme,
  currentFontCss,
  fontSize,
  lineHeight,
  searchOpen,
  searchQuery,
  currentMatch,
  onRetry,
  onQuickNote,
  onSmoothScrollToTop,
}: ReaderContentProps) {
  // ─── TTS & Highlight state ─────────────────────────────────
  const { speaking, speak, stop: stopTts } = useTextToSpeech();
  const [highlightColor, setHighlightColor] = useState<HighlightColorKey>('yellow');
  const [showHighlightPicker, setShowHighlightPicker] = useState(false);

  // ─── Text selection → quick note feature ────────────────────
  const [selectionTooltip, setSelectionTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleMouseUp = useCallback(() => {
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    selectionTimer.current = setTimeout(() => {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 2 && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        setSelectionTooltip({
          text: sel.toString().trim(),
          x: rect.left + rect.width / 2,
          y: rect.top - 8,
        });
      } else {
        setSelectionTooltip(null);
      }
    }, 200);
  }, []);

  const handleQuickNote = useCallback(() => {
    if (selectionTooltip && onQuickNote) {
      onQuickNote(selectionTooltip.text);
      setSelectionTooltip(null);
      window.getSelection()?.removeAllRanges();
    }
  }, [selectionTooltip, onQuickNote]);

  useEffect(() => {
    return () => {
      if (selectionTimer.current) clearTimeout(selectionTimer.current);
    };
  }, []);

  const chapterAnimClass = chapterDirection === 'forward'
    ? 'chapter-transition-forward tab-content-enter'
    : chapterDirection === 'backward'
    ? 'chapter-transition-backward tab-content-enter'
    : '';
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const isSepia = currentTheme.key === 'sepia';
  const themeBgStyle = isDark ? currentTheme.bgStyleDark : currentTheme.bgStyle;
  const themeTextStyle = isDark ? currentTheme.textStyleDark : currentTheme.textStyle;

  return (
    <div ref={contentRef} className={`flex-1 overflow-y-auto reader-content-area scroll-smooth ${isSepia ? 'reader-sepia-warm' : ''}`}>
      <div
        className={`px-6 py-6 sm:px-10 sm:py-8 ${currentTheme.bg} min-h-full transition-all duration-500 ease-in-out ${chapterAnimClass}`}
        style={themeBgStyle}
        onMouseUp={handleMouseUp}
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
          <div className="mx-auto max-w-3xl relative">
            {/* TTS & Highlight toolbar */}
            <div className="flex items-center gap-1 mb-4">
              <Button
                variant="ghost"
                size="sm"
                className={`h-7 px-2 text-[11px] gap-1 ${speaking ? 'tts-active-indicator text-primary' : ''}`}
                onClick={() => {
                  if (speaking) { stopTts(); } else if (content) { speak(content.replace(/\n/g, '。')); }
                }}
                aria-label={speaking ? '停止朗读' : '朗读本章'}
              >
                {speaking ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                {speaking ? '停止' : '朗读'}
              </Button>
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px] gap-1"
                  onClick={() => setShowHighlightPicker((p) => !p)}
                  aria-label="选择高亮颜色"
                >
                  <Palette className="h-3.5 w-3.5" />
                  高亮
                </Button>
                {showHighlightPicker && (
                  <div className="absolute top-full left-0 mt-1 z-50 glass rounded-lg p-2 flex gap-1.5 shadow-lg share-panel-enter">
                    {HIGHLIGHT_COLORS.map((c) => (
                      <button
                        key={c.key}
                        className={`w-5 h-5 rounded-full border-2 transition-all ${c.className} ${highlightColor === c.key ? 'ring-2 ring-foreground scale-110' : 'hover:scale-105'}`}
                        onClick={() => { setHighlightColor(c.key); setShowHighlightPicker(false); }}
                        title={c.label}
                        aria-label={`选择${c.label}高亮`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* Quick note tooltip on text selection */}
            {selectionTooltip && (
              <div
                className="fixed z-50 flex items-center gap-1 px-2 py-1 rounded-md bg-popover border shadow-lg text-xs"
                style={{ left: selectionTooltip.x, top: selectionTooltip.y, transform: 'translate(-50%, -100%)' }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] gap-1"
                  onClick={handleQuickNote}
                >
                  <StickyNote className="h-3 w-3" />
                  添加笔记
                </Button>
              </div>
            )}
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
