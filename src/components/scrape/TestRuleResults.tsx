'use client';

import React from 'react';
import { motion } from 'framer-motion';
import {
  CheckCircle,
  XCircle,
  Clock,
  FileCode,
  Layers,
  Gauge,
  Timer,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  Zap,
  ArrowDownToLine,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

// ==================== Types ====================

export interface TestRuleResult {
  success: boolean;
  statusCode?: number;
  responseTimeMs?: number;
  htmlSizeBytes?: number;
  engine?: string;
  extractedItemsCount?: number;
  rateLimit?: {
    isLimited: boolean;
    currentRpm: number;
    maxRpm: number;
  };
  currentDelayMs?: number;
  antiCrawlSignals?: string[];
  requestHeaders?: Record<string, string>;
  errorMessage?: string;
}

// ==================== Helpers ====================

function formatBytes(bytes: number | undefined): string {
  if (bytes == null) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getResponseTimeColor(ms: number | undefined): string {
  if (ms == null) return 'text-muted-foreground';
  if (ms < 2000) return 'text-emerald-600 dark:text-emerald-400';
  if (ms < 5000) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

function getResponseTimeLabel(ms: number | undefined): string {
  if (ms == null) return '--';
  if (ms < 2000) return '正常';
  if (ms < 5000) return '偏慢';
  return '超时';
}

function getStatusCodeColor(code: number | undefined): string {
  if (!code) return 'text-muted-foreground';
  if (code >= 200 && code < 300) return 'text-emerald-600 dark:text-emerald-400';
  if (code >= 300 && code < 400) return 'text-sky-600 dark:text-sky-400';
  if (code === 429) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

// ==================== Metric Card ====================

interface MetricCardProps {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  colorClass?: string;
  index?: number;
}

function MetricCard({ icon: Icon, label, value, colorClass, index = 0 }: MetricCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.06, ease: 'easeOut' }}
    >
      <Card className="py-4 px-4 gap-3">
        <CardContent className="p-0 flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 dark:bg-primary/15">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground leading-tight">{label}</p>
            <p className={`text-sm font-semibold mt-0.5 truncate ${colorClass ?? 'text-foreground'}`}>
              {value}
            </p>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ==================== Collapsible Section ====================

interface CollapsibleSectionProps {
  title: string;
  icon: React.ElementType;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
  index?: number;
}

function CollapsibleSection({ title, icon: Icon, count, children, defaultOpen = false, index = 0 }: CollapsibleSectionProps) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.06, ease: 'easeOut' }}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="w-full">
          <Card className="py-3 px-4 gap-0 hover:bg-muted/30 transition-colors cursor-pointer">
            <CardContent className="p-0 flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon className="h-4 w-4 text-muted-foreground" />
              </div>
              <span className="text-sm font-medium flex-1 text-left">{title}</span>
              {count != null && (
                <Badge variant="secondary" className="text-xs mr-1">
                  {count}
                </Badge>
              )}
              {open ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </CardContent>
          </Card>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="pl-4 pr-1 pt-2 pb-1">
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </motion.div>
  );
}

// ==================== Main Component ====================

interface TestRuleResultsProps {
  result: TestRuleResult;
}

