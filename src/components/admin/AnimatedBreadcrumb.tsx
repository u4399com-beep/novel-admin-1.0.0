'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Home } from 'lucide-react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface AnimatedBreadcrumbProps {
  items: BreadcrumbItem[];
}

export function AnimatedBreadcrumb({ items }: AnimatedBreadcrumbProps) {
  return (
    <nav aria-label="面包屑导航" className="flex items-center gap-1 text-xs text-muted-foreground overflow-hidden">
      <Home className="h-3 w-3 shrink-0" />
      <AnimatePresence mode="popLayout">
        {items.map((item, i) => (
          <motion.div
            key={`${item.label}-${i}`}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            transition={{ duration: 0.2, delay: i * 0.03 }}
            className="flex items-center gap-1 shrink-0"
          >
            <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
            {i === items.length - 1 ? (
              <span className="font-medium text-foreground truncate max-w-[120px]" aria-current="page">
                {item.label}
              </span>
            ) : (
              <button
                onClick={item.onClick}
                className="hover:text-foreground transition-colors truncate max-w-[120px] cursor-pointer"
                aria-label={item.label}
              >
                {item.label}
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </nav>
  );
}
