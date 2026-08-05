'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Pencil, Trash2, Tags, BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardAction,
} from '@/components/ui/card';
import type { Tag } from '@/types';

// ─── Props ────────────────────────────────────────────────────────────────────
interface TagListProps {
  tags: Tag[];
  loading: boolean;
  onEdit: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
  onCreate: () => void;
}

// ─── Loading Skeleton ─────────────────────────────────────────────────────────
function TagSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Card key={i} className="py-4">
          <CardContent className="flex items-center gap-3">
            <Skeleton className="h-5 w-5 rounded-full" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="ml-auto h-5 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Empty State ─────────────────────────────────────────────────────────────
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16"
    >
      <div className="bg-muted/50 flex h-16 w-16 items-center justify-center rounded-full">
        <Tags className="text-muted-foreground h-8 w-8" />
      </div>
      <h3 className="mt-4 text-lg font-medium">暂无标签</h3>
      <p className="text-muted-foreground mt-1 text-sm">
        点击上方按钮创建你的第一个标签
      </p>
      <Button onClick={onCreate} variant="outline" className="mt-4">
        <Plus />
        新建标签
      </Button>
    </motion.div>
  );
}

// ─── Tag Grid ─────────────────────────────────────────────────────────────────
function TagGrid({ tags, onEdit, onDelete }: {
  tags: Tag[];
  onEdit: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
      <AnimatePresence mode="popLayout">
        {tags.map((tag, idx) => (
          <motion.div
            key={tag.id}
            layout
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2, delay: idx * 0.02 }}
          >
            <Card
              className="group relative overflow-hidden transition-all hover:shadow-md hover:border-foreground/20 cursor-default"
              style={{
                borderLeftWidth: '4px',
                borderLeftColor: tag.color,
              }}
            >
              <CardHeader className="py-3 pb-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="inline-block h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/10 transition-transform group-hover:scale-125"
                    style={{ backgroundColor: tag.color }}
                  />
                  <CardTitle className="truncate text-sm font-semibold">
                    {tag.name}
                  </CardTitle>
                </div>
                <CardAction>
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => onEdit(tag)}
                    >
                      <Pencil className="h-3 w-3" />
                      <span className="sr-only">编辑</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => onDelete(tag)}
                    >
                      <Trash2 className="h-3 w-3" />
                      <span className="sr-only">删除</span>
                    </Button>
                  </div>
                </CardAction>
              </CardHeader>
              <CardContent className="py-3 pt-1">
                <Badge variant="secondary" className="gap-1 text-xs">
                  <BookOpen className="h-3 w-3" />
                  {tag._count?.novels ?? 0} 本小说
                </Badge>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─── Exported Component ───────────────────────────────────────────────────────
export function TagList({ tags, loading, onEdit, onDelete, onCreate }: TagListProps) {
  if (loading) return <TagSkeleton />;
  if (tags.length === 0) return <EmptyState onCreate={onCreate} />;
  return <TagGrid tags={tags} onEdit={onEdit} onDelete={onDelete} />;
}
