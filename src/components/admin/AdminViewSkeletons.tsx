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
            <Skeleton
              className="h-4 w-16"
              style={{ animationDelay: `${i * 80}ms` }}
            />
            <Skeleton
              className="h-7 w-24"
              style={{ animationDelay: `${i * 80 + 40}ms` }}
            />
          </div>
        ))}
      </div>

      {/* Chart area — two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main chart placeholder */}
        <div className="lg:col-span-2 rounded-xl border bg-card p-6">
          <Skeleton className="h-5 w-32 mb-1" style={{ animationDelay: '100ms' }} />
          <Skeleton className="h-3 w-20 mb-5" style={{ animationDelay: '140ms' }} />
          {/* Chart bars */}
          <div className="flex items-end gap-2 h-[180px] pt-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <Skeleton
                  className="w-full rounded-t"
                  style={{
                    height: `${Math.max(30, ((i * 37 + 13) % 60) + 40)}%`,
                    animationDelay: `${i * 60}ms`,
                  }}
                />
                <Skeleton
                  className="h-2.5 w-6 rounded"
                  style={{ animationDelay: `${i * 60 + 30}ms` }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Side chart / donut placeholder */}
        <div className="rounded-xl border bg-card p-6">
          <Skeleton className="h-5 w-24 mb-1" style={{ animationDelay: '120ms' }} />
          <Skeleton className="h-3 w-16 mb-5" style={{ animationDelay: '160ms' }} />
          <div className="flex items-center justify-center py-2">
            <Skeleton className="h-40 w-40 rounded-full" style={{ animationDelay: '200ms' }} />
          </div>
          {/* Legend items */}
          <div className="mt-4 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton
                  className="h-3 w-3 rounded-sm"
                  style={{ animationDelay: `${300 + i * 60}ms` }}
                />
                <Skeleton
                  className="h-3 w-16"
                  style={{ animationDelay: `${300 + i * 60 + 20}ms` }}
                />
                <Skeleton
                  className="h-3 w-8 ml-auto"
                  style={{ animationDelay: `${300 + i * 60 + 40}ms` }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent list skeleton */}
      <div className="rounded-xl border bg-card p-6">
        <Skeleton className="h-5 w-24 mb-1" style={{ animationDelay: '200ms' }} />
        <Skeleton className="h-3 w-36 mb-4" style={{ animationDelay: '240ms' }} />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton
                className="h-10 w-10 rounded-lg shrink-0"
                style={{ animationDelay: `${300 + i * 70}ms` }}
              />
              <div className="flex-1 space-y-1.5">
                <Skeleton
                  className="h-4 w-40"
                  style={{ animationDelay: `${300 + i * 70 + 20}ms` }}
                />
                <Skeleton
                  className="h-3 w-24"
                  style={{ animationDelay: `${300 + i * 70 + 40}ms` }}
                />
              </div>
              <Skeleton
                className="h-5 w-16 rounded-full"
                style={{ animationDelay: `${300 + i * 70 + 30}ms` }}
              />
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
      {/* Search bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Skeleton className="h-9 w-full rounded-md" style={{ animationDelay: '0ms' }} />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20 rounded-md" style={{ animationDelay: '40ms' }} />
          <Skeleton className="h-9 w-20 rounded-md" style={{ animationDelay: '80ms' }} />
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-7 w-16 rounded-full"
            style={{ animationDelay: `${100 + i * 50}ms` }}
          />
        ))}
      </div>

      {/* Novel card grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card overflow-hidden space-y-3">
            <Skeleton
              className="aspect-[3/4] w-full"
              style={{ animationDelay: `${200 + i * 60}ms` }}
            />
            <div className="px-3 pb-3 space-y-2">
              <Skeleton
                className="h-4 w-3/4"
                style={{ animationDelay: `${250 + i * 60}ms` }}
              />
              <Skeleton
                className="h-3 w-1/2"
                style={{ animationDelay: `${280 + i * 60}ms` }}
              />
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
        <Skeleton className="h-5 w-24" style={{ animationDelay: '0ms' }} />
        <Skeleton className="h-9 w-24 rounded-md" style={{ animationDelay: '40ms' }} />
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
        <Skeleton className="h-5 w-24" style={{ animationDelay: '0ms' }} />
        <Skeleton className="h-9 w-24 rounded-md" style={{ animationDelay: '40ms' }} />
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
        <Skeleton className="h-5 w-24" style={{ animationDelay: '0ms' }} />
        <Skeleton className="h-9 w-24 rounded-md" style={{ animationDelay: '40ms' }} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton
                  className="h-5 w-28"
                  style={{ animationDelay: `${100 + i * 60}ms` }}
                />
                <Skeleton
                  className="h-3 w-48"
                  style={{ animationDelay: `${120 + i * 60}ms` }}
                />
              </div>
              <Skeleton
                className="h-5 w-5 rounded-md"
                style={{ animationDelay: `${140 + i * 60}ms` }}
              />
            </div>
            {/* Theme preview: colored rectangles */}
            <div className="space-y-2">
              <Skeleton
                className="h-3 w-12 rounded"
                style={{ animationDelay: `${160 + i * 60}ms` }}
              />
              <div className="flex gap-1.5">
                {Array.from({ length: 6 }).map((_, j) => (
                  <Skeleton
                    key={j}
                    className="h-8 flex-1 rounded-md"
                    style={{
                      animationDelay: `${180 + i * 60 + j * 30}ms`,
                    }}
                  />
                ))}
              </div>
            </div>
            {/* Color swatches */}
            <div className="flex gap-2">
              {Array.from({ length: 5 }).map((_, j) => (
                <Skeleton
                  key={j}
                  className="h-6 w-6 rounded-full"
                  style={{ animationDelay: `${220 + i * 60 + j * 25}ms` }}
                />
              ))}
            </div>
            <Skeleton
              className="h-8 w-full rounded-md"
              style={{ animationDelay: `${260 + i * 60}ms` }}
            />
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
        <Skeleton className="h-5 w-24" style={{ animationDelay: '0ms' }} />
        <Skeleton className="h-9 w-24 rounded-md" style={{ animationDelay: '40ms' }} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton
                  className="h-5 w-32"
                  style={{ animationDelay: `${100 + i * 60}ms` }}
                />
                <Skeleton
                  className="h-3 w-48"
                  style={{ animationDelay: `${120 + i * 60}ms` }}
                />
              </div>
              <Skeleton
                className="h-5 w-10 rounded-full"
                style={{ animationDelay: `${140 + i * 60}ms` }}
              />
            </div>
            <Skeleton
              className="h-3 w-36"
              style={{ animationDelay: `${160 + i * 60}ms` }}
            />
            <div className="flex gap-2 pt-1">
              <Skeleton
                className="h-8 w-16 rounded-md"
                style={{ animationDelay: `${180 + i * 60}ms` }}
              />
              <Skeleton
                className="h-8 w-16 rounded-md"
                style={{ animationDelay: `${200 + i * 60}ms` }}
              />
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
        <Skeleton className="h-4 w-16" style={{ animationDelay: '0ms' }} />
        <Skeleton className="h-4 w-24" style={{ animationDelay: '20ms' }} />
        <Skeleton className="h-4 w-20 ml-auto" style={{ animationDelay: '40ms' }} />
        <Skeleton className="h-4 w-16" style={{ animationDelay: '60ms' }} />
      </div>
      {/* Body rows */}
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <Skeleton
              className="h-4 w-28"
              style={{ animationDelay: `${100 + i * 50}ms` }}
            />
            <Skeleton
              className="h-4 w-40"
              style={{ animationDelay: `${120 + i * 50}ms` }}
            />
            <Skeleton
              className="h-5 w-14 rounded-full ml-auto"
              style={{ animationDelay: `${140 + i * 50}ms` }}
            />
            <Skeleton
              className="h-8 w-16 rounded-md"
              style={{ animationDelay: `${160 + i * 50}ms` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
