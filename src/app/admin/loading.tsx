import { Skeleton } from '@/components/ui/skeleton';

export default function AdminLoading() {
  return (
    <div className="flex min-h-screen animate-in fade-in duration-300">
      {/* ─── Sidebar skeleton (w-64) ──────────────────────────────────── */}
      <aside className="hidden lg:flex h-screen w-64 flex-col border-r bg-slate-900 shrink-0">
        {/* Brand area */}
        <div className="px-6 py-6 pb-5 space-y-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-xl bg-slate-700" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-5 w-16 bg-slate-700" />
              <Skeleton className="h-3 w-28 bg-slate-800" />
            </div>
          </div>
        </div>

        {/* Menu items */}
        <nav className="flex-1 px-3 py-2 space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
              <Skeleton className="h-[1.125rem] w-[1.125rem] rounded bg-slate-700" />
              <Skeleton className="h-4 w-24 bg-slate-700" />
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-700/50 px-3 py-3">
          <Skeleton className="h-8 w-full rounded bg-slate-700" />
        </div>
      </aside>

      {/* ─── Main content skeleton ─────────────────────────────────────── */}
      <main className="flex-1 flex flex-col min-w-0 bg-background">
        {/* Header bar skeleton */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 backdrop-blur-md px-4 sm:px-6 h-14">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded bg-muted" />
            <Skeleton className="h-8 w-48 rounded-md bg-muted/50" />
            <div className="flex flex-col">
              <Skeleton className="h-4 w-20 bg-muted" />
              <Skeleton className="h-3 w-32 bg-muted/60 mt-1" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md bg-muted" />
            <Skeleton className="h-7 w-7 rounded-full bg-muted" />
            <Skeleton className="h-7 w-7 rounded-full bg-muted" />
            <Skeleton className="h-8 w-8 rounded-full bg-muted" />
          </div>
        </header>

        {/* Content grid skeleton */}
        <div className="flex-1 p-4 sm:p-6 space-y-6">
          {/* Stats cards row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-7 w-24" />
              </div>
            ))}
          </div>

          {/* Chart area placeholder */}
          <div className="rounded-xl border bg-card p-6">
            <Skeleton className="h-5 w-32 mb-4" />
            <Skeleton className="h-[200px] w-full rounded-lg" />
          </div>

          {/* Table placeholder */}
          <div className="rounded-xl border bg-card overflow-hidden">
            <div className="flex items-center gap-4 border-b px-4 py-3">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20 ml-auto" />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 border-b last:border-b-0 px-4 py-3">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-5 w-14 rounded-full ml-auto" />
                <Skeleton className="h-8 w-16 rounded-md" />
              </div>
            ))}
          </div>
        </div>

        {/* Footer skeleton */}
        <footer className="mt-auto border-t bg-background/80 px-4 sm:px-6 py-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-16" />
          </div>
        </footer>
      </main>
    </div>
  );
}
