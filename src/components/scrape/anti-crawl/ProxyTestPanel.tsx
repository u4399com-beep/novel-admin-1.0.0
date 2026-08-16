'use client';

import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Zap, Loader2, ChevronDown, ChevronRight, CheckCircle, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProxyTestResult {
  url: string;
  protocol?: string;
  host?: string;
  port?: number;
  reachable: boolean;
  responseTime?: number;
  statusCode?: number;
  error?: string;
  testUrl?: string;
  testTimestamp?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getProtocolColor(protocol?: string): string {
  if (!protocol) return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  switch (protocol.toLowerCase()) {
    case 'https': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'http': return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
    case 'socks5': return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

function getResponseTimeColor(ms?: number): string {
  if (ms == null) return 'text-muted-foreground';
  if (ms < 500) return 'text-green-600 dark:text-green-400';
  if (ms <= 2000) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function truncateUrl(url: string, maxLen: number = 50): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen) + '...';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ProxyTestPanel() {
  const [expanded, setExpanded] = useState(false);
  const [results, setResults] = useState<ProxyTestResult[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [progress, setProgress] = useState('');

  const handleTestAll = useCallback(async () => {
    setTesting(true);
    setProgress('正在测试...');
    setResults(null);
    try {
      const data = await apiFetch<ProxyTestResult[]>('/api/admin/scraper/proxy-test-all', {
        method: 'POST',
        body: JSON.stringify({}),
        timeout: 30000,
        silent: true,
      });
      setResults(data || []);
      setProgress('');
    } catch {
      setResults([]);
      setProgress('');
    } finally {
      setTesting(false);
    }
  }, []);

  const successCount = results?.filter(r => r.reachable).length ?? 0;
  const totalCount = results?.length ?? 0;
  const avgTime = results && results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + (r.responseTime ?? 0), 0) / results.length)
    : 0;

  return (
    <div className="rounded-lg border bg-background/50 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <Zap className="h-4 w-4 text-primary" />
          <span className="text-xs font-medium">代理连通性测试</span>
          {results && (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
              {successCount}/{totalCount} 可用
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
      </button>

      {/* Expandable content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t px-4 py-3 space-y-3">
              {/* Actions */}
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground">
                  {testing ? progress : (results === null ? '点击「测试全部」检测所有代理的连通性' : `共测试 ${totalCount} 个代理`)}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[11px] px-2"
                    onClick={handleTestAll}
                    disabled={testing}
                  >
                    {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                    <span className="ml-1">测试全部</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[11px] px-2 opacity-50"
                    disabled
                  >
                    测试选中
                  </Button>
                </div>
              </div>

              {/* Progress indicator */}
              {testing && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/30">
                  <Loader2 className="h-3 w-3 animate-spin text-primary" />
                  <span className="text-[11px] text-muted-foreground">{progress}</span>
                </div>
              )}

              {/* Results list */}
              {results && results.length > 0 && (
                <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin">
                  {results.map((r, i) => (
                    <div
                      key={`${r.url}-${i}`}
                      className="flex items-center justify-between rounded-md border bg-background/50 px-3 py-2"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {r.reachable
                          ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
                          : <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                        }
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium truncate" title={r.url}>
                            {truncateUrl(r.url)}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {r.protocol && (
                              <Badge
                                variant="secondary"
                                className={`text-[9px] px-1 py-0 font-normal ${getProtocolColor(r.protocol)}`}
                              >
                                {r.protocol}
                              </Badge>
                            )}
                            {r.responseTime != null && (
                              <span className={`text-[9px] font-mono ${getResponseTimeColor(r.responseTime)}`}>
                                {r.responseTime}ms
                              </span>
                            )}
                            {r.error && (
                              <span className="text-[9px] text-muted-foreground truncate max-w-[140px]" title={r.error}>
                                {r.error}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Summary stats row */}
              {results && results.length > 0 && (
                <div className="flex items-center gap-4 text-[10px] text-muted-foreground pt-1 border-t">
                  <span>总计 <strong className="text-foreground">{totalCount}</strong></span>
                  <span>成功 <strong className="text-green-600 dark:text-green-400">{successCount}</strong></span>
                  {avgTime > 0 && <span>平均 <strong className="text-foreground">{avgTime}ms</strong></span>}
                </div>
              )}

              {/* Empty state (service returned empty array) */}
              {results && results.length === 0 && !testing && (
                <div className="text-[11px] text-muted-foreground text-center py-4">
                  暂无代理配置，请先添加代理
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}