'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { getCoverGradient } from '@/lib/cover-gradient';

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

  if (coverUrl && !imgError) {
    return (
      <img
        src={coverUrl}
        alt={title}
        className={cn('h-full w-full object-cover', className)}
        loading="lazy"
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div
      className={cn(
        'h-full w-full flex items-center justify-center bg-gradient-to-br',
        getCoverGradient(title),
        className,
        gradientClassName,
      )}
      role="img"
      aria-label={title}
    >
      <span className={cn('font-bold text-white/90 select-none', textClassName)}>
        {title.charAt(0)}
      </span>
    </div>
  );
}
