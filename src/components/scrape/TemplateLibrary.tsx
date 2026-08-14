'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { apiFetch } from '@/lib/api-fetch';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

// ==================== 类型定义 ====================

interface TemplateItem {
  id: string;
  name: string;
  description: string;
  siteUrl: string;
  engine: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
}

interface TemplateLibraryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied?: () => void;
}

// ==================== 常量 ====================

const ENGINE_LABELS: Record<string, string> = {
  cheerio: 'Cheerio',
  playwright: 'Playwright',
  firecrawl: 'Firecrawl',
  agentql: 'AgentQL',
  'cloud-browser': '云端浏览器',
};

const DIFFICULTY_CONFIG: Record<string, { label: string; className: string }> = {
  easy: {
    label: '简单',
    className: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 border-0',
  },
  medium: {
    label: '中等',
    className: 'bg-amber-100 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 border-0',
  },
  hard: {
    label: '困难',
    className: 'bg-destructive/10 text-destructive hover:bg-destructive/10 border-0',
  },
};

// ==================== 动画变体 ====================

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
};

// ==================== 组件 ====================

export function TemplateLibrary({ open, onOpenChange, onApplied }: TemplateLibraryProps) {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // 加载模板列表
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    apiFetch<{ templates: TemplateItem[] }>(`/api/scrape-rules/templates${search ? `?search=${encodeURIComponent(search)}` : ''}`, { signal: undefined })
      .then((data) => {
        if (!cancelled) setTemplates(data.templates || []);
      })
      .catch(() => {
        // apiFetch已处理错误toast
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, search]);

  // 过滤后的模板
  const filteredTemplates = useMemo(() => {
    if (!search) return templates;
    const lower = search.toLowerCase();
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(lower) ||
        t.description.toLowerCase().includes(lower) ||
        t.tags.some((tag) => tag.toLowerCase().includes(lower))
    );
  }, [templates, search]);

  // 应用模板
  const handleApply = useCallback(
    async (templateId: string) => {
      setApplyingId(templateId);
      setConfirmId(null);
      try {
        await apiFetch<{ id: string }>(`/api/scrape-rules/templates/${templateId}/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        toast.success('模板已应用，新规则已创建');
        onApplied?.();
        onOpenChange(false);
      } catch {
        // apiFetch已处理
      } finally {
        setApplyingId(null);
      }
    },
    [onApplied, onOpenChange]
  );

  // 确认弹窗中的模板
  const confirmTemplate = useMemo(
    () => (confirmId ? templates.find((t) => t.id === confirmId) : null),
    [confirmId, templates]
  );

  return (
    <>
      {/* 主模板库弹窗 */}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>模板库</DialogTitle>
            <DialogDescription>
              选择预置模板快速创建采集规则，应用后可自行修改
            </DialogDescription>
          </DialogHeader>

          {/* 搜索栏 */}
          <div className="relative">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <Input
              placeholder="搜索模板名称或标签..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* 模板网格 */}
          <div className="flex-1 overflow-y-auto min-h-0 -mx-1 px-1">
            {loading ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="rounded-lg border p-4 space-y-3">
                    <div className="h-5 w-24 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                    <div className="flex gap-2">
                      <div className="h-5 w-14 animate-pulse rounded-full bg-muted" />
                      <div className="h-5 w-10 animate-pulse rounded-full bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredTemplates.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <p className="text-sm">未找到匹配的模板</p>
                <p className="mt-1 text-xs">试试其他关键词</p>
              </div>
            ) : (
              <motion.div
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-1"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                key={search}
              >
                {filteredTemplates.map((template) => {
                  const diffConfig = DIFFICULTY_CONFIG[template.difficulty] || DIFFICULTY_CONFIG.medium;
                  return (
                    <motion.div
                      key={template.id}
                      variants={cardVariants}
                      className="rounded-lg border p-4 flex flex-col gap-3 hover:border-primary/40 hover:shadow-sm transition-all"
                    >
                      {/* 头部: 名称 + 难度 */}
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold text-sm leading-tight">{template.name}</h3>
                        <Badge className={diffConfig.className}>
                          {diffConfig.label}
                        </Badge>
                      </div>

                      {/* 描述 */}
                      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                        {template.description}
                      </p>

                      {/* 引擎 + 标签 */}
                      <div className="flex items-center gap-2 flex-wrap mt-auto">
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {ENGINE_LABELS[template.engine] || template.engine}
                        </Badge>
                        {template.tags.slice(0, 3).map((tag) => (
                          <Badge
                            key={tag}
                            variant="secondary"
                            className="text-[10px] shrink-0"
                          >
                            {tag}
                          </Badge>
                        ))}
                      </div>

                      {/* 使用按钮 */}
                      <Button
                        size="sm"
                        className="w-full mt-1"
                        onClick={() => setConfirmId(template.id)}
                        disabled={applyingId === template.id}
                      >
                        {applyingId === template.id ? (
                          <>
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="mr-1.5 animate-spin"
                            >
                              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                            应用中...
                          </>
                        ) : (
                          '使用模板'
                        )}
                      </Button>
                    </motion.div>
                  );
                })}
              </motion.div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 确认弹窗 */}
      <Dialog open={!!confirmId} onOpenChange={(o) => !o && setConfirmId(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>确认使用模板</DialogTitle>
            <DialogDescription>
              将基于「{confirmTemplate?.name}」模板创建一条新的采集规则，
              创建后可在编辑器中进一步修改。
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmId(null)}>
              取消
            </Button>
            <Button
              onClick={() => confirmId && handleApply(confirmId)}
              disabled={!confirmId || !!applyingId}
            >
              确认应用
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