export function TestRuleResults({ result }: TestRuleResultsProps) {
  const metricsStartIndex = 6; // start stagger index after status + main metrics

  return (
    <div className="space-y-3" role="region" aria-label="测试结果">
      {/* Status Banner */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className={`flex items-center gap-3 rounded-lg border p-3 ${
          result.success
            ? 'border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/10'
            : 'border-red-500/30 bg-red-500/5 dark:bg-red-500/10'
        }`}
      >
        {result.success ? (
          <CheckCircle className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <XCircle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant={result.success ? 'default' : 'destructive'} className="text-xs">
              {result.success ? '成功' : '失败'}
            </Badge>
            {result.statusCode && (
              <Badge variant="outline" className={`text-xs font-mono ${getStatusCodeColor(result.statusCode)}`}>
                {result.statusCode}
              </Badge>
            )}
          </div>
          {!result.success && result.errorMessage && (
            <p className="text-xs text-red-600/80 dark:text-red-400/80 mt-1 truncate" title={result.errorMessage}>
              {result.errorMessage}
            </p>
          )}
        </div>
      </motion.div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {/* Response Time */}
        <MetricCard
          icon={Clock}
          label="响应时间"
          index={0}
          colorClass={getResponseTimeColor(result.responseTimeMs)}
          value={
            <span className="flex items-center gap-1.5">
              {result.responseTimeMs != null ? `${result.responseTimeMs} ms` : '--'}
              {result.responseTimeMs != null && (
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1 py-0 font-normal ${getResponseTimeColor(result.responseTimeMs)}`}
                >
                  {getResponseTimeLabel(result.responseTimeMs)}
                </Badge>
              )}
            </span>
          }
        />

        {/* HTML Size */}
        <MetricCard
          icon={FileCode}
          label="页面大小"
          index={1}
          value={formatBytes(result.htmlSizeBytes)}
        />

        {/* Engine */}
        <MetricCard
          icon={Zap}
          label="引擎"
          index={2}
          value={result.engine ? (
            <Badge variant="secondary" className="text-xs font-normal">
              {result.engine}
            </Badge>
          ) : '--'}
        />

        {/* Extracted Items */}
        <MetricCard
          icon={Layers}
          label="提取项目数"
          index={3}
          value={
            result.extractedItemsCount != null ? (
              <span className="flex items-center gap-1.5">
                {result.extractedItemsCount}
                <span className="text-xs text-muted-foreground font-normal">条</span>
              </span>
            ) : '--'
          }
        />

        {/* Rate Limit */}
        <MetricCard
          icon={Gauge}
          label="频率限制"
          index={4}
          value={
            result.rateLimit ? (
              <span className="flex items-center gap-1.5">
                <Badge
                  variant={result.rateLimit.isLimited ? 'destructive' : 'outline'}
                  className="text-[10px] px-1 py-0 font-normal"
                >
                  {result.rateLimit.isLimited ? '已限流' : '正常'}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {result.rateLimit.currentRpm}/{result.rateLimit.maxRpm} RPM
                </span>
              </span>
            ) : '--'
          }
        />

        {/* Current Delay */}
        <MetricCard
          icon={Timer}
          label="当前延迟"
          index={5}
          value={
            result.currentDelayMs != null
              ? `${result.currentDelayMs} ms`
              : '--'
          }
        />
      </div>

      {/* Anti-Crawl Signals (Collapsible) */}
      {result.antiCrawlSignals && result.antiCrawlSignals.length > 0 && (
        <CollapsibleSection
          title="反爬信号"
          icon={ShieldAlert}
          count={result.antiCrawlSignals.length}
          defaultOpen={true}
          index={metricsStartIndex}
        >
          <div className="space-y-1.5">
            {result.antiCrawlSignals.map((signal, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: metricsStartIndex * 0.06 + i * 0.05 }}
                className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 dark:bg-amber-500/10 px-3 py-2"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
                <span className="text-xs text-amber-700 dark:text-amber-300 truncate">
                  {signal}
                </span>
              </motion.div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Request Headers (Collapsible) */}
      {result.requestHeaders && Object.keys(result.requestHeaders).length > 0 && (
        <CollapsibleSection
          title="请求头"
          icon={ArrowDownToLine}
          count={Object.keys(result.requestHeaders).length}
          defaultOpen={false}
          index={metricsStartIndex + 1}
        >
          <div className="rounded-lg border bg-muted/30 dark:bg-muted/20 divide-y">
            {Object.entries(result.requestHeaders).map(([key, val], i) => (
              <motion.div
                key={key}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2, delay: (metricsStartIndex + 1) * 0.06 + i * 0.03 }}
                className="flex items-baseline gap-2 px-3 py-1.5 text-xs"
              >
                <span className="font-mono font-medium text-muted-foreground shrink-0">
                  {key}:
                </span>
                <span className="font-mono text-foreground/80 truncate">
                  {val}
                </span>
              </motion.div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}
