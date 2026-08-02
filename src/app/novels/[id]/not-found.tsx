import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { BookX, ArrowLeft } from 'lucide-react';

export default function NovelNotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
          <BookX className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">小说未找到</h1>
          <p className="text-sm text-muted-foreground">
            你访问的小说不存在或已被删除
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            返回首页
          </Link>
        </Button>
      </div>
    </main>
  );
}
