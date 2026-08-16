'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Shield, CheckCircle2, XCircle, Loader2, Globe, Cookie,
  RefreshCw, Fingerprint,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FingerprintHealth {
  stealthScore: number;
  proxyPoolReady: boolean;
  activeModules: string[];
  totalModules: number;
  engines: Record<string, EngineCapability>;
  proxyPoolSize: number;
  cookieJarDomains: number;
}

interface EngineCapability {
  jsRendering: boolean;
  stealthMode: boolean;
  proxySupport: boolean;
  cookieManagement: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ENGINES = ['cheerio', 'playwright', 'obscura', 'firecrawl', 'agentql'] as const;

const CAPABILITY_LABELS: Record<string, string> = {
  jsRendering: 'JS渲染',
  stealthMode: '隐身模式',
  proxySupport: '代理支持',
  cookieManagement: 'Cookie管理',
};

const STEALTH_MODULES = [
  'navigator', 'webgl', 'canvas', 'audio', 'webrtc', 'screen',
  'permissions', 'iframe', 'connection', 'battery', 'media', 'speech',
  'clientRects', 'font', 'console', 'performance', 'mouse', 'touch', 'plugins',
] as const;

const STEALTH_MODULE_LABELS: Record<string, string> = {
  navigator: 'Navigator伪装',
  webgl: 'WebGL指纹',
  canvas: 'Canvas噪声',
  audio: 'AudioContext噪声',
  webrtc: 'WebRTC防泄漏',
  screen: 'Screen属性',
  permissions: 'Permission API',
  iframe: 'Iframe传播',
  connection: 'Connection API',
  battery: 'Battery API',
  media: 'MediaDevices',
  speech: 'SpeechSynthesis',
  clientRects: 'ClientRects',
  font: '字体检测',
  console: 'Console隐蔽',
  performance: 'Performance时间',
  mouse: '鼠标事件',
  touch: '触摸支持',
  plugins: 'Plugin枚举',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function CapabilityIcon({ supported }: { supported: boolean }) {
  if (supported) {
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />;
  }
  return <XCircle className="h-3.5 w-3.5 text-red-500 dark:text-red-400" />;
}

function getEngineDisplayColor(engine: string): string {
  switch (engine) {
    case 'cheerio': return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'playwright': return 'bg-sky-500/10 text-sky-600 dark:text-sky-400';
    case 'obscura': return 'bg-violet-500/10 text-violet-600 dark:text-violet-400';
    case 'firecrawl': return 'bg-orange-500/10 text-orange-600 dark:text-orange-400';
    case 'agentql': return 'bg-pink-500/10 text-pink-600 dark:text-pink-400';
    default: return 'bg-muted text-muted-foreground';
  }
}

// ─── Mobile Engine Card ──────────────────────────────────────────────────────

function EngineCardMobile({ engine, cap }: { engine: string; cap: EngineCapability }) {
  return (
    <div className="rounded-lg border bg-background/50 p-3 space-y-2">
      <Badge variant="outline" className={`${getEngineDisplayColor(engine)} text-[10px] font-medium`}>
        {engine}
      </Badge>
      <div className="grid grid-cols-2 gap-1.5">
        {(Object.keys(CAPABILITY_LABELS) as Array<keyof EngineCapability>).map((key) => (
          <div key={key} className="flex items-center gap-1.5">
            <CapabilityIcon supported={cap[key]} />
            <span className="text-[10px] text-muted-foreground">{CAPABILITY_LABELS[key]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function AntiCrawlCapabilityPanel() {
  const [data, setData] = useState<FingerprintHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = async (signal?: AbortSignal) => {
    try {
      const result = await apiFetch<FingerprintHealth>(
        '/api/admin/scraper/fingerprint-health',
        { signal, timeout: 10000, silent: true },
      );
      if (!signal?.aborted) setData(result);
    } catch {
      // handled by apiFetch
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
    return () => { abortRef.current?.abort(); abortRef.current = null; };
  }, []);

  const handleRefresh = () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    fetchData(ac.signal);
  };

  const activeCount = data?.activeModules?.length ?? 0;
  const totalModules = data?.totalModules ?? STEALTH_MODULES.length;
  const activeProgress = totalModules > 0 ? (activeCount / totalModules) * 100 : 0;

  return (
    <Card className="glass-card">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-medium flex items-center gap-2">
            <Shield className="h-3.5 w-3.5 text-primary" />
            反爬能力总览
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={handleRefresh}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-4">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <>
            {/* ── Engine Capability Matrix ── */}
            <div>
              <h4 className="text-[11px] font-medium text-muted-foreground mb-2">
                引擎能力矩阵
              </h4>
              {/* Desktop: table */}
              <div className="hidden md:block rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead className="text-[10px] h-8 font-medium">引擎</TableHead>
                      {Object.values(CAPABILITY_LABELS).map((label) => (
                        <TableHead key={label} className="text-[10px] h-8 font-medium text-center">
                          {label}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ENGINES.map((engine) => {
                      const cap = data?.engines?.[engine];
                      return (
                        <TableRow key={engine} className="h-8">
                          <TableCell className="py-1.5">
                            <Badge
                              variant="outline"
                              className={`${getEngineDisplayColor(engine)} text-[10px] font-medium`}
                            >
                              {engine}
                            </Badge>
                          </TableCell>
                          {(Object.keys(CAPABILITY_LABELS) as Array<keyof EngineCapability>).map((key) => (
                            <TableCell key={key} className="text-center py-1.5">
                              <CapabilityIcon supported={cap?.[key] ?? false} />
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {/* Mobile: cards */}
              <div className="md:hidden space-y-2">
                {ENGINES.map((engine) => {
                  const cap = data?.engines?.[engine];
                  return (
                    <EngineCardMobile
                      key={engine}
                      engine={engine}
                      cap={cap ?? { jsRendering: false, stealthMode: false, proxySupport: false, cookieManagement: false }}
                    />
                  );
                })}
              </div>
            </div>

            {/* ── Stealth Modules Status ── */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-[11px] font-medium text-muted-foreground">
                  隐身模块状态
                </h4>
                <span className="text-[10px] font-medium text-primary">
                  {activeCount}/{totalModules} 模块已启用
                </span>
              </div>
              <Progress value={activeProgress} className="h-2" />
              <div className="flex flex-wrap gap-1.5 mt-1">
                {STEALTH_MODULES.map((mod) => {
                  const isActive = data?.activeModules?.includes(mod) ?? false;
                  return (
                    <Badge
                      key={mod}
                      variant={isActive ? 'secondary' : 'outline'}
                      className={`text-[9px] px-1.5 py-0 font-normal transition-colors ${
                        isActive
                          ? 'bg-primary/15 text-primary border-primary/20'
                          : 'text-muted-foreground/50 border-muted-foreground/20'
                      }`}
                    >
                      {isActive && <CheckCircle2 className="h-2.5 w-2.5 mr-0.5 text-emerald-500" />}
                      {!isActive && <XCircle className="h-2.5 w-2.5 mr-0.5 text-muted-foreground/40" />}
                      {STEALTH_MODULE_LABELS[mod] || mod}
                    </Badge>
                  );
                })}
              </div>
            </div>

            {/* ── Quick Stats ── */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border bg-background/50 p-3 flex items-center gap-2.5">
                <div className="rounded-md bg-sky-500/10 p-1.5">
                  <Globe className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{data?.proxyPoolSize ?? 0}</div>
                  <div className="text-[10px] text-muted-foreground">代理池数量</div>
                </div>
              </div>
              <div className="rounded-lg border bg-background/50 p-3 flex items-center gap-2.5">
                <div className="rounded-md bg-amber-500/10 p-1.5">
                  <Cookie className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{data?.cookieJarDomains ?? 0}</div>
                  <div className="text-[10px] text-muted-foreground">Cookie域名</div>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
