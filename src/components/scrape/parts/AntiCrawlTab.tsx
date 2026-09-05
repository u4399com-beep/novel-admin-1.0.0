'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiFetch, FetchError } from '@/lib/api-fetch';
import { safeHostname } from '@/lib/utils';
import { RefreshCw, Shield, Activity, Server, Clock, Info, TriangleAlert, CheckCircle2, User } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { EditorFormAccess } from './types';

// ==================== Types ====================

interface ProxyPoolStats {
  totalProxies: number;
  activeProxies: number;
  coolingProxies: number;
  disabledProxies: number;
  avgHealthScore: number;
  avgResponseTime: number;
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;
  topProxies: Array<{
    url: string;
    host: string;
    healthScore: number;
    successCount: number;
    failCount: number;
    avgResponseTime: number;
  }>;
  serviceReachable?: boolean;
}

interface DomainDelayStats {
  domain: string;
  currentDelay: number;
  backoffLevel: number;
  consecutiveErrors: number;
  avgResponseTime: number;
  lastRequestTime: number;
  status: 'normal' | 'warning' | 'backoff' | 'critical';
}

interface DelayStatsResponse {
  domains: DomainDelayStats[];
  totalDomains: number;
  serviceReachable?: boolean;
}

// ==================== Helpers ====================

const CLOUDFLARE_DOMAIN_PATTERNS = ['cloudflare', 'cf-', 'cloudns', 'cloudfront'];

function detectCloudflare(url: string): boolean {
  const hostname = safeHostname(url).toLowerCase();
  return hostname !== '' && CLOUDFLARE_DOMAIN_PATTERNS.some(p => hostname.includes(p));
}

