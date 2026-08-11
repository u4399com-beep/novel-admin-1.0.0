'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Sparkles, Code, Bug, Globe, Cloud, Zap, Bot, Copy } from 'lucide-react';
import { safeFormatDate } from '@/lib/format';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { useDeleteConfirm } from '@/hooks/useDeleteConfirm';
import type { ScrapeRuleItem } from './types';

const LIST_ENGINE_COLORS: Record<string, string> = {
  cheerio: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20',
  playwright: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20',
  firecrawl: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20',
  agentql: 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20',
  'cloud-browser': 'text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-900/20',
};

const LIST_ENGINE_ICONS: Record<string, typeof Bug> = {
  cheerio: Bug,
  playwright: Globe,
  firecrawl: Zap,
  agentql: Bot,
  'cloud-browser': Cloud,
};

const LIST_ENGINE_LABELS: Record<string, string> = {
  cheerio: 'Cheerio',
  playwright: 'Playwright',
  firecrawl: 'Firecrawl',
  agentql: 'AgentQL',
  'cloud-browser': '云端浏览器',
};

interface ScrapeRuleListProps {
  onEdit: (rule: ScrapeRuleItem) => void;
  onCreate: () => void;
  onOpenAiAssistant?: () => void;
}

export function ScrapeRuleList({ onEdit, onCreate, onOpenAiAssistant }: ScrapeRuleListProps) {
  const [rules, setRules] = useState<ScrapeRuleItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const { deleteTarget, setDeleteTarget, deleting, handleDelete: confirmDelete } = useDeleteConfirm<ScrapeRuleItem>();
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchRules = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '20',
        ...(search ? { search } : {}),
      });
      const data = await apiFetch<{ rules: ScrapeRuleItem[]; totalPages: number }>(`/api/scrape-rules?${params}`, { signal });
      if (signal?.aborted) return;
      setRules(data.rules || []);
      setTotalPages(data.totalPages || 1);
    } catch {
      if (signal?.aborted) return;
      /* handled by apiFetch */
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    const ac = new AbortController();
    fetchRules(ac.signal);
    return () => ac.abort();
  }, [fetchRules]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const [cloningId, setCloningId] = useState<string | null>(null);

  const handleDelete = useCallback(() => confirmDelete(async () => {
    if (!deleteTarget) return;
    await apiFetch(`/api/scrape-rules/${deleteTarget.id}`, { method: 'DELETE' });
    toast.success('规则已删除');
    fetchRules();
  }), [confirmDelete, deleteTarget, fetchRules]);

  const handleClone = useCallback(async (rule: ScrapeRuleItem) => {
    setCloningId(rule.id);
    try {
      const cloned = await apiFetch<{ id: string; name: string }>('/api/scrape-rules/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleId: rule.id }),
      });
      toast.success(`已克隆: ${cloned.name}`);
      fetchRules();
    } catch { /* handled by apiFetch */ }
    finally { setCloningId(null); }
  }, [fetchRules]);

  const handleExecute = async (rule: ScrapeRuleItem) => {
    try {
      const task = await apiFetch<{ id: string }>('/api/scrape-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleId: rule.id, mode: rule.scrapeMode || 'incremental' }),
      });
      toast.success(`任务已创建: ${task.id.slice(0, 8)}...`);
    } catch { /* handled by apiFetch */ }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">采集规则管理</h2>
          <p className="text-sm text-muted-foreground">配置和管理小说采集规则 · 支持5种采集引擎</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenAiAssistant?.()} className="gap-1.5">
            <Sparkles className="h-4 w-4 text-purple-600" />
            <span className="hidden sm:inline">AI生成</span>
          </Button>
          <Button onClick={onCreate}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2 lucide lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
            新建规则
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 sm:max-w-sm">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground lucide lucide-search"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <Input
            placeholder="搜索规则名称..."
            className="pl-9"
            value={searchInput}
            onChange={(e) => {
              const val = e.target.value;
              setSearchInput(val);
              if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
              searchDebounceRef.current = setTimeout(() => {
                setSearch(val);
                setPage(1);
              }, 300);
            }}
          />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
              <tr className="border-b text-left">
                <th className="px-4 py-3 font-medium">规则名称</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">引擎</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">状态</th>
                <th className="hidden px-4 py-3 font-medium lg:table-cell">模式</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">任务数</th>
                <th className="hidden px-4 py-3 font-medium lg:table-cell">最近执行</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-5 w-16 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-5 w-12 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-16 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-8 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                    </td>
                    <td className="px-4 py-3">
                      <div className="ml-auto h-4 w-20 animate-pulse rounded bg-muted" />
                    </td>
                  </tr>
                ))
              ) : rules.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
                        <Code className="h-7 w-7 text-muted-foreground/60" />
                      </div>
                      <div className="text-center">
                        <span className="text-sm font-medium">暂无采集规则</span>
                        <p className="mt-1 text-xs text-muted-foreground">创建您的第一条采集规则，开始自动化采集小说</p>
                      </div>
                      <Button size="sm" onClick={onCreate}>
                        创建采集规则
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr
                    key={rule.id}
                    className="border-b last:border-0 transition-colors hover:bg-muted/50"
                  >
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-medium">{rule.name}</p>
                        {rule.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1 max-w-[240px]">
                            {rule.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <div className="flex items-center gap-1.5">
                        {(() => {
                          const EngineIcon = LIST_ENGINE_ICONS[rule.engine || 'cheerio'] || Bug;
                          const colorClasses = LIST_ENGINE_COLORS[rule.engine || 'cheerio'] || LIST_ENGINE_COLORS.cheerio;
                          return (
                            <div className={`flex h-6 w-6 items-center justify-center rounded-md ${colorClasses}`}>
                              <EngineIcon className="h-3.5 w-3.5" />
                            </div>
                          );
                        })()}
                        <span className="text-xs">{LIST_ENGINE_LABELS[rule.engine || 'cheerio'] || rule.engine || 'Cheerio'}</span>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <Badge
                        className={rule.enabled
                          ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 border-0'
                          : 'bg-muted text-muted-foreground hover:bg-muted border-0'
                        }
                      >
                        {rule.enabled ? '已启用' : '已禁用'}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant="outline">
                          {rule.storageMode === 'file' ? '文件' : '数据库'}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {rule.dedupMode === 'both' ? '双重去重' : rule.dedupMode === 'title' ? '标题去重' : 'URL去重'}
                        </Badge>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <span className="text-muted-foreground">{rule._count?.tasks || 0}</span>
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell text-muted-foreground">
                      {rule.lastRunAt
                        ? safeFormatDate(rule.lastRunAt, (d) => formatDistanceToNow(d, { addSuffix: true, locale: zhCN }))
                        : '从未执行'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                          onClick={() => handleExecute(rule)}
                          title="执行"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-play"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                          onClick={() => handleClone(rule)}
                          disabled={cloningId === rule.id}
                          title="克隆"
                        >
                          {cloningId === rule.id ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-loader-2 animate-spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => onEdit(rule)}
                          title="编辑"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setDeleteTarget(rule)}
                          title="删除"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            上一页
          </Button>
          <span className="text-sm text-muted-foreground">
            第 {page} / {totalPages} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="确定要删除这条采集规则吗？"
        description="删除后相关任务也会被删除，此操作无法撤销。"
        loading={deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}