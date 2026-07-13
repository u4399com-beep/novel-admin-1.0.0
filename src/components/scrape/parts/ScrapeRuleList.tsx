'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { Sparkles } from 'lucide-react';
import { safeFormatDate } from '@/lib/format';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { ScrapeRuleItem } from './types';

const LIST_ENGINE_COLORS: Record<string, string> = {
  cheerio: 'bg-green-500',
  playwright: 'bg-blue-500',
  firecrawl: 'bg-orange-500',
  agentql: 'bg-purple-500',
  'cloud-browser': 'bg-cyan-500',
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
  const [deleteTarget, setDeleteTarget] = useState<ScrapeRuleItem | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '20',
        ...(search ? { search } : {}),
      });
      const res = await fetch(`/api/scrape-rules?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRules(data.rules || []);
      setTotalPages(data.totalPages || 1);
    } catch {
      toast.error('获取规则列表失败');
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/scrape-rules/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      toast.success('规则已删除');
      fetchRules();
    } catch {
      toast.error('删除失败');
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleExecute = async (rule: ScrapeRuleItem) => {
    try {
      const res = await fetch('/api/scrape-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleId: rule.id, mode: rule.scrapeMode || 'incremental' }),
      });
      if (!res.ok) throw new Error();
      const task = await res.json();
      toast.success(`任务已创建: ${task.id.slice(0, 8)}...`);
    } catch {
      toast.error('创建任务失败，请确认采集任务API可用');
    }
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
                <th className="hidden px-4 py-3 font-medium lg:table-cell">创建时间</th>
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
                    <div className="flex flex-col items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/50 lucide lucide-file-search"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><circle cx="11.5" cy="14.5" r="2.5"/><path d="m14 17-2.5-2.5"/></svg>
                      <span>暂无采集规则</span>
                      <Button variant="link" size="sm" onClick={onCreate}>
                        创建第一条规则
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
                        <span className={`h-2 w-2 rounded-full ${LIST_ENGINE_COLORS[rule.engine || 'cheerio'] || 'bg-green-500'}`} />
                        <span className="text-xs">{LIST_ENGINE_LABELS[rule.engine || 'cheerio'] || rule.engine || 'Cheerio'}</span>
                      </div>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <Badge variant={rule.enabled ? 'default' : 'secondary'}>
                        {rule.enabled ? '已启用' : '已禁用'}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      <Badge variant="outline">
                        {rule.storageMode === 'file' ? '文件' : '数据库'}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <span className="text-muted-foreground">{rule._count?.tasks || 0}</span>
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell text-muted-foreground">
                      {safeFormatDate(rule.createdAt, (d) => format(d, 'yyyy-MM-dd HH:mm', { locale: zhCN }))}
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
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确定要删除这条采集规则吗？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后相关任务也会被删除，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && handleDelete(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}