'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Fingerprint, CheckCircle2, AlertTriangle, XCircle,
  RefreshCw, Shield, Monitor, Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FingerprintHealthData {
  stealthScore: number;
  proxyPoolReady: boolean;
  activeModules: string[];
  totalModules: number;
  engines: Record<string, { jsRendering: boolean; stealthMode: boolean; proxySupport: boolean; cookieManagement: boolean }>;
  proxyPoolSize: number;
  cookieJarDomains: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STEALTH_MODULES = [
  { key: 'navigator', label: 'Navigator伪装', description: '伪装 navigator.userAgent、platform、language 等属性' },
  { key: 'webgl', label: 'WebGL指纹', description: '随机化 WebGL 渲染器和供应商字符串' },
  { key: 'canvas', label: 'Canvas噪声', description: '注入微小噪声到 Canvas 2D 渲染结果' },
  { key: 'audio', label: 'AudioContext噪声', description: '为 AudioContext 添加微量噪声防止指纹' },
  { key: 'webrtc', label: 'WebRTC防泄漏', description: '禁用 WebRTC 防止真实 IP 泄漏' },
  { key: 'screen', label: 'Screen属性', description: '伪装屏幕分辨率、色深等属性' },
  { key: 'permissions', label: 'Permission API', description: '重写 permissions.query 返回标准值' },
  { key: 'iframe', label: 'Iframe传播', description: '确保隐身脚本在 iframe 中正确传播' },
  { key: 'connection', label: 'Connection API', description: '伪装 NetworkInformation API 连接信息' },
  { key: 'battery', label: 'Battery API', description: '重写 Battery API 防止设备特征泄漏' },
  { key: 'media', label: 'MediaDevices', description: '限制 enumerateDevices 信息' },
  { key: 'speech', label: 'SpeechSynthesis', description: '重写 Speech API 返回通用值' },
  { key: 'clientRects', label: 'ClientRects', description: '添加微量偏移到 DOM 元素坐标' },
  { key: 'font', label: '字体检测', description: '限制字体枚举防止指纹' },
  { key: 'console', label: 'Console隐蔽', description: '清理 console 日志中的隐私信息' },
  { key: 'performance', label: 'Performance时间', description: '重写 Performance API 时间精度' },
  { key: 'mouse', label: '鼠标事件', description: '模拟自然的鼠标移动轨迹和事件' },
  { key: 'touch', label: '触摸支持', description: '添加合理的触摸事件支持' },
  { key: 'plugins', label: 'Plugin枚举', description: '限制 navigator.plugins 信息' },
  { key: 'requestProfile', label: '请求特征随机化', description: '随机化 HTTP 请求指纹特征' },
] as const;

const ENGINE_RECOMMENDATIONS = [
  {
    scenario: '静态网站（无JS渲染）',
    description: 'HTML直接输出内容的网站',
    engine: 'cheerio',
    color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  },
  {
    scenario: 'JS渲染网站',
    description: '需要浏览器执行JavaScript获取内容',
    engine: 'playwright',
    color: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
  },
  {
    scenario: '反爬网站',
    description: '有基础反爬检测（指纹、行为分析）',
    engine: 'obscura',
    color: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
  },
  {
    scenario: 'Cloudflare网站',
    description: '使用Cloudflare高级防护的网站',
    engine: 'obscura + 人类行为',
    color: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  },
] as const;

// ─── User-Agent pool (for preview generation) ────────────────────────────────

const CHROME_VERSIONS = ['120.0.6099.129', '121.0.6167.85', '122.0.6261.94', '123.0.6312.58', '124.0.6367.91'];
const PLATFORMS = [
  { os: 'Windows NT 10.0; Win64; x64', secCh: '"Windows"', model: '' },
  { os: 'Macintosh; Intel Mac OS X 10_15_7', secCh: '"macOS"', model: '' },
  { os: 'X11; Linux x86_64', secCh: '"Linux"', model: '' },
  { os: 'Windows NT 10.0; Win64; x64', secCh: '"Windows"', model: '"Laptop"' },
];
const LANGUAGES = ['en-US,en;q=0.9', 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7', 'zh-CN,zh;q=0.9,en;q=0.8', 'ja;q=0.9,en;q=0.8'];
const ACCEPT_ENCODINGS = ['gzip, deflate, br', 'gzip, deflate'];
const DNT_VALUES = ['1', 'null'];

function randomItem<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface HeaderPreview {
  userAgent: string;
  acceptLanguage: string;
  secFetchDest: string;
  secFetchMode: string;
  secFetchSite: string;
  secFetchUser: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  acceptEncoding: string;
  dnt: string;
}

function generateHeaderPreview(): HeaderPreview {
  const platform = randomItem(PLATFORMS);
  const chromeVer = randomItem(CHROME_VERSIONS);
  const majorVer = chromeVer.split('.')[0];

  return {
    userAgent: `Mozilla/5.0 (${platform.os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
    acceptLanguage: randomItem(LANGUAGES),
    secFetchDest: 'document',
    secFetchMode: 'navigate',
    secFetchSite: 'none',
    secFetchUser: '?1',
    secChUa: `"Chromium"${majorVer}, "Google Chrome"${majorVer}, "Not:A-Brand";v="99"`,
    secChUaMobile: platform.os.includes('Linux') ? '?0' : '?0',
    secChUaPlatform: platform.secCh,
    acceptEncoding: randomItem(ACCEPT_ENCODINGS),
    dnt: randomItem(DNT_VALUES),
  };
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function getOverallStatus(
  activeModules: string[],
  totalModules: number,
  proxyPoolReady: boolean,
): { level: 'green' | 'yellow' | 'red'; label: string; description: string; color: string; bgColor: string; borderColor: string } {
  const moduleRatio = totalModules > 0 ? activeModules.length / totalModules : 0;

  if (moduleRatio >= 0.9 && proxyPoolReady) {
    return {
      level: 'green',
      label: '状态良好',
      description: '所有模块已启用，代理池就绪',
      color: 'text-emerald-600 dark:text-emerald-400',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/20',
    };
  }
  if (moduleRatio >= 0.5 && !proxyPoolReady) {
    return {
      level: 'yellow',
      label: '部分可用',
      description: '部分模块缺失，代理池为空',
      color: 'text-amber-600 dark:text-amber-400',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/20',
    };
  }
  if (moduleRatio < 0.5 || !proxyPoolReady) {
    return {
      level: 'red',
      label: '需要关注',
      description: '关键模块缺失，代理池不可用',
      color: 'text-red-600 dark:text-red-400',
      bgColor: 'bg-red-500/10',
      borderColor: 'border-red-500/20',
    };
  }
  return {
    level: 'yellow',
    label: '部分可用',
    description: '部分模块缺失',
    color: 'text-amber-600 dark:text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/20',
  };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function FingerprintHealthPanel() {
  const [data, setData] = useState<FingerprintHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [headers, setHeaders] = useState<HeaderPreview>(() => generateHeaderPreview());
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await apiFetch<FingerprintHealthData>(
        '/api/admin/scraper/fingerprint-health',
        { signal, timeout: 10000, silent: true },
      );
      if (!signal?.aborted) setData(result);
    } catch {
      // handled by apiFetch
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
    return () => { abortRef.current?.abort(); abortRef.current = null; };
  }, [fetchData]);

  const handleRefreshHeaders = () => {
    setHeaders(generateHeaderPreview());
  };

  const handleRefreshData = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
  };

  const overallStatus = useMemo(
    () =>
      getOverallStatus(
        data?.activeModules ?? [],
        data?.totalModules ?? STEALTH_MODULES.length,
        data?.proxyPoolReady ?? false,
      ),
    [data],
  );

  return (
    <Card className="glass-card">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-medium flex items-center gap-2">
            <Fingerprint className="h-3.5 w-3.5 text-primary" />
            指纹健康检测
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={handleRefreshData}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            {/* ── Detection Summary ── */}
            <div className={`rounded-lg border ${overallStatus.borderColor} p-4`}>
              <div className="flex items-center gap-3">
                <div className={`rounded-lg p-2.5 ${overallStatus.bgColor}`}>
                  <Shield className={`h-5 w-5 ${overallStatus.color}`} />
                </div>
                <div>
                  <div className={`text-sm font-semibold ${overallStatus.color}`}>
                    {overallStatus.label}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {overallStatus.description}
                  </div>
                </div>
              </div>
              {/* Mini stat badges */}
              <div className="flex items-center gap-2 mt-3">
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
                  <CheckCircle2 className="h-2.5 w-2.5 mr-0.5 text-emerald-500" />
                  {data?.activeModules?.length ?? 0}/{data?.totalModules ?? STEALTH_MODULES.length} 模块
                </Badge>
                <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
                  <Monitor className="h-2.5 w-2.5 mr-0.5" />
                  代理池: {data?.proxyPoolReady ? '就绪' : '未就绪'}
                </Badge>
              </div>
            </div>

            <Separator />

            {/* ── Module Coverage Grid ── */}
            <div className="space-y-2">
              <h4 className="text-[11px] font-medium text-muted-foreground">
                模块覆盖
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {STEALTH_MODULES.map((mod) => {
                  const isActive = data?.activeModules?.includes(mod.key) ?? false;
                  const Icon = isActive ? CheckCircle2 : AlertTriangle;
                  return (
                    <Tooltip key={mod.key}>
                      <TooltipTrigger asChild>
                        <Badge
                          variant={isActive ? 'secondary' : 'outline'}
                          className={`text-[9px] px-1.5 py-0 font-normal cursor-default transition-colors gap-1 ${
                            isActive
                              ? 'bg-primary/15 text-primary border-primary/20'
                              : 'text-muted-foreground/50 border-muted-foreground/20'
                          }`}
                        >
                          <Icon className={`h-2.5 w-2.5 ${
                            isActive ? 'text-emerald-500' : 'text-amber-500'
                          }`} />
                          {mod.label}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        <p className="text-[11px]">{mod.description}</p>
                        <p className="text-[10px] text-primary-foreground/70 mt-1">
                          状态: {isActive ? '已启用' : '未启用'}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            </div>

            <Separator />

            {/* ── Engine Recommendation ── */}
            <div className="space-y-2">
              <h4 className="text-[11px] font-medium text-muted-foreground">
                引擎推荐
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {ENGINE_RECOMMENDATIONS.map((rec) => (
                  <div
                    key={rec.engine}
                    className="rounded-lg border bg-background/50 p-2.5 flex items-center gap-2.5"
                  >
                    <Monitor className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] font-medium">{rec.scenario}</div>
                      <div className="text-[9px] text-muted-foreground">{rec.description}</div>
                    </div>
                    <Badge
                      variant="outline"
                      className={`text-[9px] px-1.5 py-0 font-medium shrink-0 ${rec.color}`}
                    >
                      {rec.engine}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            {/* ── Request Header Preview ── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-[11px] font-medium text-muted-foreground">
                  请求头预览
                </h4>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[9px] px-2 gap-1"
                  onClick={handleRefreshHeaders}
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  刷新
                </Button>
              </div>
              <div className="rounded-lg border bg-background/50 p-3 space-y-1.5 font-mono text-[10px]">
                <HeaderLine label="User-Agent" value={headers.userAgent} />
                <HeaderLine label="Accept-Language" value={headers.acceptLanguage} />
                <HeaderLine label="Accept-Encoding" value={headers.acceptEncoding} />
                <HeaderLine label="Sec-Fetch-Dest" value={headers.secFetchDest} />
                <HeaderLine label="Sec-Fetch-Mode" value={headers.secFetchMode} />
                <HeaderLine label="Sec-Fetch-Site" value={headers.secFetchSite} />
                <HeaderLine label="Sec-Fetch-User" value={headers.secFetchUser} />
                <Separator className="my-1" />
                <HeaderLine label="Sec-CH-UA" value={headers.secChUa} />
                <HeaderLine label="Sec-CH-UA-Mobile" value={headers.secChUaMobile} />
                <HeaderLine label="Sec-CH-UA-Platform" value={headers.secChUaPlatform} />
                <Separator className="my-1" />
                <HeaderLine label="DNT" value={headers.dnt} />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Header Line Sub-component ───────────────────────────────────────────────

function HeaderLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="text-foreground/80 break-all">{value}</span>
    </div>
  );
}
