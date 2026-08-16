'use client';

import { useState, useCallback, useRef } from 'react';
import {
  BrainCircuit, Loader2,
  ShieldAlert, Ban, Timer, ExternalLink, FileX, Clock, ScanEye, Puzzle,
  Shield, ArrowRight, Copy, Search, Zap, FlaskConical,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-fetch';
import { RuleSelector } from './RuleSelector';
import { CollapsiblePanel } from './CollapsiblePanel';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DetectionSignal {
  type: 'captcha' | 'block' | 'rate_limit' | 'redirect' | 'empty_content' | 'slow_response' | 'fingerprint_detect' | 'js_challenge';
  domain: string;
  count: number;
  lastSeen: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details?: string;
}

interface Recommendation {
  id: string;
  category: 'engine' | 'proxy' | 'delay' | 'stealth' | 'captcha' | 'rate_limit' | 'cookie' | 'session';
  priority: number;
  title: string;
  description: string;
  configKey: string;
  currentValue: unknown;
  recommendedValue: unknown;
  reasoning: string;
  estimatedImpact: 'high' | 'medium' | 'low';
}

interface AdvisorReport {
  domain: string;
  threatLevel: 'minimal' | 'low' | 'medium' | 'high' | 'critical';
  signals: DetectionSignal[];
  recommendations: Recommendation[];
  currentConfig: Record<string, unknown>;
  score: number;
  potentialScore: number;
  serviceReachable?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const THREAT_STYLES: Record<string, { bg: string; border: string; icon: string; label: string }> = {
  minimal: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', icon: 'text-emerald-600 dark:text-emerald-400', label: '极低' },
  low: { bg: 'bg-sky-500/10', border: 'border-sky-500/30', icon: 'text-sky-600 dark:text-sky-400', label: '低' },
  medium: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', icon: 'text-amber-600 dark:text-amber-400', label: '中' },
  high: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', icon: 'text-orange-600 dark:text-orange-400', label: '高' },
  critical: { bg: 'bg-red-500/10', border: 'border-red-500/30', icon: 'text-red-600 dark:text-red-400', label: '严重' },
};

const SEVERITY_STYLES: Record<string, { bg: string; text: string }> = {
  low: { bg: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', text: 'text-emerald-600' },
  medium: { bg: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', text: 'text-sky-600' },
  high: { bg: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', text: 'text-amber-600' },
  critical: { bg: 'bg-red-500/15 text-red-700 dark:text-red-300', text: 'text-red-600' },
};

const SIGNAL_ICONS: Record<string, typeof ShieldAlert> = {
  captcha: ShieldAlert,
  block: Ban,
  rate_limit: Timer,
  redirect: ExternalLink,
  empty_content: FileX,
  slow_response: Clock,
  fingerprint_detect: ScanEye,
  js_challenge: Puzzle,
};

const SIGNAL_LABELS: Record<string, string> = {
  captcha: 'CAPTCHA',
  block: '403拦截',
  rate_limit: '速率限制',
  redirect: '重定向',
  empty_content: '空内容',
  slow_response: '响应缓慢',
  fingerprint_detect: '指纹检测',
  js_challenge: 'JS挑战',
};

// Left-side colored bar per signal type (8 types, 8 colors)
const SIGNAL_BAR_COLORS: Record<string, string> = {
  captcha: 'bg-red-500',
  block: 'bg-rose-600',
  rate_limit: 'bg-amber-500',
  redirect: 'bg-sky-500',
  empty_content: 'bg-gray-400',
  slow_response: 'bg-orange-500',
  fingerprint_detect: 'bg-violet-500',
  js_challenge: 'bg-teal-500',
};

const CATEGORY_LABELS: Record<string, string> = {
  engine: '引擎', proxy: '代理', delay: '延迟', stealth: '隐身',
  captcha: '验证码', rate_limit: '速率', cookie: 'Cookie', session: '会话',
};

const CATEGORY_COLORS: Record<string, string> = {
  engine: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  proxy: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  delay: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  stealth: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  captcha: 'bg-red-500/15 text-red-700 dark:text-red-300',
  rate_limit: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  cookie: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  session: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeAgo(ts: number): string {
  if (!ts) return '未知';
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function priorityColor(p: number): string {
  if (p > 80) return 'bg-red-500';
  if (p > 50) return 'bg-amber-500';
  if (p > 20) return 'bg-sky-500';
  return 'bg-emerald-500';
}

function scoreColor(s: number): string {
  if (s >= 80) return 'text-emerald-600 dark:text-emerald-400';
  if (s >= 60) return 'text-sky-600 dark:text-sky-400';
  if (s >= 40) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function barColor(s: number): string {
  if (s >= 80) return 'bg-emerald-500';
  if (s >= 60) return 'bg-sky-500';
  if (s >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AntiCrawlAdvisorPanel() {
  const [domain, setDomain] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [report, setReport] = useState<AdvisorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const acRef = useRef<AbortController | null>(null);

  // Rule selector state
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);

  const handleRuleSelect = useCallback((ruleId: string, domainFromRule: string) => {
    setSelectedRuleId(ruleId);
    if (domainFromRule) {
      setDomain(domainFromRule);
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    const d = domain.trim();
    if (!d) return;
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const data = await apiFetch<AdvisorReport>('/api/admin/scraper/anti-crawl-advise', {
        method: 'POST',
        body: JSON.stringify({ domain: d }),
        signal: ac.signal,
        timeout: 10000,
        silent: true,
      });
      if (!ac.signal.aborted) {
        setReport(data);
        if (!expanded) setExpanded(true);
      }
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : '分析失败');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [domain, expanded]);

  // Analyze based on the selected rule (calls rule-specific advisor endpoint)
  const handleAnalyzeRule = useCallback(async () => {
    if (!selectedRuleId) return;
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const data = await apiFetch<AdvisorReport>(`/api/scrape-rules/${selectedRuleId}/advisor-analyze`, {
        method: 'POST',
        signal: ac.signal,
        timeout: 20000,
        silent: true,
      });
      if (!ac.signal.aborted) {
        setReport(data);
        // Update domain from the report
        if (data.domain) setDomain(data.domain);
        if (!expanded) setExpanded(true);
      }
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : '规则分析失败');
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [selectedRuleId, expanded]);

  // One-click apply all recommendations to the selected rule
  const handleApplyAll = useCallback(async () => {
    if (!selectedRuleId || !report || report.recommendations.length === 0) return;
    setApplying(true);
    try {
      const recommendations = report.recommendations.map((rec) => ({
        configKey: rec.configKey,
        recommendedValue: rec.recommendedValue,
      }));
      const result = await apiFetch<{ success: boolean; appliedCount: number }>(
        `/api/scrape-rules/${selectedRuleId}/apply-advisor`,
        {
          method: 'PUT',
          body: JSON.stringify({ recommendations }),
          timeout: 10000,
          silent: true,
        },
      );
      if (result.success) {
        toast.success(`已成功应用 ${result.appliedCount} 条建议到规则`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '应用建议失败');
    } finally {
      setApplying(false);
    }
  }, [selectedRuleId, report]);

  const handleCopy = useCallback((rec: Recommendation) => {
    const text = `${rec.configKey}: ${JSON.stringify(rec.recommendedValue)}`;
    navigator.clipboard.writeText(text).then(() => {
      toast.success('配置已复制到剪贴板');
    }).catch(() => {
      toast.error('复制失败，请手动复制');
    });
  }, []);

  const threat = report ? THREAT_STYLES[report.threatLevel] : null;

  // Find the most recent signal index
  const mostRecentSignalIdx = report?.signals?.reduce((bestIdx, sig, idx, arr) => {
    if (bestIdx < 0) return idx;
    return sig.lastSeen > arr[bestIdx].lastSeen ? idx : bestIdx;
  }, -1) ?? -1;

  return (
    <CollapsiblePanel
      icon={BrainCircuit}
      title="智能反爬顾问"
      loading={loading}
      expanded={expanded}
      onExpandedChange={setExpanded}
      badges={report ? (
        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 font-normal ${threat?.border} ${threat?.bg}`}>
          {threat?.label}
        </Badge>
      ) : undefined}
    >
      {/* Rule selector */}
      <RuleSelector
        selectedRuleId={selectedRuleId}
        onSelect={handleRuleSelect}
      />

      {/* Domain input + analyze buttons */}
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="输入域名，如 www.qidian.com"
          className="h-8 text-xs font-mono flex-1"
          onKeyDown={(e) => { if (e.key === 'Enter') handleAnalyze(); }}
          disabled={loading}
        />
        <div className="flex gap-2 shrink-0">
          <Button
            onClick={handleAnalyze}
            disabled={loading || !domain.trim()}
            className="h-8 px-3 text-xs"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
            <span className="ml-1.5">分析</span>
          </Button>
          {selectedRuleId && (
            <Button
              onClick={handleAnalyzeRule}
              disabled={loading}
              variant="outline"
              className="h-8 px-3 text-xs"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
              <span className="ml-1.5">分析规则</span>
            </Button>
          )}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center justify-between rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={handleAnalyze}>重试</Button>
        </div>
      )}

      {/* Report */}
      {report && !loading && (
        <div className="space-y-4 cp-fade-in">
          {/* Threat card */}
          <div className={`rounded-lg border ${threat?.border} ${threat?.bg} p-4`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Shield className={`h-8 w-8 ${threat?.icon}`} />
                <div>
                  <p className="text-sm font-semibold">{report.domain}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className={`text-[10px] font-medium ${threat?.icon}`}>威胁等级: {threat?.label}</span>
                    {report.signals.length > 0 && (
                      <Badge variant="secondary" className="text-[9px] px-1 py-0 font-normal">
                        {report.signals.length} 个信号
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="flex items-baseline gap-1">
                  <span className={`text-2xl font-bold ${scoreColor(report.score)}`}>{report.score}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className={`text-2xl font-bold ${scoreColor(report.potentialScore)}`}>{report.potentialScore}</span>
                </div>
                <p className="text-[10px] text-muted-foreground">当前 / 潜在分数</p>
              </div>
            </div>
            {/* Score bars */}
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-10 shrink-0">当前</span>
                <div className="flex-1 h-2 rounded-full bg-muted/50 overflow-hidden">
                  <span className={`block h-full rounded-full ${barColor(report.score)}`} style={{ width: `${report.score}%` }} />
                </div>
                <span className="text-[10px] font-mono w-8 text-right">{report.score}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-10 shrink-0">潜在</span>
                <div className="flex-1 h-2 rounded-full bg-muted/50 overflow-hidden">
                  <span className={`block h-full rounded-full ${barColor(report.potentialScore)}`} style={{ width: `${report.potentialScore}%` }} />
                </div>
                <span className="text-[10px] font-mono w-8 text-right">{report.potentialScore}</span>
              </div>
            </div>
          </div>

          {/* Signals with enhanced timeline */}
          {report.signals.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                <ShieldAlert className="h-3 w-3" />
                检测信号
              </p>
              <div className="max-h-48 overflow-y-auto scrollbar-thin space-y-1.5">
                {report.signals.map((signal, i) => {
                  const Icon = SIGNAL_ICONS[signal.type] || ShieldAlert;
                  const sevStyle = SEVERITY_STYLES[signal.severity];
                  const isMostRecent = i === mostRecentSignalIdx;
                  const barColorClass = SIGNAL_BAR_COLORS[signal.type] || 'bg-gray-500';
                  return (
                    <div
                      key={`${signal.type}-${i}`}
                      className="flex items-stretch rounded-md border bg-background/50 overflow-hidden"
                      style={{
                        animation: `cp-signal-slide-in 0.3s ease-out ${0.05 * i}s both`,
                      }}
                    >
                      {/* Left-side colored bar */}
                      <div className={`w-1 shrink-0 ${barColorClass}`} />
                      <div className="flex items-center gap-2.5 px-3 py-2 flex-1 min-w-0">
                        <div className="relative shrink-0">
                          <Icon className={`h-3.5 w-3.5 ${sevStyle.text}`} />
                          {/* Pulsing dot for most recent signal */}
                          {isMostRecent && (
                            <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary cp-dot-pulse" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium">{SIGNAL_LABELS[signal.type] || signal.type}</span>
                            <Badge className={`text-[9px] px-1 py-0 font-normal ${sevStyle.bg}`}>{signal.severity}</Badge>
                          </div>
                          {signal.details && (
                            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{signal.details}</p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-[10px] font-mono">x{signal.count}</p>
                          <p className="text-[9px] text-muted-foreground">{formatTimeAgo(signal.lastSeen)}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recommendations */}
          {report.recommendations.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                <BrainCircuit className="h-3 w-3" />
                优化建议 ({report.recommendations.length})
              </p>
              <div className="max-h-64 overflow-y-auto scrollbar-thin space-y-2">
                {report.recommendations.map((rec, i) => (
                  <div
                    key={rec.id}
                    className="rounded-lg border bg-background/50 p-3 space-y-2"
                    style={{
                      animation: `cp-rec-fade-in 0.3s ease-out ${0.06 * i}s both`,
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className={`w-1 h-4 rounded-full ${priorityColor(rec.priority)}`} />
                        <Badge className={`text-[9px] px-1.5 py-0 font-normal ${CATEGORY_COLORS[rec.category] || ''}`}>
                          {CATEGORY_LABELS[rec.category] || rec.category}
                        </Badge>
                        <span className="text-[11px] font-semibold">{rec.title}</span>
                      </div>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono">P{rec.priority}</Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">{rec.description}</p>
                    <div className="flex items-center gap-2 text-[10px]">
                      <span className="text-muted-foreground shrink-0">当前值:</span>
                      <code className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-foreground/70 truncate max-w-[140px]">
                        {formatValue(rec.currentValue)}
                      </code>
                      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground shrink-0">推荐值:</span>
                      <code className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono text-primary truncate max-w-[140px]">
                        {formatValue(rec.recommendedValue)}
                      </code>
                    </div>
                    <div className="flex items-center justify-end">
                      <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => handleCopy(rec)}>
                        <Copy className="h-3 w-3 mr-1" />
                        复制
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* One-click apply all button */}
              <div className="pt-2">
                <Button
                  onClick={handleApplyAll}
                  disabled={!selectedRuleId || applying || report.recommendations.length === 0}
                  className="w-full h-9 text-xs font-medium gap-2"
                  variant="default"
                >
                  {applying ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  {applying ? '正在应用...' : '一键应用全部建议'}
                </Button>
                {!selectedRuleId && (
                  <p className="text-[10px] text-muted-foreground text-center mt-1.5">
                    请先选择一个采集规则以启用一键应用
                  </p>
                )}
              </div>
            </div>
          )}

          {/* No signals, no recommendations */}
          {report.signals.length === 0 && report.recommendations.length === 0 && (
            <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
              <Shield className="h-6 w-6 mb-1.5 opacity-40" />
              <p className="text-[11px]">该域名暂无检测信号，配置良好</p>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!report && !loading && !error && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <BrainCircuit className="h-8 w-8 mb-2 opacity-30" />
          <p className="text-xs">输入域名开始智能反爬分析</p>
          <p className="text-[10px] mt-1 opacity-60">基于实际采集历史和检测信号生成建议</p>
        </div>
      )}
    </CollapsiblePanel>
  );
}
