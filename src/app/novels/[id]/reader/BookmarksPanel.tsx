'use client';

import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookmarkCheck, X, Search, Download, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BookmarkEntry, Chapter } from './types';

// ─── Bookmark category colors ────────────────────────────────
const BOOKMARK_CATEGORIES = [
  { key: 'default', label: '默认', color: '#f59e0b' },
  { key: 'important', label: '重要', color: '#ef4444' },
  { key: 'review', label: '待回看', color: '#3b82f6' },
  { key: 'favorite', label: '喜爱', color: '#10b981' },
] as const;

type BookmarkCategoryKey = typeof BOOKMARK_CATEGORIES[number]['key'];

// Extend BookmarkEntry with optional category
interface EnhancedBookmarkEntry extends BookmarkEntry {
  category?: BookmarkCategoryKey;
}

export interface BookmarksPanelProps {
  visible: boolean;
  bookmarks: BookmarkEntry[];
  chapters: Chapter[];
  currentIndex: number;
  onLoadChapter: (index: number) => void;
  onSaveProgress: (chapterIndex: number) => void;
  onRemoveBookmark: (chapterIndex: number) => void;
  onClearAllBookmarks: () => void;
}

export function BookmarksPanel({
  visible,
  bookmarks,
  chapters,
  currentIndex,
  onLoadChapter,
  onSaveProgress,
  onRemoveBookmark,
  onClearAllBookmarks,
}: BookmarksPanelProps) {
  // ─── Search/filter state ──────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<BookmarkCategoryKey | 'all'>('all');

  // Filter bookmarks
  const filteredBookmarks = useMemo(() => {
    let result = bookmarks;
    if (activeCategory !== 'all') {
      result = result.filter((bm) => (bm as EnhancedBookmarkEntry).category === activeCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((bm) => bm.chapterTitle.toLowerCase().includes(q));
    }
    return result;
  }, [bookmarks, activeCategory, searchQuery]);
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 200, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="shrink-0 border-l overflow-hidden"
        >
          <div className="w-[200px] h-full overflow-y-auto p-3 flex flex-col scrollbar-thin">
            {/* Header */}
            <div className="flex items-center justify-between mb-2 px-1">
              <div className="text-xs font-medium text-muted-foreground">
                书签 ({bookmarks.length})
              </div>
              <div className="flex items-center gap-1">
                {bookmarks.length > 0 && (
                  <button
                    className="text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
                    onClick={onClearAllBookmarks}
                    title="清空所有书签"
                  >
                    清空
                  </button>
                )}
              </div>
            </div>

            {/* Search */}
            {bookmarks.length > 3 && (
              <div className="mb-2 px-1">
                <div className="relative">
                  <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索书签..."
                    className="w-full h-6 pl-6 pr-2 text-[11px] rounded-md border border-border/60 bg-muted/30 placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
              </div>
            )}

            {/* Category filter chips */}
            {bookmarks.length > 0 && (
              <div className="flex items-center gap-1 mb-2 px-1 flex-wrap">
                <button
                  onClick={() => setActiveCategory('all')}
                  className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${activeCategory === 'all' ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border/40 text-muted-foreground/60 hover:text-foreground'}`}
                >
                  全部
                </button>
                {BOOKMARK_CATEGORIES.map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => setActiveCategory(cat.key)}
                    className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors flex items-center gap-0.5 ${activeCategory === cat.key ? 'border-current bg-current/10' : 'border-border/40 text-muted-foreground/60 hover:text-foreground'}`}
                    style={{ color: activeCategory === cat.key ? cat.color : undefined }}
                  >
                    <span className="bookmark-category-dot" style={{ backgroundColor: cat.color }} />
                    {cat.label}
                  </button>
                ))}
              </div>
            )}

            {filteredBookmarks.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 py-8">
                <BookmarkCheck className="h-6 w-6 bookmark-empty-icon" />
                <p className="text-[11px] text-muted-foreground/60 text-center">
                  {bookmarks.length === 0 ? '点击工具栏书签图标\n添加当前章节' : '没有匹配的书签'}
                </p>
              </div>
            ) : (
              <div className="flex-1 space-y-1">
                {filteredBookmarks.map((bm) => {
                  const ch = chapters[bm.chapterIndex];
                  if (!ch) return null;
                  const isCurrent = bm.chapterIndex === currentIndex;
                  return (
                    <button
                      key={`${bm.chapterIndex}-${bm.timestamp}`}
                      onClick={() => {
                        onLoadChapter(bm.chapterIndex);
                        onSaveProgress(bm.chapterIndex);
                      }}
                      className={
                        'block w-full text-left rounded-md px-2 py-2 transition-colors group ' +
                        (isCurrent
                          ? 'bg-amber-500/10 border border-amber-500/20'
                          : 'hover:bg-muted/50 border border-transparent')
                      }
                    >
                      <div className="flex items-start gap-1.5">
                        <BookmarkCheck className={`h-3 w-3 mt-0.5 shrink-0 ${isCurrent ? 'text-amber-500' : 'text-amber-500/50'}`} />
                        <div className="flex-1 min-w-0">
                          <p className={`text-[11px] leading-tight truncate ${isCurrent ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-foreground'}`}>
                            {bm.chapterTitle}
                          </p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {/* Category dot */}
                            {(bm as EnhancedBookmarkEntry).category && (
                              <span
                                className="bookmark-category-dot"
                                style={{ backgroundColor: BOOKMARK_CATEGORIES.find(c => c.key === (bm as EnhancedBookmarkEntry).category)?.color ?? '#f59e0b' }}
                                title={BOOKMARK_CATEGORIES.find(c => c.key === (bm as EnhancedBookmarkEntry).category)?.label}
                              />
                            )}
                            <span className="text-[9px] text-muted-foreground/60 tabular-nums">
                              {bm.scrollPercent}%
                            </span>
                            <span className="text-muted-foreground/30">·</span>
                            <span className="text-[9px] text-muted-foreground/60">
                              {new Date(bm.timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                            </span>
                          </div>
                        </div>
                        <button
                          className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded hover:bg-destructive/10 text-muted-foreground/40 hover:text-destructive transition-all shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveBookmark(bm.chapterIndex);
                          }}
                          aria-label={`移除书签: ${bm.chapterTitle}`}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
