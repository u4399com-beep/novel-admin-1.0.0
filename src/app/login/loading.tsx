import { Skeleton } from '@/components/ui/skeleton';

export default function LoginLoading() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden bg-background">
      {/* Decorative background pattern */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_50%,rgba(120,80,220,0.06),transparent_50%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgba(120,80,220,0.04),transparent_50%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_80%,rgba(100,60,200,0.05),transparent_50%)]" />

      <div className="w-full max-w-sm relative z-10 animate-pulse">
        {/* Logo / Brand */}
        <div className="flex flex-col items-center mb-8">
          <Skeleton className="h-14 w-14 rounded-2xl mb-4" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-4 w-28 mt-2" />
        </div>

        {/* Card skeleton */}
        <div className="rounded-xl border bg-card p-6 space-y-5 shadow-2xl shadow-black/[0.08] dark:shadow-black/20">
          {/* Card header */}
          <div className="flex flex-col items-center gap-2 pb-4">
            <Skeleton className="h-5 w-12" />
            <Skeleton className="h-3 w-36" />
          </div>

          {/* Username input */}
          <div className="space-y-2">
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>

          {/* Password input */}
          <div className="space-y-2">
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>

          {/* Submit button */}
          <Skeleton className="h-10 w-full rounded-md" />

          {/* Back link */}
          <div className="pt-1">
            <Skeleton className="h-4 w-20 mx-auto" />
          </div>
        </div>

        {/* Version text */}
        <div className="mt-6 text-center">
          <Skeleton className="h-3 w-20 mx-auto" />
        </div>
      </div>
    </div>
  );
}
