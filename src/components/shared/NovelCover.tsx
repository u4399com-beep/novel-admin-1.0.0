'use client';

import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { getCoverGradient } from '@/lib/cover-gradient';

// ─── Lazy load hook with IntersectionObserver ────────────────
function useLazyLoad() {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, isVisible };
}

interface NovelCoverProps {
  coverUrl: string | null | undefined;
  title: string;
  /** Extra classes applied to both the image and the placeholder div */
  className?: string;
  /** Extra classes applied only to the placeholder div (merged after className, can override) */
  gradientClassName?: string;
  /** Classes for the title-character text (e.g. 'text-2xl') */
  textClassName?: string;
}

export function NovelCover({ coverUrl, title, className, gradientClassName, textClassName }: NovelCoverProps) {
  const [imgError, setImgError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const { ref: lazyRef, isVisible } = useLazyLoad();

  if (coverUrl && !imgError) {
    return (
      <div ref={lazyRef} className={cn('h-full w-full', className)}>
        {isVisible ? (
          <img
            src={coverUrl}
            alt={title}
            className={cn('h-full w-full object-cover transition-opacity duration-400', imgLoaded ? 'opacity-100 lazy-img-enter' : 'opacity-0', className)}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="h-full w-full bg-muted animate-pulse" />
        )}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'h-full w-full flex items-center justify-center bg-gradient-to-br relative',
        getCoverGradient(title),
        className,
        gradientClassName,
      )}
      role="img"
      aria-label={title}
    >
      {/* Subtle diagonal gradient overlay for depth */}
      <div className="absolute inset-0 bg-gradient-to-tr from-black/20 via-transparent to-white/10 pointer-events-none" />
      <span className={cn('font-bold text-white/90 select-none relative z-[1]', textClassName)}>
        {title.charAt(0)}
      </span>
    </div>
  );
}
