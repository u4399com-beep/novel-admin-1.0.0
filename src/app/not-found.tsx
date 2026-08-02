'use client';

import Link from 'next/link';
import { Home, ShieldCheck, Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

export default function GlobalNotFound() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-4 overflow-hidden">
      {/* Subtle background gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-muted/40 via-background to-muted/30" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(120,80,220,0.05),transparent_50%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_60%,rgba(120,80,220,0.03),transparent_50%)]" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' as const }}
        className="relative z-10 flex flex-col items-center gap-6 text-center max-w-sm"
      >
        {/* Large decorative icon group */}
        <div className="relative">
          {/* Soft glow behind the icon */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-36 w-36 rounded-full bg-muted/70 blur-3xl" />
          </div>
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="relative flex h-28 w-28 items-center justify-center rounded-3xl border bg-gradient-to-br from-muted to-muted/50 shadow-sm"
          >
            <Compass className="h-14 w-14 text-muted-foreground/60" strokeWidth={1.5} />
          </motion.div>
        </div>

        {/* Text content */}
        <div className="space-y-2">
          <motion.p
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, delay: 0.2 }}
            aria-hidden="true"
            className="text-8xl font-black tabular-nums text-muted-foreground/10 select-none tracking-tighter"
          >
            404
          </motion.p>
          <motion.h1
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.3 }}
            className="text-xl font-semibold tracking-tight"
          >
            页面不存在
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.35 }}
            className="text-sm leading-relaxed text-muted-foreground"
          >
            您访问的页面可能已被移动或删除，
            <br className="hidden sm:inline" />
            请检查链接地址是否正确。
          </motion.p>
        </div>

        {/* Actions */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.4 }}
          className="flex flex-col sm:flex-row items-center gap-3 pt-2"
        >
          <Button asChild>
            <Link href="/" className="gap-1.5">
              <Home className="h-4 w-4" />
              返回首页
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/login" className="gap-1.5">
              <ShieldCheck className="h-4 w-4" />
              管理后台
            </Link>
          </Button>
        </motion.div>

        {/* Subtle hint */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="text-xs text-muted-foreground/50 pt-4"
        >
          如果您认为这是一个错误，请联系管理员
        </motion.p>
      </motion.div>
    </main>
  );
}
