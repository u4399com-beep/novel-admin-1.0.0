'use client';

import { useState } from 'react';
import {
  Globe,
  BookOpen,
  Shield,
  Zap,
  Eye,
  Brain,
  Info,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  MinusCircle,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

import type { GeneratedRule, AdvisorReport } from './types';
import { getConfidenceColor, getConfidenceIcon, getConfidenceLabel } from './helpers';
import { SelectorCard } from './SelectorCard';

interface ResultViewProps {
  rule: GeneratedRule;
  advisorReport?: AdvisorReport;
  appliedRecommendations?: string[];
}

function getPriorityConfig(priority: string) {
  switch (priority) {
    case 'high':
      return {
        label: '高',
        className: 'bg-destructive/15 text-destructive border-destructive/30',
      };
    case 'medium':
      return {
        label: '中',
        className: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
      };
    case 'low':
      return {
        label: '低',
        className: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
      };
    default:
      return {
        label: '低',
        className: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
      };
  }
}

function getThreatLevelConfig(level: string) {
  switch (level) {
    case 'high':
      return { label: '高风险', className: 'bg-destructive/15 text-destructive' };
    case 'medium':
      return { label: '中风险', className: 'bg-amber-500/15 text-amber-700' };
    case 'low':
      return { label: '低风险', className: 'bg-emerald-500/15 text-emerald-700' };
    default:
      return { label: '低风险', className: 'bg-emerald-500/15 text-emerald-700' };
  }
}

function AdvisorReportSection({
  advisorReport,
  appliedRecommendations,
}: {
  advisorReport: AdvisorReport;
  appliedRecommendations: string[];
}) {
  const [open, setOpen] = useState(true);
  const threatConfig = getThreatLevelConfig(advisorReport.threatLevel);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="outline" className="w-full justify-between gap-2">
          <span className="flex items-center gap-2 text-xs">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            反爬策略建议
            {appliedRecommendations.length > 0 && (
              <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 text-[10px] h-5 px-1.5">
                已应用 {appliedRecommendations.length} 项
              </Badge>
            )}
          </span>
          {open ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2 space-y-3">
        {/* Domain & threat level */}
        <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2">
          <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono text-primary/70">{advisorReport.domain}</span>
          <Badge className={`text-[10px] h-5 px-1.5 shrink-0 ${threatConfig.className}`}>
            {threatConfig.label}
          </Badge>
          {advisorReport.suggestedEngine && (
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 shrink-0">
              建议引擎: {advisorReport.suggestedEngine}
            </Badge>
          )}
        </div>

        {/* Recommendations list */}
        <div className="space-y-1.5 rounded-lg border p-3">
          {advisorReport.recommendations.map((rec) => {
            const priorityConfig = getPriorityConfig(rec.priority);
            return (
              <div
                key={rec.id}
                className="flex items-start gap-2 rounded-lg border bg-muted/20 px-3 py-2"
              >
                {/* Status icon */}
                {rec.applied ? (
                  <ShieldCheck className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                ) : (
                  <MinusCircle className="h-4 w-4 text-muted-foreground/50 mt-0.5 shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium">{rec.title}</span>
                    <Badge className={`text-[9px] h-4 px-1.5 ${priorityConfig.className}`}>
                      {priorityConfig.label}
                    </Badge>
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                      {rec.category}
                    </Badge>
                    <Badge
                      className={`text-[9px] h-4 px-1.5 ${
                        rec.applied
                          ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
                          : 'bg-muted text-muted-foreground border-border'
                      }`}
                    >
                      {rec.applied ? '已应用' : '未应用'}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {rec.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Applied recommendations summary */}
        {appliedRecommendations.length > 0 && (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
            <p className="text-[10px] font-medium text-emerald-700 mb-1">已自动应用以下优化：</p>
            <ul className="space-y-0.5">
              {appliedRecommendations.map((rec, i) => (
                <li key={i} className="text-[10px] text-emerald-600 flex items-start gap-1.5">
                  <span className="shrink-0">•</span>
                  {rec}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ResultView({ rule, advisorReport, appliedRecommendations }: ResultViewProps) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [agentqlOpen, setAgentqlOpen] = useState(false);
  const confidenceIconEmoji = getConfidenceIcon(rule.confidence);

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 pr-4">
        {/* Confidence & Meta */}
        <div className="flex items-center gap-3 flex-wrap">
          <Badge className={getConfidenceColor(rule.confidence)}>
            <span className="mr-1">{confidenceIconEmoji}</span>
            {rule.confidence}% · {getConfidenceLabel(rule.confidence)}
          </Badge>
          <Badge variant="outline">
            {rule.engine === 'cheerio' ? 'Cheerio' : rule.engine === 'playwright' ? 'Playwright' : rule.engine}
          </Badge>
          {advisorReport && appliedRecommendations && appliedRecommendations.length > 0 && (
            <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 gap-1">
              <ShieldCheck className="h-3 w-3" />
              已应用 {appliedRecommendations.length} 项反爬建议
            </Badge>
          )}
        </div>

        {/* Rule name & description */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm">{rule.name}</CardTitle>
            <CardDescription className="text-xs">{rule.description}</CardDescription>
          </CardHeader>
        </Card>

        {/* Advisor Report (if available) */}
        {advisorReport && (
          <AdvisorReportSection
            advisorReport={advisorReport}
            appliedRecommendations={appliedRecommendations ?? []}
          />
        )}

        {/* List page selectors */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5" />
              列表页配置
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-1.5">
            <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">
                列表 URL
              </span>
              <code className="flex-1 text-xs font-mono truncate text-primary/70 hover:underline cursor-pointer">
                {rule.listUrl || '(未设置)'}
              </code>
            </div>
            <SelectorCard label="列表选择器" selector={rule.listSelector} editable />
            <div className="flex items-center gap-3 rounded-lg border bg-muted/20 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground w-24 shrink-0">
                分页类型
              </span>
              <code className="flex-1 text-xs font-mono truncate text-foreground/70">
                {rule.listPagination?.type || '未设置'}
              </code>
              <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5">
                最多 {rule.listPagination?.maxPage || 0} 页
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Book info selectors */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <BookOpen className="h-3.5 w-3.5" />
              书籍信息选择器
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-1.5">
            <SelectorCard label="书名" selector={rule.bookTitleSelector} editable />
            <SelectorCard label="作者" selector={rule.bookAuthorSelector} editable />
            <SelectorCard label="简介" selector={rule.bookDescriptionSelector} editable />
            <SelectorCard label="封面" selector={rule.bookCoverSelector} editable />
            <SelectorCard label="状态" selector={rule.bookStatusSelector} editable />
          </CardContent>
        </Card>

        {/* Chapter selectors */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5" />
              章节选择器
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-1.5">
            <SelectorCard label="章节列表" selector={rule.chapterListSelector} editable />
            <SelectorCard label="章节标题" selector={rule.chapterTitleSelector} editable />
            <SelectorCard label="章节链接" selector={rule.chapterLinkSelector} editable />
          </CardContent>
        </Card>

        {/* Content selectors */}
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Eye className="h-3.5 w-3.5" />
              正文内容选择器
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0 space-y-1.5">
            <SelectorCard label="内容标题" selector={rule.contentTitleSelector} editable />
            <SelectorCard label="正文内容" selector={rule.contentSelector} editable />
          </CardContent>
        </Card>

        {/* Anti-crawl config */}
        {rule.antiCrawlConfig && (
          <Card>
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-xs flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5" />
                反爬策略
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 pt-0">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">JS 渲染</p>
                  <p className="text-xs font-medium">
                    {rule.antiCrawlConfig.useJsRender ? '启用' : '关闭'}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">UA 轮换</p>
                  <p className="text-xs font-medium">
                    {rule.antiCrawlConfig.uaRotation ? '启用' : '关闭'}
                  </p>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">最小延迟</p>
                  <p className="text-xs font-medium">{rule.antiCrawlConfig.minDelay}ms</p>
                </div>
                <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">最大延迟</p>
                  <p className="text-xs font-medium">{rule.antiCrawlConfig.maxDelay}ms</p>
                </div>
                {rule.antiCrawlConfig.useProxy !== undefined && (
                  <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                    <p className="text-[10px] text-muted-foreground">代理</p>
                    <p className="text-xs font-medium">
                      {rule.antiCrawlConfig.useProxy ? '启用' : '关闭'}
                    </p>
                  </div>
                )}
                {rule.antiCrawlConfig.useCookies !== undefined && (
                  <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Cookie</p>
                    <p className="text-xs font-medium">
                      {rule.antiCrawlConfig.useCookies ? '启用' : '关闭'}
                    </p>
                  </div>
                )}
                {rule.antiCrawlConfig.useSession !== undefined && (
                  <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                    <p className="text-[10px] text-muted-foreground">会话管理</p>
                    <p className="text-xs font-medium">
                      {rule.antiCrawlConfig.useSession ? '启用' : '关闭'}
                    </p>
                  </div>
                )}
                {rule.antiCrawlConfig.useStealth !== undefined && (
                  <div className="rounded-lg border bg-muted/20 px-3 py-2 text-center">
                    <p className="text-[10px] text-muted-foreground">隐身模式</p>
                    <p className="text-xs font-medium">
                      {rule.antiCrawlConfig.useStealth ? '启用' : '关闭'}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* AgentQL Queries */}
        {rule.agentqlQueries && Object.keys(rule.agentqlQueries).some((k) => rule.agentqlQueries?.[k as keyof typeof rule.agentqlQueries]) && (
          <Collapsible open={agentqlOpen} onOpenChange={setAgentqlOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="w-full justify-between gap-2">
                <span className="flex items-center gap-2 text-xs">
                  <Brain className="h-3.5 w-3.5 text-primary" />
                  AgentQL 自然语言查询
                </span>
                {agentqlOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 space-y-1.5">
              {Object.entries(rule.agentqlQueries).map(([key, val]) =>
                val ? (
                  <div
                    key={key}
                    className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2"
                  >
                    <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5 mt-0.5">
                      {key}
                    </Badge>
                    <p className="text-xs text-foreground/70 italic">{val}</p>
                  </div>
                ) : null,
              )}
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* AI Notes */}
        {rule.notes && rule.notes.length > 0 && (
          <Collapsible open={notesOpen} onOpenChange={setNotesOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" className="w-full justify-between gap-2">
                <span className="flex items-center gap-2 text-xs">
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                  AI 分析备注 ({rule.notes.length})
                </span>
                {notesOpen ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
                {rule.notes.map((note, i) => (
                  <p key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                    <span className="shrink-0 text-[10px] font-bold text-muted-foreground/60 mt-px">
                      {i + 1}.
                    </span>
                    {note}
                  </p>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </ScrollArea>
  );
}
