'use client';

import { useState, useEffect, useCallback } from 'react';
import { ArrowUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

export function BackToTop({
  className,
  threshold = 400,
}: {
  className?: string;
  threshold?: number;
}) {
  const [visible, setVisible] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    let ticking = false;
    function handleScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const scrollTop = window.scrollY;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        setVisible(scrollTop > threshold);
        setScrollProgress(docHeight > 0 ? Math.min(scrollTop / docHeight, 1) : 0);
        ticking = false;
      });
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [threshold]);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // SVG circle properties for progress ring
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - scrollProgress * circumference;

  return (
    <AnimatePresence>
      {visible && (
        <motion.button
          initial={{ opacity: 0, scale: 0.8, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, y: 10 }}
          transition={{ duration: 0.2 }}
          onClick={scrollToTop}
          aria-label="回到顶部"
          className={cn(
            'fixed bottom-6 right-6 z-40 flex h-10 w-10 items-center justify-center rounded-full',
            'bg-primary text-primary-foreground shadow-lg',
            'hover:shadow-xl hover:scale-105',
            'transition-shadow duration-200',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            className
          )}
        >
          {/* Progress ring behind the arrow */}
          <svg
            className="absolute inset-0 h-full w-full -rotate-90"
            viewBox="0 0 40 40"
            aria-hidden="true"
          >
            {/* Background circle */}
            <circle
              cx="20"
              cy="20"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="opacity-20"
            />
            {/* Progress circle */}
            <circle
              cx="20"
              cy="20"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              className="opacity-60 transition-[stroke-dashoffset] duration-150 ease-out"
            />
          </svg>
          <ArrowUp className="h-4 w-4 relative z-[1]" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}
