'use client';

import Link from 'next/link';
import { BookX, Home, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

export default function NovelNotFound() {
  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' as const }}
        className="flex flex-col items-center gap-6 text-center max-w-sm"
      >
        {/* Large decorative icon group */}
        <div className="relative">
          {/* Soft glow behind the icon */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-32 w-32 rounded-full bg-muted/80 blur-2xl" />
          </div>
          <div className="relative flex h-28 w-28 items-center justify-center rounded-3xl border bg-gradient-to-br from-muted to-muted/50 shadow-sm">
            <BookX className="h-14 w-14 text-muted-foreground/70" strokeWidth={1.5} />
          </div>
        </div>

        {/* Text content */}
        <div className="space-y-2">
          <p className="text-6xl font-bold tabular-nums text-muted-foreground/20 select-none">
            404
          </p>
          <h1 className="text-xl font-semibold tracking-tight">
            这本小说迷路了
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            你访问的小说不存在或已被删除，
            <br className="hidden sm:inline" />
            请检查链接是否正确。
          </p>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
          <Button variant="outline" asChild>
            <Link href="/" className="gap-1.5">
              <Home className="h-4 w-4" />
              返回首页
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/?focusSearch=true" className="gap-1.5 text-muted-foreground">
              <Search className="h-3.5 w-3.5" />
              搜索其他小说
            </Link>
          </Button>
        </div>
      </motion.div>
    </main>
  );
}
