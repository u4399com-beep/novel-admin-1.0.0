'use client';

import { Skeleton } from '@/components/ui/skeleton';
import type { ViewType } from '@/types';

interface AdminViewSkeletonsProps {
  view: ViewType;
}

export function AdminViewSkeletons({ view }: AdminViewSkeletonsProps) {
  return <div className="p-4 sm:p-6 space-y-6">{getSkeleton(view)}</div>;
}

function getSkeleton(view: ViewType) {
  switch (view) {
    case 'novels':
      return <NovelsSkeleton />;
    case 'categories':
      return <CategoriesSkeleton />;
    case 'tags':
      return <TagsSkeleton />;
    case 'themes':
      return <ThemesSkeleton />;
    case 'sites':
      return <SitesSkeleton />;
    case 'scrape':
    case 'download':
      return <TableSkeleton rows={5} />;
    case 'dashboard':
      return <DashboardSkeleton />;
    default:
      return <TableSkeleton rows={4} />;
  }
}

// ─── Dashboard ─────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <>
      {/* Stats cards row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>

      {/* Chart skeleton */}
      <div className="rounded-xl border bg-card p-6">
        <Skeleton className="h-5 w-32 mb-4" />
        <Skeleton className="h-[200px] w-full rounded-lg" />
      </div>

      {/* Recent list skeleton */}
      <div className="rounded-xl border bg-card p-6">
        <Skeleton className="h-5 w-24 mb-4" />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── Novels ────────────────────────────────────────────────────────────

function NovelsSkeleton() {
  return (
    <>
      {/* Search bar + actions */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Skeleton className="h-9 flex-1 max-w-md rounded-md" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20 rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
      </div>

      {/* Novel card grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card overflow-hidden space-y-3">
            <Skeleton className="aspect-[3/4] w-full" />
            <div className="px-3 pb-3 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Categories ────────────────────────────────────────────────────────

function CategoriesSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
      <TableSkeleton rows={6} />
    </>
  );
}

// ─── Tags ──────────────────────────────────────────────────────────────

function TagsSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
      <TableSkeleton rows={6} />
    </>
  );
}

// ─── Themes ────────────────────────────────────────────────────────────

function ThemesSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-5 w-5 rounded-md" />
            </div>
            {/* Color swatches */}
            <div className="flex gap-2">
              {Array.from({ length: 5 }).map((_, j) => (
                <Skeleton key={j} className="h-6 w-6 rounded-full" />
              ))}
            </div>
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Sites ─────────────────────────────────────────────────────────────

function SitesSkeleton() {
  return (
    <>
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-5 w-10 rounded-full" />
            </div>
            <Skeleton className="h-3 w-36" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-8 w-16 rounded-md" />
              <Skeleton className="h-8 w-16 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Generic Table (for scrape / download / etc.) ─────────────────────

function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-4 border-b px-4 py-3">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-20 ml-auto" />
        <Skeleton className="h-4 w-16" />
      </div>
      {/* Body rows */}
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-5 w-14 rounded-full ml-auto" />
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