function healthColor(score: number): string {
  if (score >= 70) return 'text-green-600 dark:text-green-400';
  if (score >= 40) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function healthBgColor(score: number): string {
  if (score >= 70) return 'bg-green-500';
  if (score >= 40) return 'bg-yellow-500';
  return 'bg-red-500';
}

function statusColor(status: DomainDelayStats['status']): { text: string; bg: string; label: string } {
  switch (status) {
    case 'normal': return { text: 'text-green-700 dark:text-green-400', bg: 'bg-green-100 dark:bg-green-900/30', label: '正常' };
    case 'warning': return { text: 'text-yellow-700 dark:text-yellow-400', bg: 'bg-yellow-100 dark:bg-yellow-900/30', label: '注意' };
    case 'backoff': return { text: 'text-orange-700 dark:text-orange-400', bg: 'bg-orange-100 dark:bg-orange-900/30', label: '退避' };
    case 'critical': return { text: 'text-red-700 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/30', label: '严重' };
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

// ==================== Sub-Components ====================

function ProxyPoolPanel() {
  const [stats, setStats] = useState<ProxyPoolStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<ProxyPoolStats>('/api/admin/scraper/proxy-stats', { silent: true, timeout: 6000 });
      setStats(data);
    } catch (err) {
      if (err instanceof FetchError && err.status === 0) {
        setStats({
          totalProxies: 0, activeProxies: 0, coolingProxies: 0, disabledProxies: 0,
          avgHealthScore: 0, avgResponseTime: 0, totalSuccesses: 0, totalFailures: 0,
          successRate: 0, topProxies: [], serviceReachable: false,
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Shield className="h-4 w-4" />
            代理池状态
          </CardTitle>
          <button
            onClick={fetchStats}
            className="rounded-md p-1 hover:bg-muted transition-colors"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !stats ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : stats && stats.totalProxies === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Server className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">暂无代理配置</p>
            <p className="text-xs mt-1">设置 PROXY_LIST 环境变量以启用代理池</p>
            {!stats.serviceReachable && (
              <p className="text-xs mt-2 text-yellow-600">采集服务未连接</p>
            )}
          </div>
        ) : stats ? (
          <>
            {/* Summary Row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <p className="text-xs text-muted-foreground">活跃代理</p>
                <p className={`text-lg font-semibold ${healthColor(stats.avgHealthScore)}`}>
                  {stats.activeProxies}<span className="text-xs font-normal text-muted-foreground">/{stats.totalProxies}</span>
                </p>
              </div>
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <p className="text-xs text-muted-foreground">平均健康度</p>
                <p className={`text-lg font-semibold ${healthColor(stats.avgHealthScore)}`}>
                  {stats.avgHealthScore}<span className="text-xs font-normal text-muted-foreground">/100</span>
                </p>
              </div>
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <p className="text-xs text-muted-foreground">平均响应</p>
                <p className="text-lg font-semibold">{stats.avgResponseTime > 0 ? formatMs(stats.avgResponseTime) : '-'}<span className="text-xs font-normal text-muted-foreground"></span></p>
              </div>
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <p className="text-xs text-muted-foreground">成功率</p>
                <p className={`text-lg font-semibold ${stats.successRate >= 80 ? 'text-green-600 dark:text-green-400' : stats.successRate >= 50 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                  {stats.successRate}%<span className="text-xs font-normal text-muted-foreground"></span>
                </p>
              </div>
            </div>

            {/* Cooling/Disabled badges */}
            {(stats.coolingProxies > 0 || stats.disabledProxies > 0) && (
              <div className="flex gap-2 flex-wrap">
                {stats.coolingProxies > 0 && (
                  <Badge variant="secondary" className="text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
                    冷却中: {stats.coolingProxies}
                  </Badge>
                )}
                {stats.disabledProxies > 0 && (
                  <Badge variant="secondary" className="text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                    已禁用: {stats.disabledProxies}
                  </Badge>
                )}
              </div>
            )}

            {/* Top 5 Proxies Bar Chart */}
            {stats.topProxies.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">代理健康度排行</p>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {stats.topProxies.map((proxy, i) => (
                    <div key={proxy.host + i} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-4 text-right shrink-0">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-xs truncate max-w-[60%]" title={proxy.host}>{proxy.host}</span>
                          <span className={`text-xs font-medium ${healthColor(proxy.healthScore)}`}>{proxy.healthScore}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${healthBgColor(proxy.healthScore)}`}
                            style={{ width: `${proxy.healthScore}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AdaptiveDelayPanel() {
  const [data, setData] = useState<DelayStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch<DelayStatsResponse>('/api/admin/scraper/delay-stats', { silent: true, timeout: 6000 });
      setData(result);
    } catch (err) {
      if (err instanceof FetchError && err.status === 0) {
        setData({ domains: [], totalDomains: 0, serviceReachable: false });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Clock className="h-4 w-4" />
            自适应延迟
          </CardTitle>
          <button
            onClick={fetchStats}
            className="rounded-md p-1 hover:bg-muted transition-colors"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !data ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : data && data.totalDomains === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Activity className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">暂无延迟追踪数据</p>
            <p className="text-xs mt-1">运行采集任务后将自动追踪各域名延迟</p>
            {!data.serviceReachable && (
              <p className="text-xs mt-2 text-yellow-600">采集服务未连接</p>
            )}
          </div>
        ) : data ? (
          <div className="space-y-3 max-h-64 overflow-y-auto">
            {data.domains.map((domain) => {
              const sc = statusColor(domain.status);
              return (
                <div key={domain.domain} className="rounded-lg border px-3 py-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium truncate max-w-[60%]" title={domain.domain}>{domain.domain}</span>
                    <Badge variant="secondary" className={`text-xs ${sc.bg} ${sc.text}`}>
                      {sc.label}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">当前延迟</p>
                      <p className="font-medium">{formatMs(domain.currentDelay)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">平均响应</p>
                      <p className="font-medium">{domain.avgResponseTime > 0 ? formatMs(domain.avgResponseTime) : '-'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">连续错误</p>
                      <p className={`font-medium ${domain.consecutiveErrors > 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{domain.consecutiveErrors}</p>
                    </div>
                  </div>
                  {/* Backoff level indicator */}
                  {domain.backoffLevel > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>退避级别</span>
                        <span>Lv.{domain.backoffLevel}</span>
                      </div>
                      <Progress
                        value={Math.min(domain.backoffLevel * 10, 100)}
                        className="h-1.5"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ==================== Main Component ====================

export function AntiCrawlTab({ form }: EditorFormAccess) {
  const { setValue, watch } = form;
  const antiCrawl = watch('antiCrawlConfig');
  const listUrl = watch('listUrl');
  const engine = watch('engine');

  // Smart recommendation: detect Cloudflare domains
  const isCloudflareDomain = useMemo(() => detectCloudflare(listUrl), [listUrl]);

  // Show Obscura banner when engine is obscura but humanBehavior is off
  const showObscuraBanner = engine === 'obscura' && !antiCrawl.humanBehavior;
  const showCloudflareBanner = isCloudflareDomain && engine !== 'obscura';

  return (
    <div className="space-y-4 rounded-lg border p-4">
      {/* ==================== Smart Recommendation Banners ==================== */}
      {showCloudflareBanner && (
        <Alert className="border-yellow-300 bg-yellow-50 dark:border-yellow-700 dark:bg-yellow-950/30">
          <TriangleAlert className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
          <AlertDescription className="text-yellow-800 dark:text-yellow-200 text-xs">
            <span className="font-medium">Cloudflare防护检测：</span>
            检测到该站点可能使用Cloudflare防护，建议使用 <span className="font-semibold">Obscura引擎</span> + <span className="font-semibold">人类行为模拟</span> 以获得最佳反爬效果。
          </AlertDescription>
        </Alert>
      )}

      {showObscuraBanner && (
        <Alert className="border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950/30">
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
          <AlertDescription className="text-green-800 dark:text-green-200 text-xs">
            <span className="font-medium">最强反爬引擎已启用：</span>
            建议同时开启 <span className="font-semibold">人类行为模拟</span>，可模拟鼠标移动、滚动、链接悬停等真实用户行为，进一步提升反检测能力。
          </AlertDescription>
        </Alert>
      )}

      {/* ==================== Basic Anti-Crawl Options ==================== */}
      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">启用JS渲染</Label>
          <p className="text-xs text-muted-foreground">使用无头浏览器渲染页面（速度较慢）</p>
        </div>
        <Switch
          checked={antiCrawl.useJsRender}
          onCheckedChange={(v) =>
            setValue('antiCrawlConfig', { ...antiCrawl, useJsRender: v }, { shouldDirty: true })
          }
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">UA轮换</Label>
          <p className="text-xs text-muted-foreground">每次请求使用不同的User-Agent</p>
        </div>
        <Switch
          checked={antiCrawl.uaRotation}
          onCheckedChange={(v) =>
            setValue('antiCrawlConfig', { ...antiCrawl, uaRotation: v }, { shouldDirty: true })
          }
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">自定义Cookies</Label>
        <Textarea
          placeholder={'key1=value1\nkey2=value2'}
          rows={4}
          value={antiCrawl.cookies}
          onChange={(e) =>
            setValue('antiCrawlConfig', { ...antiCrawl, cookies: e.target.value }, { shouldDirty: true })
          }
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">每行一个Cookie，格式：key=value</p>
      </div>

      <Separator />

      {/* ==================== Request Delay ==================== */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">请求延迟范围</Label>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">最小延迟</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                value={antiCrawl.minDelay}
                onChange={(e) =>
                  setValue(
                    'antiCrawlConfig',
                    { ...antiCrawl, minDelay: parseInt(e.target.value) || 0 },
                    { shouldDirty: true }
                  )
                }
              />
              <span className="text-sm text-muted-foreground shrink-0">ms</span>
            </div>
          </div>
          <span className="mt-5 text-muted-foreground">-</span>
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">最大延迟</Label>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                value={antiCrawl.maxDelay}
                onChange={(e) =>
                  setValue(
                    'antiCrawlConfig',
                    { ...antiCrawl, maxDelay: parseInt(e.target.value) || 0 },
                    { shouldDirty: true })
                }
              />
              <span className="text-sm text-muted-foreground shrink-0">ms</span>
            </div>
          </div>
        </div>
      </div>

      <Separator />

      {/* ==================== Advanced Anti-Crawl Options ==================== */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-semibold">高级反爬选项</Label>
        </div>

        {/* Human Behavior Simulation */}
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex-1 min-w-0 mr-3">
            <div className="flex items-center gap-2">
              <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Label className="text-sm font-medium">人类行为模拟</Label>
              {engine !== 'obscura' && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">仅Obscura</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">鼠标移动、滚动、链接悬停等模拟真实用户行为 (仅Obscura引擎)</p>
          </div>
          <Switch
            checked={antiCrawl.humanBehavior}
            disabled={engine !== 'obscura'}
            onCheckedChange={(v) =>
              setValue('antiCrawlConfig', { ...antiCrawl, humanBehavior: v }, { shouldDirty: true })
            }
          />
        </div>

        {/* DNT Header */}
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex-1 min-w-0 mr-3">
            <Label className="text-sm font-medium">DNT头</Label>
            <p className="text-xs text-muted-foreground mt-0.5">发送Do Not Track头</p>
          </div>
          <Switch
            checked={antiCrawl.dnt}
            onCheckedChange={(v) =>
              setValue('antiCrawlConfig', { ...antiCrawl, dnt: v }, { shouldDirty: true })
            }
          />
        </div>

        {/* Accept-Language Override */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Label className="text-sm font-medium">Accept-Language覆盖</Label>
          </div>
          <Input
            placeholder="留空自动随机化"
            value={antiCrawl.acceptLanguage}
            onChange={(e) =>
              setValue('antiCrawlConfig', { ...antiCrawl, acceptLanguage: e.target.value }, { shouldDirty: true })
            }
            className="text-sm"
          />
          <p className="text-xs text-muted-foreground">自定义Accept-Language头</p>
        </div>

        {/* Referer Override */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Label className="text-sm font-medium">Referer覆盖</Label>
          </div>
          <Input
            placeholder="留空自动伪装搜索引擎来源"
            value={antiCrawl.referer}
            onChange={(e) =>
              setValue('antiCrawlConfig', { ...antiCrawl, referer: e.target.value }, { shouldDirty: true })
            }
            className="text-sm"
          />
          <p className="text-xs text-muted-foreground">自定义Referer头</p>
        </div>
      </div>

      <Separator />

      {/* ==================== CAPTCHA Strategy ==================== */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <Label className="text-sm font-semibold">CAPTCHA 策略</Label>
        </div>

        {/* CAPTCHA Strategy Select */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">验证码策略</Label>
          <Select
            value={antiCrawl.captchaStrategy}
            onValueChange={(v) =>
              setValue('antiCrawlConfig', { ...antiCrawl, captchaStrategy: v }, { shouldDirty: true })
            }
          >
            <SelectTrigger className="text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">默认自动 - 自动检测并处理</SelectItem>
              <SelectItem value="cloudflare">Cloudflare 专用策略</SelectItem>
              <SelectItem value="geetest">GeeTest 极验策略</SelectItem>
              <SelectItem value="engine-upgrade">引擎自动升级</SelectItem>
              <SelectItem value="delay-backoff">仅延迟退避</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Enable CAPTCHA Retry */}
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex-1 min-w-0 mr-3">
            <Label className="text-sm font-medium">验证码自动重试</Label>
            <p className="text-xs text-muted-foreground mt-0.5">检测到验证码时自动切换引擎重试</p>
          </div>
          <Switch
            checked={antiCrawl.enableCaptchaRetry}
            onCheckedChange={(v) =>
              setValue('antiCrawlConfig', { ...antiCrawl, enableCaptchaRetry: v }, { shouldDirty: true })
            }
          />
        </div>

        {/* Max CAPTCHA Retries */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">最大重试次数</Label>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={1}
              max={10}
              value={antiCrawl.maxCaptchaRetries}
              onChange={(e) =>
                setValue(
                  'antiCrawlConfig',
                  { ...antiCrawl, maxCaptchaRetries: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)) },
                  { shouldDirty: true }
                )
              }
            />
          </div>
          <p className="text-xs text-muted-foreground">范围 1-10，默认 3</p>
        </div>
      </div>

      <Separator />

      {/* Smart Proxy Manager Panel */}
      <ProxyPoolPanel />

      {/* Adaptive Delay Panel */}
      <AdaptiveDelayPanel />
    </div>
  );
}
