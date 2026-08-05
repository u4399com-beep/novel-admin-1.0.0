'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Pencil, Trash2, FolderTree } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { safeFormatDate } from '@/lib/format';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Category } from '@/types';

// ─── Props ────────────────────────────────────────────────────────────────────
interface CategoryListProps {
  categories: Category[];
  loading: boolean;
  onEdit: (cat: Category) => void;
  onDelete: (cat: Category) => void;
  onCreate: () => void;
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────
function CategorySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i} className="overflow-hidden">
          <CardContent className="flex items-center gap-3 p-4">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────────────
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <FolderTree className="h-8 w-8 text-muted-foreground" />
      </div>
      <p className="mt-4 text-sm text-muted-foreground">还没有分类，创建第一个吧</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onCreate}>
        <Plus className="mr-1.5 h-4 w-4" />
        新建分类
      </Button>
    </div>
  );
}

// ─── Category Grid ────────────────────────────────────────────────────────────
function CategoryGrid({ categories, onEdit, onDelete }: {
  categories: Category[];
  onEdit: (cat: Category) => void;
  onDelete: (cat: Category) => void;
}) {
  return (
    <motion.div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: 0.04 } },
      }}
    >
      <AnimatePresence mode="popLayout">
        {categories.map((cat) => (
          <motion.div
            key={cat.id}
            layout
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
          >
            <Card className="group relative overflow-hidden hover-lift">
              <div
                className="absolute left-0 top-0 h-full w-1"
                style={{ backgroundColor: cat.color }}
              />
              <CardContent className="p-4 pl-5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {cat.icon ? (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-base" style={{ backgroundColor: cat.color + '20' }}>
                          {cat.icon}
                        </span>
                      ) : (
                        <div
                          className="h-3.5 w-3.5 shrink-0 rounded-full"
                          style={{ backgroundColor: cat.color }}
                        />
                      )}
                      <h3 className="truncate text-sm font-semibold">{cat.name}</h3>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <code className="text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded">
                        {cat.slug}
                      </code>
                    </div>
                    {cat.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {cat.description}
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        {cat._count?.novels ?? 0} 本小说
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {safeFormatDate(cat.createdAt, (d) => formatDistanceToNow(d, {
                          addSuffix: true,
                          locale: zhCN,
                        }))}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="编辑分类"
                      onClick={() => onEdit(cat)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      aria-label="删除分类"
                      onClick={() => onDelete(cat)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Exported Component ───────────────────────────────────────────────────────
export function CategoryList({ categories, loading, onEdit, onDelete, onCreate }: CategoryListProps) {
  if (loading) return <CategorySkeleton />;
  if (categories.length === 0) return <EmptyState onCreate={onCreate} />;
  return <CategoryGrid categories={categories} onEdit={onEdit} onDelete={onDelete} />;
}
