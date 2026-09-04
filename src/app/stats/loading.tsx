import { Loader2 } from 'lucide-react';

export default function StatsLoading() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-3">
          <h1 className="text-base font-semibold">阅读统计</h1>
        </div>
      </header>
      <main className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </main>
    </div>
  );
}
