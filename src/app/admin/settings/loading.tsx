export default function SettingsLoading() {
  return (
    <div className="space-y-6 p-4 md:p-6 animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="h-7 w-32 rounded-md bg-muted" />
        <div className="h-9 w-24 rounded-md bg-muted" />
      </div>

      {/* Tabs skeleton */}
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-9 w-24 rounded-lg bg-muted" />
        ))}
      </div>

      {/* Content cards */}
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border p-6 space-y-4">
            <div className="h-5 w-48 rounded bg-muted" />
            <div className="space-y-3">
              <div className="h-4 w-full rounded bg-muted" />
              <div className="h-4 w-3/4 rounded bg-muted" />
              <div className="h-4 w-1/2 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
