import { Skeleton } from '@/components/ui/skeleton';

export default function NovelDetailLoading() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Back button */}
        <Skeleton className="mb-6 h-8 w-20" />

        {/* Novel info section */}
        <section className="border-b pb-8">
          <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
            {/* Cover skeleton */}
            <Skeleton className="shrink-0 w-40 sm:w-48 aspect-[3/4] rounded-xl" />

            {/* Meta skeleton */}
            <div className="flex-1 min-w-0 space-y-4">
              <div className="space-y-2">
                <Skeleton className="h-8 w-3/4" />
                <Skeleton className="h-4 w-1/4" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
              <div className="flex gap-5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Skeleton className="h-5 w-12 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <div className="pt-2 space-y-2">
                <Skeleton className="h-3 w-8" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          </div>
        </section>

        {/* Chapter list skeleton */}
        <section className="py-8">
          <div className="flex items-center justify-between border-b pb-3 mb-4">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="rounded-lg border">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-4 py-3 border-b last:border-b-0"
              >
                <div className="flex items-center gap-3">
                  <Skeleton className="h-3 w-6" />
                  <Skeleton className="h-4 w-48" />
                </div>
                <Skeleton className="h-3 w-12" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
