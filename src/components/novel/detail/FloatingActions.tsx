'use client';

import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bookmark, Share2, Type, Heart, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface FloatingActionsProps {
  onBookmark?: () => void;
  onShare?: () => void;
  onFontSize?: () => void;
  isBookmarked?: boolean;
}

export function FloatingActions({ onBookmark, onShare, onFontSize, isBookmarked }: FloatingActionsProps) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((p) => !p), []);

  const items = [
    { key: 'bookmark', icon: Bookmark, label: '收藏', color: isBookmarked ? 'text-rose-500' : 'text-foreground', action: onBookmark },
    { key: 'share', icon: Share2, label: '分享', color: 'text-foreground', action: onShare },
    { key: 'font', icon: Type, label: '字号', color: 'text-foreground', action: onFontSize },
  ].filter((item) => item.action);

  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-2">
      <AnimatePresence>
        {open && items.map((item, i) => {
          const Icon = item.icon;
          return (
            <motion.div
              key={item.key}
              initial={{ opacity: 0, scale: 0.5, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.5, y: 10 }}
              transition={{ delay: i * 0.05, type: 'spring', stiffness: 400, damping: 25 }}
              className="flex items-center gap-2"
            >
              <span className="text-xs text-muted-foreground bg-popover border rounded-md px-2 py-1 shadow-sm">
                {item.label}
              </span>
              <Button
                size="icon"
                variant="outline"
                className={`h-10 w-10 rounded-full shadow-lg glass ${item.color}`}
                onClick={() => { item.action?.(); setOpen(false); }}
                aria-label={item.label}
              >
                <Icon className="h-4 w-4" />
              </Button>
            </motion.div>
          );
        })}
      </AnimatePresence>
      <Button
        size="icon"
        className={`h-12 w-12 rounded-full shadow-xl fab-enter transition-colors ${
          open ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'bg-primary text-primary-foreground hover:bg-primary/90'
        }`}
        onClick={toggle}
        aria-label={open ? '关闭快捷操作' : '快捷操作'}
      >
        <motion.div
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        >
          {open ? <X className="h-5 w-5" /> : <Heart className="h-5 w-5" />}
        </motion.div>
      </Button>
    </div>
  );
}
