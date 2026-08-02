import { Skeleton } from '@/components/ui/skeleton';
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbSeparator, BreadcrumbPage } from '@/components/ui/breadcrumb';

function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 px-4 py-3 border-b">
      <Skeleton className="w-8 h-8 rounded-full shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-12 rounded-full" />
          <Skeleton className="h-4 w-14 rounded-full" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-10" />
        </div>
      </div>
      <div className="text-right space-y-1 shrink-0">
        <Skeleton className="h-4 w-10 ml-auto" />
        <Skeleton className="h-3 w-8 ml-auto" />
      </div>
    </div>
  );
}

function Top3SkeletonCard() {
  return (
    <div className="rounded-xl border-2 border-muted p-4">
      <div className="flex items-start gap-4">
        <Skeleton className="w-8 h-8 rounded-full shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-12 rounded-full" />
            <Skeleton className="h-4 w-14 rounded-full" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
        <div className="text-right space-y-1 shrink-0">
          <Skeleton className="h-5 w-10 ml-auto" />
          <Skeleton className="h-3 w-8 ml-auto" />
        </div>
      </div>
    </div>
  );
}

export default function RankingsLoading() {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:py-10">
        {/* Breadcrumb skeleton */}
        <div className="mb-6 sm:mb-8">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <Skeleton className="h-4 w-8" />
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>
                  <Skeleton className="h-4 w-12" />
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          {/* Header skeleton */}
          <div className="flex items-center gap-3 mt-4">
            <Skeleton className="w-10 h-10 rounded-xl" />
            <div className="space-y-2">
              <Skeleton className="h-6 w-20" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
        </div>

        {/* Tab bar skeleton */}
        <Skeleton className="h-9 w-72 rounded-lg mb-6" />

        {/* Top 3 skeleton cards */}
        <div className="grid gap-3 sm:grid-cols-3 mb-3">
          <Top3SkeletonCard />
          <Top3SkeletonCard />
          <Top3SkeletonCard />
        </div>

        {/* Remaining row skeletons */}
        <div className="rounded-lg border overflow-hidden">
          {Array.from({ length: 7 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
