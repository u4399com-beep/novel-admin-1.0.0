'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

export function ScrollProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    function handleScroll() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) { setProgress(0); return; }
      setProgress(Math.round((window.scrollY / scrollable) * 100));
    }
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 h-0.5 bg-transparent pointer-events-none"
      role="progressbar"
      aria-valuenow={progress}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="页面阅读进度"
      style={{ opacity: progress > 0 ? 1 : 0, transition: 'opacity 0.2s' }}
    >
      <motion.div
        className="h-full reading-progress-bar"
        initial={false}
        animate={{ width: `${Math.max(progress, 0)}%` }}
        transition={{ duration: 0.15 }}
      />
    </div>
  );
}
