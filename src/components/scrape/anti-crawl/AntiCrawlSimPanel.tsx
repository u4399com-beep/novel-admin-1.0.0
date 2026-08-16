'use client';

import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FlaskConical, Loader2, CheckCircle, XCircle,
  Lightbulb, ChevronDown, ChevronRight, Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SimCheck {
  name: string;
  passed: boolean;
  detail: string;
}

interface SimulateResult {
  targetUrl: string;
  domain: string;
  selectedEngine: string;
  checks: SimCheck[];
  score: number;
  grade: string;
  headers: Record<string, string>;
  recommendations: string[];
  serviceReachable?: boolean;
}

// ─── Grade Colors ─────────────────────────────────────────────────────────────

const GRADE_STYLES: Record<string, { text: string; ring: string; bg: string }> = {
  A: { text: 'text-emerald-600 dark:text-emerald-400', ring: 'border-emerald-500/50', bg: 'bg-emerald-500/10' },
  B: { text: 'text-sky-600 dark:text-sky-400', ring: 'border-sky-500/50', bg: 'bg-sky-500/10' },
  C: { text: 'text-amber-600 dark:text-amber-400', ring: 'border-amber-500/50', bg: 'bg-amber-500/10' },
  D: { text: 'text-red-600 dark:text-red-400', ring: 'border-red-500/50', bg: 'bg-red-500/10' },
};

// ─── Component ───────────────────────────────────────────────────────────────

export function AntiCrawlSimPanel() {
  const [targetUrl, setTargetUrl] = useState('');
  const [engine, setEngine] = useState('cheerio');
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [headersExpanded, setHeadersExpanded] = useState(false);
  const acRef = useRef<AbortController | null>(null);

  const handleSimulate = useCallback(async () => {
    if (!targetUrl.trim()) return;

    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;

    setLoading(true);
    setResult(null);
    setHeadersExpanded(false);

    try {
      const data = await apiFetch<SimulateResult>('/api/admin/scraper/anti-crawl-simulate', {
        method: 'POST',
        body: JSON.stringify({ targetUrl: targetUrl.trim(), engine }),
        signal: ac.signal,
        timeout: 12000,
        silent: true,
      });
      if (!ac.signal.aborted) {
        setResult(data);
      }
    } catch {
      // handled silently
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [targetUrl, engine]);

  const gradeStyle = result ? (GRADE_STYLES[result.grade] || GRADE_STYLES.D) : null;

  return (
    <Card className="overflow-hidden">
      {/* Header with gradient background */}
      <div className="bg-gradient-to-r from-emerald-500/10 to-teal-500/10">
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-xs font-medium flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            反爬策略仿真测试
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            输入目标URL，模拟检测反爬配置的完整度
          </p>
        </CardHeader>
      </div>

      <CardContent className="px-4 pb-4 space-y-4">
        {/* Input section */}
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="输入目标站点URL，如 https://www.qidian.com"
              className="h-8 text-xs font-mono"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSimulate(); }}
              disabled={loading}
            />
            <div className="flex items-center gap-2 shrink-0">
              <Select value={engine} onValueChange={setEngine} disabled={loading}>
                <SelectTrigger className="h-8 w-[110px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cheerio">cheerio</SelectItem>
                  <SelectItem value="playwright">playwright</SelectItem>
                  <SelectItem value="obscura">obscura</SelectItem>
                  <SelectItem value="auto">auto</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={handleSimulate}
                disabled={loading || !targetUrl.trim()}
                className="h-8 px-3 text-xs shrink-0"
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                <span className="ml-1.5">开始仿真</span>
              </Button>
            </div>
          </div>
        </div>

        {/* Results section */}
        <AnimatePresence>
          {result && (
            <motion.div
              key="sim-result"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="space-y-4"
            >
              {/* Score card (centered) */}
              <div className="flex flex-col items-center py-3">
                {/* Ring + Grade */}
                <div className={`relative w-24 h-24 rounded-full border-4 ${gradeStyle?.ring} flex items-center justify-center ${gradeStyle?.bg} transition-colors duration-500`}>
                  <span className={`text-4xl font-extrabold ${gradeStyle?.text}`}>
                    {result.grade}
                  </span>
                </div>
                {/* Score number */}
                <p className={`text-2xl font-bold mt-2 ${gradeStyle?.text}`}>
                  {result.score}<span className="text-sm font-normal text-muted-foreground">/100</span>
                </p>
                {/* Domain + Engine */}
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0">
                    {result.domain}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {result.selectedEngine}
                  </Badge>
                </div>
              </div>

              {/* Check list grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {result.checks.map((check, i) => {
                  const isPassed = check.passed;
                  return (
                    <motion.div
                      key={check.name}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 * i, duration: 0.25 }}
                      className={`rounded-lg border-l-3 px-3 py-2.5 ${
                        isPassed
                          ? 'border-l-emerald-500 bg-emerald-500/5'
                          : 'border-l-red-500 bg-red-500/5'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 shrink-0">
                          {isPassed
                            ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                            : <XCircle className="h-3.5 w-3.5 text-red-500" />
                          }
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-medium leading-tight">{check.name}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{check.detail}</p>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>

              {/* Headers preview (collapsible) */}
              {Object.keys(result.headers).length > 0 && (
                <div className="rounded-lg border overflow-hidden">
                  <button
                    onClick={() => setHeadersExpanded(!headersExpanded)}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors text-left"
                  >
                    <span className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                      <Search className="h-3 w-3" />
                      请求头预览
                    </span>
                    {headersExpanded
                      ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      : <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    }
                  </button>
                  <AnimatePresence>
                    {headersExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="border-t px-3 py-2 space-y-1 bg-muted/10">
                          {Object.entries(result.headers).map(([key, value]) => (
                            <div key={key} className="flex items-start gap-2 font-mono text-[10px]">
                              <span className="text-muted-foreground shrink-0 min-w-[120px] sm:min-w-[160px] truncate" title={key}>
                                {key}:
                              </span>
                              <span className="text-foreground/70 truncate" title={value}>
                                {value}
                              </span>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Recommendations */}
              {result.recommendations.length > 0 && (
                <div className="space-y-2">
                  {result.recommendations.map((rec, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.15 * i + 0.3, duration: 0.25 }}
                      className="flex items-start gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5"
                    >
                      <Lightbulb className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">{rec}</p>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
