export default function Loading() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header skeleton */}
      <div className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <div className="h-7 w-28 rounded-lg bg-muted animate-pulse" />
            <div className="hidden h-5 w-16 rounded bg-muted/50 animate-pulse sm:block" />
            <div className="hidden h-5 w-16 rounded bg-muted/50 animate-pulse sm:block" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
            <div className="hidden h-8 w-20 rounded-lg bg-muted/50 animate-pulse sm:block" />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-6 sm:py-10">
        {/* Hero section skeleton */}
        <div className="mb-8 flex flex-col items-center gap-3 sm:mb-10">
          <div className="h-6 w-32 rounded bg-muted animate-pulse" />
          <div className="h-10 w-72 max-w-full rounded-xl bg-muted/50 animate-pulse" />
        </div>

        {/* Filter bar skeleton */}
        <div className="mb-6 space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-4 w-10 rounded bg-muted animate-pulse" />
            <div className="flex gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-7 w-16 rounded-full bg-muted/50 animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-4 w-10 rounded bg-muted animate-pulse" />
            <div className="flex gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-7 w-14 rounded-full bg-muted/50 animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-4 w-10 rounded bg-muted animate-pulse" />
            <div className="flex gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-7 w-20 rounded-full bg-muted/50 animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
              ))}
            </div>
          </div>
        </div>

        {/* Novel grid skeleton */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 sm:gap-6">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="space-y-3">
              <div className="aspect-[3/4] w-full rounded-xl bg-muted animate-pulse" style={{ animationDelay: `${i * 40}ms` }} />
              <div className="h-4 w-3/4 rounded bg-muted/50 animate-pulse" />
              <div className="h-3 w-1/2 rounded bg-muted/30 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
