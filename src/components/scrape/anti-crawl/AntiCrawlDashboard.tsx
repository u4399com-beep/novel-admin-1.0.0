'use client';

import { useState } from 'react';
import {
  Shield, Activity, Fingerprint, Globe, Award,
  AlertTriangle, Zap, Cookie,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { RateLimiterPanel } from './RateLimiterPanel';
import { AdaptiveDelayPanel } from './AdaptiveDelayPanel';
import { SessionManagerPanel } from './SessionManagerPanel';
import { CaptchaEventsPanel } from './CaptchaEventsPanel';
import { ProxyPoolPanel } from './ProxyPoolPanel';
import { RequestFingerprintPanel } from './RequestFingerprintPanel';
import { QualityScorePanel } from './QualityScorePanel';

// ─── Tab Definitions ─────────────────────────────────────────────────────────

type TabKey = 'realtime' | 'captcha' | 'proxy' | 'fingerprint' | 'quality';

interface TabDef {
  key: TabKey;
  label: string;
  icon: typeof Shield;
  badge?: string;
}

const TABS: TabDef[] = [
  { key: 'realtime',    label: '实时监控',  icon: Activity },
  { key: 'captcha',     label: 'CAPTCHA检测', icon: Shield },
  { key: 'proxy',       label: '代理池',    icon: Globe },
  { key: 'fingerprint', label: '请求指纹',  icon: Fingerprint },
  { key: 'quality',     label: '质量评分',  icon: Award },
];

// ─── Dashboard Header ────────────────────────────────────────────────────────

function DashboardHeader({ activeTab }: { activeTab: TabKey }) {
  const activeDef = TABS.find(t => t.key === activeTab);
  const Icon = activeDef?.icon || Shield;

  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-primary/10 p-2.5">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-sm font-semibold tracking-tight">反爬监控面板</h2>
          <p className="text-[11px] text-muted-foreground">Anti-Crawl Monitoring Dashboard</p>
        </div>
      </div>
      <Badge variant="outline" className="text-[10px] px-2 py-0.5 gap-1.5 font-normal">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
        实时
      </Badge>
    </div>
  );
}

// ─── Real-time Tab Content ───────────────────────────────────────────────────

function RealtimeTab() {
  return (
    <div className="space-y-4">
      {/* Quick stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <QuickStatCard
          icon={Zap}
          label="速率限制"
          description="域名级RPM控制"
          color="text-amber-500"
          bg="bg-amber-500/10"
        />
        <QuickStatCard
          icon={Activity}
          label="自适应延迟"
          description="智能退避策略"
          color="text-emerald-500"
          bg="bg-emerald-500/10"
        />
        <QuickStatCard
          icon={Cookie}
          label="会话管理"
          description="跨任务Cookie"
          color="text-violet-500"
          bg="bg-violet-500/10"
        />
        <QuickStatCard
          icon={AlertTriangle}
          label="优先级队列"
          description="4级任务调度"
          color="text-orange-500"
          bg="bg-orange-500/10"
        />
      </div>

      {/* Rate limiter - full panel without CollapsiblePanel wrapper */}
      <div className="space-y-3">
        <SectionHeader icon={Zap} title="域名速率限制" />
        <RateLimiterPanel />
      </div>

      {/* Adaptive delay */}
      <div className="space-y-3">
        <SectionHeader icon={Activity} title="自适应延迟控制" />
        <AdaptiveDelayPanel />
      </div>

      {/* Session manager */}
      <div className="space-y-3">
        <SectionHeader icon={Cookie} title="会话管理" />
        <SessionManagerPanel />
      </div>
    </div>
  );
}

// ─── Helper Components ───────────────────────────────────────────────────────

function QuickStatCard({ icon: Icon, label, description, color, bg }: {
  icon: typeof Shield;
  label: string;
  description: string;
  color: string;
  bg: string;
}) {
  return (
    <div className="rounded-lg border bg-background/50 p-3 hover:border-muted-foreground/20 transition-all duration-200">
      <div className="flex items-center gap-2.5">
        <div className={`rounded-lg p-2 ${bg}`}>
          <Icon className={`h-4 w-4 ${color}`} />
        </div>
        <div>
          <p className="text-xs font-medium">{label}</p>
          <p className="text-[10px] text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, count }: {
  icon: typeof Shield;
  title: string;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-primary" />
      <h3 className="text-xs font-semibold">{title}</h3>
      {count !== undefined && (
        <Badge variant="secondary" className="text-[9px] px-1.5 py-0 font-normal">
          {count}
        </Badge>
      )}
    </div>
  );
}

// ─── Main Dashboard Component ────────────────────────────────────────────────

export function AntiCrawlDashboard() {
  const [activeTab, setActiveTab] = useState<TabKey>('realtime');

  return (
    <div className="w-full">
      <DashboardHeader activeTab={activeTab} />

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabKey)}
        className="w-full"
      >
        <TabsList className="w-full sm:w-auto h-10">
          {TABS.map((tab) => {
            const TabIcon = tab.icon;
            return (
              <TabsTrigger
                key={tab.key}
                value={tab.key}
                className="gap-1.5 text-xs px-3 data-[state=active]:shadow-sm"
              >
                <TabIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.label.slice(0, 2)}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* Tab 1: 实时监控 */}
        <TabsContent value="realtime" className="mt-4">
          <RealtimeTab />
        </TabsContent>

        {/* Tab 2: CAPTCHA检测 */}
        <TabsContent value="captcha" className="mt-4">
          <div className="space-y-3">
            <SectionHeader icon={Shield} title="CAPTCHA 检测事件" />
            <CaptchaEventsPanel />
          </div>
        </TabsContent>

        {/* Tab 3: 代理池 */}
        <TabsContent value="proxy" className="mt-4">
          <div className="space-y-3">
            <SectionHeader icon={Globe} title="代理池管理" />
            <ProxyPoolPanel />
          </div>
        </TabsContent>

        {/* Tab 4: 请求指纹 */}
        <TabsContent value="fingerprint" className="mt-4">
          <div className="space-y-3">
            <SectionHeader icon={Fingerprint} title="请求指纹追踪" />
            <RequestFingerprintPanel />
          </div>
        </TabsContent>

        {/* Tab 5: 质量评分 */}
        <TabsContent value="quality" className="mt-4">
          <div className="space-y-3">
            <SectionHeader icon={Award} title="采集数据质量" />
            <QualityScorePanel />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
