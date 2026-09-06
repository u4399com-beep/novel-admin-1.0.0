'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, Search, History, Loader2, X, Flame } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';
import { hexToRgba } from '@/lib/color-utils';

// ─── Search History ─────────────────────────────────────────────────

const SEARCH_HISTORY_KEY = 'novel-search-history';
const MAX_SEARCH_HISTORY = 5;

function getSearchHistory(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
  } catch { return []; }
}

function addSearchHistory(term: string) {
  if (typeof window === 'undefined') return;
  try {
    const list = getSearchHistory().filter((t) => t !== term);
    list.unshift(term);
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, MAX_SEARCH_HISTORY)));
  } catch { /* ignore */ }
}

function clearSearchHistory() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SEARCH_HISTORY_KEY);
}

// ─── Highlight helpers ──────────────────────────────────────────────

function highlightText(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-primary/20 text-foreground rounded px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ─── Keyboard shortcut helpers ──────────────────────────────────────

function isMac(): boolean {
  if (typeof window === 'undefined') return false;
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
}

function getShortcutLabel(): string {
  return isMac() ? '⌘K' : 'Ctrl+K';
}

// ─── Component ──────────────────────────────────────────────────────

export interface SearchBarProps {
  search: string;
  onSearch: (term: string) => void;
}

// Animated placeholder cycling hook
const PLACEHOLDER_CYCLE = ['搜索小说名、作者...', '斗破苍穹', '诡秘之主', '凡人修仙传', '遮天', '庆余年'];

function useAnimatedPlaceholder(speed = 2000) {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const current = PLACEHOLDER_CYCLE[index];
    if (!isDeleting) {
      if (text.length < current.length) {
        const timer = setTimeout(() => setText(current.slice(0, text.length + 1)), 80);
        return () => clearTimeout(timer);
      }
      const timer = setTimeout(() => setIsDeleting(true), speed);
      return () => clearTimeout(timer);
    } else {
      if (text.length > 0) {
        const timer = setTimeout(() => setText(text.slice(0, -1)), 40);
        return () => clearTimeout(timer);
      }
      // When text is empty and deleting, move to next placeholder
      const timer = setTimeout(() => {
        setIsDeleting(false);
        setIndex((prev) => (prev + 1) % PLACEHOLDER_CYCLE.length);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [text, isDeleting, index, speed]);

  return text || '搜索小说名、作者...';
}

export function SearchBar({ search, onSearch }: SearchBarProps) {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [suggestions, setSuggestions] = useState<{ id: string; title: string; author: string; category: { name: string; color: string } | null }[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [trends, setTrends] = useState<{ keyword: string; count: number }[]>([]);
  const animatedPlaceholder = useAnimatedPlaceholder();

  // Load search history from localStorage on mount (avoid hydration mismatch)
  useEffect(() => {
    queueMicrotask(() => setSearchHistory(getSearchHistory()));
  }, []);

  // ─── Fetch trending searches ───────────────────────────────────
  useEffect(() => {
    const abortController = new AbortController();
    apiFetch<{ trends: { keyword: string; count: number }[] }>('/api/public/trending-searches', {
      silent: true,
      signal: abortController.signal,
    })
      .then((data) => setTrends(data.trends || []))
      .catch(() => {});
    return () => abortController.abort();
  }, []);
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ─── Focus the input ────────────────────────────────────────────
  const focusInput = useCallback(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // ─── Global keyboard shortcut: / or Ctrl+K / ⌘K ─────────────────
  useEffect(() => {
    function handleGlobalKeydown(e: KeyboardEvent) {
      // Ignore if user is already typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      if (e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key === 'k')) {
        e.preventDefault();
        focusInput();
      }
    }

    document.addEventListener('keydown', handleGlobalKeydown);
    return () => document.removeEventListener('keydown', handleGlobalKeydown);
  }, [focusInput]);

  // ─── Handlers ──────────────────────────────────────────────────
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchInput.trim();
    if (trimmed) addSearchHistory(trimmed);
    onSearch(trimmed);
    setSuggestionsOpen(false);
    setSearchHistory(getSearchHistory());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleClear = useCallback(() => {
    setSearchInput('');
    onSearch('');
    setSuggestions([]);
    setSuggestionsOpen(false);
    inputRef.current?.focus();
  }, [onSearch]);

  const handleHistoryClear = () => {
    clearSearchHistory();
    setSearchHistory([]);
  };

  const handleHistorySelect = (term: string) => {
    setSearchInput(term);
    onSearch(term);
    setSuggestionsOpen(false);
    addSearchHistory(term);
    setSearchHistory(getSearchHistory());
  };

  // ─── Search suggestions (debounced) ─────────────────────────────
  const query = searchInput.trim();
  const hasQuery = query.length >= 1;

  useEffect(() => {
    if (!hasQuery) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    let abortController: AbortController | undefined;
    debounceRef.current = setTimeout(async () => {
      abortController = new AbortController();
      setSuggestionsLoading(true);
      try {
        const data = await apiFetch<{ suggestions?: Array<{ id: string; title: string; author: string; category: { name: string; color: string } | null }> }>(`/api/public/search-suggestions?q=${encodeURIComponent(query)}`, {
          signal: abortController.signal,
        });
        setSuggestions(data.suggestions || []);
        setActiveSuggestion(-1);
        setSuggestionsOpen(true);
      } catch {
        // Network error — silently ignore for search suggestions
      } finally {
        if (!abortController.signal.aborted) setSuggestionsLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortController?.abort();
    };
  }, [hasQuery, query]);

  // ─── Close suggestions on outside click ─────────────────────────
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSuggestionsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // ─── Shortcut label (recompute on client) ─────────────────────────
  const [shortcutLabel, setShortcutLabel] = useState('⌘K');
  useEffect(() => { setShortcutLabel(getShortcutLabel()); }, []);

  return (
    <section className="border-b bg-muted/30 fade-in-up animate-fade-in-up">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
        <div className="flex items-center gap-3">
          <h1 className="sm:block text-xl font-bold tracking-tight shrink-0 text-glow-subtle sr-only sm:not-sr-only text-shadow-sm">
            小说搜索
          </h1>
          <div className="flex-1 max-w-full sm:max-w-2xl" ref={searchRef}>
            <form onSubmit={handleSearch} className="relative search-focus-ring rounded-lg border-glow glass-morphism stagger-children focus-within:ring-2 focus-within:ring-primary/30 focus-within:bg-background focus-within:shadow-sm transition-all duration-300">
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground z-10 transition-all duration-300 ${!searchInput ? 'animate-pulse opacity-60' : 'opacity-100'}`} />
              <Input
                ref={inputRef}
                type="text"
                placeholder={animatedPlaceholder}
                aria-label="搜索小说名、作者"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  if (!e.target.value.trim()) {
                    setSuggestions([]);
                    setSuggestionsOpen(false);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSuggestionsOpen(false);
                    setActiveSuggestion(-1);
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveSuggestion((prev) => Math.min(prev + 1, suggestions.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveSuggestion((prev) => Math.max(prev - 1, -1));
                  } else if (e.key === 'Enter' && activeSuggestion >= 0 && suggestions[activeSuggestion]) {
                    e.preventDefault();
                    router.push(`/novels/${suggestions[activeSuggestion].id}`);
                    setSuggestionsOpen(false);
                    setActiveSuggestion(-1);
                  }
                }}
                onFocus={() => {
                  if (query.length >= 1 && suggestions.length > 0) setSuggestionsOpen(true);
                  else if (query.length === 0 && (searchHistory.length > 0 || trends.length > 0)) setSuggestionsOpen(true);
                }}
                className="h-10 pl-10 pr-10 sm:pr-20 text-sm rounded-lg w-full"
              />
              {/* Clear button (visible when there's text) */}
              {searchInput.length > 0 && (
                <button
                  type="button"
                  onClick={handleClear}
                  className="absolute right-2 sm:right-16 top-1/2 -translate-y-1/2 h-6 w-6 flex items-center justify-center rounded-full text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors z-10 focus-ring-soft"
                  aria-label="清除搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              <Button
                type="submit"
                size="sm"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-8 px-3 rounded-md z-10 magnetic-hover hidden sm:inline-flex"
              >
                搜索
              </Button>
              {/* Keyboard shortcut hint */}
              {!searchInput && (
                <kbd className="absolute right-2 top-1/2 -translate-y-1/2 z-10 hidden sm:flex items-center h-6 px-2 rounded border bg-muted/60 text-[10px] font-mono text-muted-foreground/50 pointer-events-none select-none">
                  {shortcutLabel}
                </kbd>
              )}
            </form>

            {/* Suggestions Dropdown */}
            <AnimatePresence>
              {suggestionsOpen && (suggestionsLoading || suggestions.length > 0 || (query.length === 0 && (searchHistory.length > 0 || trends.length > 0))) && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border bg-popover shadow-lg overflow-hidden"
                >
                  {suggestionsLoading ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      搜索中...
                    </div>
                  ) : query.length === 0 ? (
                    <div className="py-1">
                      {searchHistory.length > 0 && (
                        <>
                          <div className="flex items-center justify-between px-4 py-1.5">
                            <span className="text-xs font-medium text-muted-foreground">搜索历史</span>
                            <button
                              onClick={handleHistoryClear}
                              className="text-xs text-muted-foreground hover:text-foreground transition-colors focus-ring-soft"
                              aria-label="清除搜索历史"
                            >
                              清除
                            </button>
                          </div>
                          {searchHistory.map((term) => (
                            <button
                              key={term}
                              className="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/70"
                              onClick={() => handleHistorySelect(term)}
                            >
                              <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="text-sm truncate">{term}</span>
                            </button>
                          ))}
                        </>
                      )}
                      {trends.length > 0 && (
                        <div className="px-4 py-2">
                          <p className="text-xs text-muted-foreground mb-2">热门搜索</p>
                          <div className="flex flex-wrap gap-1.5">
                            {trends.map((t, idx) => (
                              <button
                                key={t.keyword}
                                type="button"
                                className={`text-xs px-2 py-1 rounded-full border border-border hover:bg-primary/10 hover:text-primary hover:border-primary/30 transition-all duration-200 cursor-pointer hover:scale-105 ${idx < 3 ? 'font-medium border-amber-300/50 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-900/20' : ''}`}
                                onClick={() => {
                                  setSearchInput(t.keyword);
                                  onSearch(t.keyword);
                                  setSuggestionsOpen(false);
                                  addSearchHistory(t.keyword);
                                  setSearchHistory(getSearchHistory());
                                }}
                              >
                                {idx < 3 && <Flame className="h-2.5 w-2.5 inline-block mr-0.5 text-amber-500 dark:text-amber-400 -mt-0.5" />}
                                {t.keyword}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <ul role="listbox" className="max-h-80 overflow-y-auto py-1 scrollbar-thin">
                      {suggestions.map((item, idx) => (
                        <li
                          key={item.id}
                          role="option"
                          aria-selected={idx === activeSuggestion}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer ${idx === activeSuggestion ? 'bg-accent' : 'hover:bg-accent/70'}`}
                          onClick={() => {
                            router.push(`/novels/${item.id}`);
                            setSuggestionsOpen(false);
                            setActiveSuggestion(-1);
                          }}
                          onMouseEnter={() => setActiveSuggestion(idx)}
                        >
                          <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm leading-tight truncate">
                              {highlightText(item.title, query)}
                            </p>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              {highlightText(item.author, query)}
                            </p>
                          </div>
                          {item.category && (
                            <span
                              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full"
                              style={{
                                backgroundColor: hexToRgba(item.category.color, 0.09),
                                color: item.category.color,
                              }}
                            >
                              {item.category.name}
                            </span>
                          )}
                        </li>
                      ))}
                      {/* Keyboard hint footer */}
                      <li className="flex items-center gap-2 px-4 py-1.5 border-t mt-1 text-[10px] text-muted-foreground/60">
                        <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">↑↓</kbd> 导航
                        <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Enter</kbd> 选择
                        <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Esc</kbd> 关闭
                      </li>
                    </ul>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {search && (
            <Badge variant="secondary" className="shrink-0 text-xs">
              &quot;{search}&quot;
              <button
                onClick={() => { setSearchInput(''); onSearch(''); }}
                className="ml-1 hover:text-foreground focus-ring-soft"
                aria-label="清除搜索"
              >
                ×
              </button>
            </Badge>
          )}
          {/* Search history pills below search bar when idle */}
          {searchHistory.length > 0 && !searchInput && (
            <div className="hidden sm:flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-muted-foreground/40">最近:</span>
              {searchHistory.slice(0, 3).map((term) => (
                <button
                  key={term}
                  onClick={() => handleHistorySelect(term)}
                  className="text-[10px] px-1.5 py-0.5 rounded-full border border-border/40 text-muted-foreground/60 hover:text-foreground hover:border-border transition-colors"
                >
                  {term.length > 6 ? term.slice(0, 6) + '…' : term}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
