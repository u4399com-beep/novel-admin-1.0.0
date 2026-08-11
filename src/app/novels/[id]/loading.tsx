import { Skeleton } from '@/components/ui/skeleton';

export default function NovelDetailLoading() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        {/* ─── Back button skeleton ───────────────────────────── */}
        <div className="mb-6 -ml-2">
          <Skeleton
            className="h-8 w-[88px] rounded-md"
            style={{ animationDuration: '2s' }}
          />
        </div>

        {/* ─── Novel info section ─────────────────────────────── */}
        <section className="rounded-2xl border bg-gradient-to-br from-muted/40 via-background to-muted/20 p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
            {/* Cover skeleton — matches w-48 h-64 with shadow */}
            <div className="shrink-0">
              <Skeleton
                className="w-48 h-64 rounded-xl shadow-lg"
                style={{ animationDuration: '2.4s' }}
              />
            </div>

            {/* Meta skeleton */}
            <div className="flex-1 min-w-0 space-y-4">
              {/* Title row with button placeholder */}
              <div className="flex items-start gap-3">
                <Skeleton
                  className="h-8 w-48 sm:w-64 rounded-md"
                  style={{ animationDuration: '1.7s' }}
                />
                <Skeleton
                  className="h-8 w-24 rounded-md shrink-0 mt-0"
                  style={{ animationDuration: '2.2s' }}
                />
              </div>
              {/* Author */}
              <Skeleton
                className="h-4 w-24 rounded-sm"
                style={{ animationDuration: '2s' }}
              />

              {/* Status & Category badges */}
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton
                  className="h-5 w-14 rounded-full"
                  style={{ animationDuration: '1.8s' }}
                />
                <Skeleton
                  className="h-5 w-16 rounded-full"
                  style={{ animationDuration: '2.8s' }}
                />
              </div>

              {/* Tags */}
              <div className="flex flex-wrap gap-1.5">
                <Skeleton
                  className="h-[22px] w-12 rounded-full"
                  style={{ animationDuration: '2.3s' }}
                />
                <Skeleton
                  className="h-[22px] w-16 rounded-full"
                  style={{ animationDuration: '1.7s' }}
                />
                <Skeleton
                  className="h-[22px] w-14 rounded-full"
                  style={{ animationDuration: '2.1s' }}
                />
                <Skeleton
                  className="h-[22px] w-10 rounded-full"
                  style={{ animationDuration: '1.9s' }}
                />
              </div>

              {/* Description section */}
              <div className="pt-2 space-y-2 pl-3 relative">
                <Skeleton
                  className="h-3 w-8 rounded-sm"
                  style={{ animationDuration: '2.6s' }}
                />
                <Skeleton
                  className="h-4 w-full rounded-sm"
                  style={{ animationDuration: '2s' }}
                />
                <Skeleton
                  className="h-4 w-full rounded-sm"
                  style={{ animationDuration: '2s' }}
                />
                <Skeleton
                  className="h-4 w-4/5 rounded-sm"
                  style={{ animationDuration: '2s' }}
                />
              </div>

              {/* Stats row — word count, chapter count, update date */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
                {/* Word count stat card */}
                <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-4 py-2">
                  <Skeleton
                    className="h-4 w-4 rounded-sm"
                    style={{ animationDuration: '1.8s' }}
                  />
                  <div className="space-y-1.5">
                    <Skeleton
                      className="h-[18px] w-16 rounded-sm"
                      style={{ animationDuration: '2.2s' }}
                    />
                    <Skeleton
                      className="h-3 w-10 rounded-sm"
                      style={{ animationDuration: '2.8s' }}
                    />
                  </div>
                </div>
                {/* Chapter count stat card */}
                <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-4 py-2">
                  <Skeleton
                    className="h-4 w-4 rounded-sm"
                    style={{ animationDuration: '2.4s' }}
                  />
                  <div className="space-y-1.5">
                    <Skeleton
                      className="h-[18px] w-10 rounded-sm"
                      style={{ animationDuration: '1.6s' }}
                    />
                    <Skeleton
                      className="h-3 w-10 rounded-sm"
                      style={{ animationDuration: '2.3s' }}
                    />
                  </div>
                </div>
                {/* Update date */}
                <Skeleton
                  className="h-4 w-28 rounded-sm"
                  style={{ animationDuration: '2s' }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ─── Chapter list section ────────────────────────────── */}
        <section className="py-8">
          {/* Header */}
          <div className="flex items-center justify-between border-b pb-3 mb-4">
            <Skeleton
              className="h-6 w-20 rounded-sm"
              style={{ animationDuration: '1.9s' }}
            />
            <Skeleton
              className="h-4 w-16 rounded-sm"
              style={{ animationDuration: '2.1s' }}
            />
          </div>

          {/* Chapter items — matches max-h-[600px] rounded-lg border */}
          <div className="max-h-[600px] overflow-hidden rounded-lg border">
            {Array.from({ length: 12 }).map((_, i) => {
              const isOdd = i % 2 !== 0;
              const duration = 1.6 + (i % 5) * 0.2;
              return (
                <div
                  key={i}
                  className={`flex items-center justify-between gap-3 px-4 py-3 border-b last:border-b-0 ${
                    isOdd ? 'bg-muted/30' : ''
                  }`}
                >
                  <Skeleton
                    className="h-4 w-48 sm:w-64 rounded-sm"
                    style={{ animationDuration: `${duration}s` }}
                  />
                </div>
              );
            })}
          </div>
        </section>

        {/* ─── Bottom hint skeleton ────────────────────────────── */}
        <div className="border-t py-6 text-center">
          <Skeleton
            className="mx-auto h-3 w-32 rounded-sm"
            style={{ animationDuration: '2.2s' }}
          />
        </div>
      </div>
    </main>
  );
}
