'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Globe, Plus, Trash2, RefreshCw, Download, Upload,
  Link2, Unlink, Activity, Loader2, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle2, XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-fetch';
import { toast } from 'sonner';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProxyInfo {
  url: string;
  protocol: string;
  host: string;
  port: number;
  healthScore: number;
  successCount: number;
  failCount: number;
  avgResponseTime: number;
  status: 'active' | 'cooling' | 'disabled';
  lastUsed?: number;
}

interface ProxyPoolStats {
  total: number;
  active: number;
  disabled: number;
  avgHealth: number;
  proxies: ProxyInfo[];
}

interface DomainBinding {
  domain: string;
  proxyUrl: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PROTOCOL_COLORS: Record<string, string> = {
  HTTP: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30',
  HTTPS: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  SOCKS4: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  SOCKS5: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30',
};

function getStatusColor(status: string): string {
  switch (status) {
    case 'active': return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'cooling': return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'disabled': return 'bg-red-500/10 text-red-600 dark:text-red-400';
    default: return 'bg-muted text-muted-foreground';
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'active': return '活跃';
    case 'cooling': return '冷却中';
    case 'disabled': return '已禁用';
    default: return status;
  }
}

function getHealthGradient(score: number): string {
  if (score > 70) return 'from-emerald-400 to-emerald-500';
  if (score >= 40) return 'from-amber-400 to-amber-500';
  return 'from-red-400 to-red-500';
}

function getHealthTextColor(score: number): string {
  if (score > 70) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 40) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function proxyAction<T = unknown>(action: string, extra?: Record<string, unknown>): Promise<T> {
  return apiFetch<T>('/api/admin/scraper/proxy-manage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
    timeout: 15000,
  });
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ProxyPoolPanel() {
  const [stats, setStats] = useState<ProxyPoolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [addInput, setAddInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const [bindings, setBindings] = useState<DomainBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindDomain, setBindDomain] = useState('');
  const [bindProxy, setBindProxy] = useState('');
  const [bindingDomain, setBindingDomain] = useState(false);
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Fetch stats ──
  const fetchStats = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await apiFetch<ProxyPoolStats>('/api/admin/scraper/proxy-manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'detailed-stats' }),
        signal,
        timeout: 12000,
        silent: true,
      });
      if (!signal?.aborted) setStats(result);
    } catch {
      // handled
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  // ── Fetch bindings ──
  const fetchBindings = useCallback(async (signal?: AbortSignal) => {
    setBindingsLoading(true);
    try {
      const result = await apiFetch<DomainBinding[]>('/api/admin/scraper/proxy-manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'domain-bindings' }),
        signal,
        timeout: 8000,
        silent: true,
      });
      if (!signal?.aborted) setBindings(result);
    } catch {
      // handled
    } finally {
      if (!signal?.aborted) setBindingsLoading(false);
    }
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchStats(ac.signal);
    return () => { abortRef.current?.abort(); abortRef.current = null; };
  }, [fetchStats]);

  useEffect(() => {
    if (bindingsOpen) {
      const ac = new AbortController();
      fetchBindings(ac.signal);
      return () => ac.abort();
    }
  }, [bindingsOpen, fetchBindings]);

  // ── Add proxy ──
  const handleAdd = async () => {
    const url = addInput.trim();
    if (!url) return;
    setAdding(true);
    try {
      await proxyAction('add', { proxyUrl: url });
      toast.success('代理已添加');
      setAddInput('');
      const ac = new AbortController();
      fetchStats(ac.signal);
    } catch {
      // handled by apiFetch
    } finally {
      setAdding(false);
    }
  };

  // ── Import proxies ──
  const handleImport = async () => {
    const lines = importText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    setImporting(true);
    try {
      await proxyAction('add-bulk', { proxyUrls: lines });
      toast.success(`已导入 ${lines.length} 个代理`);
      setImportText('');
      setImportDialogOpen(false);
      const ac = new AbortController();
      fetchStats(ac.signal);
    } catch {
      // handled by apiFetch
    } finally {
      setImporting(false);
    }
  };

  // ── Export proxies ──
  const handleExport = (format: 'url' | 'json') => {
    if (!stats?.proxies) return;
    let content = '';
    let filename = '';
    let mime = '';

    if (format === 'url') {
      content = stats.proxies.map((p) => p.url).join('\n');
      filename = 'proxies.txt';
      mime = 'text/plain';
    } else {
      content = JSON.stringify(stats.proxies, null, 2);
      filename = 'proxies.json';
      mime = 'application/json';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('代理列表已导出');
  };

  // ── Remove proxy ──
  const handleRemove = async (proxyUrl: string) => {
    setRemoving(proxyUrl);
    try {
      await proxyAction('remove', { proxyUrl });
      toast.success('代理已移除');
      const ac = new AbortController();
      fetchStats(ac.signal);
    } catch {
      // handled
    } finally {
      setRemoving(null);
    }
  };

  // ── Reset proxy ──
  const handleReset = async (proxyUrl: string) => {
    try {
      await proxyAction('reset', { proxyUrl });
      toast.success('代理已重置');
      const ac = new AbortController();
      fetchStats(ac.signal);
    } catch {
      // handled
    }
  };

  // ── Health check all ──
  const handleCheckAll = async () => {
    if (!stats?.proxies) return;
    setChecking(true);
    try {
      await proxyAction('check-all');
      toast.success('健康检查已启动');
      const ac = new AbortController();
      fetchStats(ac.signal);
    } catch {
      // handled
    } finally {
      setChecking(false);
    }
  };

  // ── Add domain binding ──
  const handleAddBinding = async () => {
    const domain = bindDomain.trim();
    const proxy = bindProxy.trim();
    if (!domain || !proxy) return;
    setBindingDomain(true);
    try {
      await proxyAction('bind-domain', { domain, proxyUrl: proxy });
      toast.success('域名绑定已添加');
      setBindDomain('');
      setBindProxy('');
      const ac = new AbortController();
      fetchBindings(ac.signal);
    } catch {
      // handled
    } finally {
      setBindingDomain(false);
    }
  };

  // ── Remove binding ──
  const handleRemoveBinding = async (domain: string) => {
    try {
      await proxyAction('unbind-domain', { domain });
      toast.success('域名绑定已移除');
      const ac = new AbortController();
      fetchBindings(ac.signal);
    } catch {
      // handled
    }
  };

  const avgHealth = stats?.avgHealth ?? 0;

  return (
    <Card className="glass-card">
      <CardHeader className="pb-2 pt-4 px-4 bg-gradient-to-b from-primary/5 to-transparent rounded-t-lg">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-medium flex items-center gap-2">
            <Globe className="h-3.5 w-3.5 text-primary" />
            代理池管理
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => { const ac = new AbortController(); setLoading(true); fetchStats(ac.signal); }}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        {loading ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            {/* ── Stats Bar ── */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border bg-background/50 p-2.5 text-center shadow-sm">
                <div className="text-lg font-bold">{stats?.total ?? 0}</div>
                <div className="text-[9px] text-muted-foreground">总代理</div>
              </div>
              <div className="rounded-lg border bg-background/50 p-2.5 text-center shadow-sm">
                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
                  {stats?.active ?? 0}
                </div>
                <div className="text-[9px] text-muted-foreground">活跃</div>
              </div>
              <div className="rounded-lg border bg-background/50 p-2.5 text-center shadow-sm">
                <div className="text-lg font-bold text-red-600 dark:text-red-400">
                  {stats?.disabled ?? 0}
                </div>
                <div className="text-[9px] text-muted-foreground">已禁用</div>
              </div>
            </div>

            {/* ── Average Health ── */}
            <div className="rounded-lg border bg-background/50 p-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] text-muted-foreground">平均健康度</span>
                <span className={`text-xs font-bold ${getHealthTextColor(avgHealth)}`}>
                  {avgHealth.toFixed(1)}%
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full bg-gradient-to-r ${getHealthGradient(avgHealth)} transition-all duration-300`}
                  style={{ width: `${avgHealth}%` }}
                />
              </div>
            </div>

            {/* ── Add Proxy ── */}
            <div className="flex items-center gap-2">
              <Input
                placeholder="socks5://user:pass@host:port"
                value={addInput}
                onChange={(e) => setAddInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                className="h-8 text-xs gap-1.5 shrink-0"
                onClick={handleAdd}
                disabled={adding || !addInput.trim()}
              >
                {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                添加
              </Button>
            </div>

            <Separator />

            {/* ── Bulk Actions Bar ── */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Import */}
              <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1.5">
                    <Upload className="h-3 w-3" />
                    批量导入
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle className="text-sm">批量导入代理</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3 mt-2">
                    <Textarea
                      placeholder="每行一个代理URL，例如：&#10;socks5://user:pass@host:port&#10;http://host:port&#10;https://user:pass@host:port"
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      rows={8}
                      className="text-xs font-mono"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setImportDialogOpen(false)}
                        className="text-xs"
                      >
                        取消
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleImport}
                        disabled={importing || !importText.trim()}
                        className="text-xs gap-1.5"
                      >
                        {importing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Upload className="h-3 w-3" />
                        )}
                        导入
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Export */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1.5">
                    <Download className="h-3 w-3" />
                    导出
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => handleExport('url')}>
                    URL列表 (.txt)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('json')}>
                    JSON格式 (.json)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Health Check */}
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[10px] gap-1.5"
                onClick={handleCheckAll}
                disabled={checking}
              >
                {checking ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Activity className="h-3 w-3" />
                )}
                健康检查
              </Button>
            </div>

            <Separator />

            {/* ── Proxy List ── */}
            <div className="space-y-1.5">
              <h4 className="text-[10px] text-muted-foreground font-medium">
                代理列表 ({stats?.proxies?.length ?? 0})
              </h4>
              <div className="max-h-72 overflow-y-auto scrollbar-thin space-y-1.5">
                {stats?.proxies && stats.proxies.length > 0 ? (
                  stats.proxies.map((proxy, idx) => (
                    <div
                      key={proxy.url}
                      className={`rounded-lg border border-l-2 border-l-transparent bg-background/50 p-2.5 space-y-1.5 group/proxy hover:border-l-primary hover:bg-muted/30 transition-all duration-200 ${idx % 2 === 0 ? '' : 'bg-muted/20'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {/* Protocol badge */}
                          <Badge
                            variant="outline"
                            className={`text-[9px] px-1.5 py-0 font-medium shrink-0 ${
                              PROTOCOL_COLORS[proxy.protocol] ?? 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {proxy.protocol}
                          </Badge>
                          <span className="text-[11px] font-mono truncate" title={proxy.url}>
                            {proxy.host}:{proxy.port}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Badge
                            variant="secondary"
                            className={`text-[9px] px-1.5 py-0 font-normal ${getStatusColor(proxy.status)}`}
                          >
                            {getStatusLabel(proxy.status)}
                          </Badge>
                        </div>
                      </div>

                      {/* Health bar + metrics */}
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          <span className={`text-[10px] font-bold ${getHealthTextColor(proxy.healthScore)}`}>
                            {proxy.healthScore}%
                          </span>
                          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full bg-gradient-to-r ${getHealthGradient(proxy.healthScore)} transition-all duration-300`}
                              style={{ width: `${proxy.healthScore}%` }}
                            />
                          </div>
                        </div>
                        <span className="text-[9px] text-muted-foreground shrink-0">
                          <CheckCircle2 className="h-2.5 w-2.5 inline text-emerald-500 mr-0.5" />
                          {proxy.successCount}
                        </span>
                        <span className="text-[9px] text-muted-foreground shrink-0">
                          <XCircle className="h-2.5 w-2.5 inline text-red-500 mr-0.5" />
                          {proxy.failCount}
                        </span>
                        <span className="text-[9px] text-muted-foreground shrink-0">
                          {proxy.avgResponseTime > 0 ? `${proxy.avgResponseTime}ms` : '-'}
                        </span>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 opacity-0 group-hover/proxy:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[9px] px-1.5 gap-1"
                          onClick={() => handleReset(proxy.url)}
                        >
                          <RefreshCw className="h-2.5 w-2.5" />
                          重置
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[9px] px-1.5 gap-1 text-red-500 hover:text-red-600"
                          onClick={() => handleRemove(proxy.url)}
                          disabled={removing === proxy.url}
                        >
                          {removing === proxy.url ? (
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-2.5 w-2.5" />
                          )}
                          移除
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center py-10 text-xs text-muted-foreground gap-3">
                    <div className="rounded-full bg-muted/50 p-3">
                      <Globe className="h-7 w-7 text-muted-foreground/40" />
                    </div>
                    <div className="text-center space-y-1">
                      <span className="text-sm font-medium text-muted-foreground">暂无代理</span>
                      <p className="text-[10px] text-muted-foreground/60">添加代理地址以开始使用代理池功能</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <Separator />

            {/* ── Domain Bindings ── */}
            <Collapsible open={bindingsOpen} onOpenChange={setBindingsOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-2 w-full text-left text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Link2 className="h-3 w-3" />
                  <span>域名绑定</span>
                  {bindings.length > 0 && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 font-normal ml-1">
                      {bindings.length}
                    </Badge>
                  )}
                  {bindingsLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                  <span className="ml-auto">
                    {bindingsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-3 space-y-3">
                  {/* Add binding row */}
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="域名 (例: example.com)"
                      value={bindDomain}
                      onChange={(e) => setBindDomain(e.target.value)}
                      className="h-7 text-[10px] flex-1"
                    />
                    <Select value={bindProxy} onValueChange={setBindProxy}>
                      <SelectTrigger className="h-7 text-[10px] w-44">
                        <SelectValue placeholder="选择代理" />
                      </SelectTrigger>
                      <SelectContent>
                        {stats?.proxies?.map((p) => (
                          <SelectItem key={p.url} value={p.url} className="text-[10px]">
                            {p.protocol}://{p.host}:{p.port}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="h-7 text-[10px] gap-1 shrink-0"
                      onClick={handleAddBinding}
                      disabled={bindingDomain || !bindDomain.trim() || !bindProxy}
                    >
                      {bindingDomain ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Link2 className="h-2.5 w-2.5" />}
                      绑定
                    </Button>
                  </div>

                  {/* Bindings list */}
                  <div className="space-y-1">
                    {bindings.length > 0 ? (
                      bindings.map((b) => (
                        <div
                          key={b.domain}
                          className="flex items-center justify-between rounded-md border bg-background/50 px-2.5 py-1.5 group/bind"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Link2 className="h-3 w-3 text-primary shrink-0" />
                            <span className="text-[10px] font-medium truncate">{b.domain}</span>
                            <span className="text-[9px] text-muted-foreground truncate font-mono">
                              → {b.proxyUrl}
                            </span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0 opacity-0 group-hover/bind:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                            onClick={() => handleRemoveBinding(b.domain)}
                          >
                            <Unlink className="h-3 w-3" />
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className="text-[10px] text-muted-foreground text-center py-3">
                        暂无域名绑定
                      </p>
                    )}
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </CardContent>
    </Card>
  );
}
