'use client';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BasicInfoTab } from '../parts/BasicInfoTab';
import { ListPageTab } from '../parts/ListPageTab';
import { BookInfoTab } from '../parts/BookInfoTab';
import { ChapterDirTab } from '../parts/ChapterDirTab';
import { ChapterContentTab } from '../parts/ChapterContentTab';
import { AntiCrawlTab } from '../parts/AntiCrawlTab';
import { StorageTab } from '../parts/StorageTab';
import { StrategyTab } from '../parts/StrategyTab';
import { CleanTab } from '../parts/CleanTab';
import type { FormAccess } from './types';

interface RuleFormTabsProps {
  formAccess: FormAccess;
  onOpenAiAssistant: () => void;
  onOpenVisualSelector: (fieldName: string, _currentUrl?: string) => void;
}

export function RuleFormTabs({ formAccess, onOpenAiAssistant, onOpenVisualSelector }: RuleFormTabsProps) {
  return (
    <Tabs defaultValue="basic" className="w-full">
      <TabsList className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="basic" className="text-xs">基本信息</TabsTrigger>
        <TabsTrigger value="list" className="text-xs">列表页规则</TabsTrigger>
        <TabsTrigger value="book" className="text-xs">书籍信息规则</TabsTrigger>
        <TabsTrigger value="chapter-dir" className="text-xs">章节目录规则</TabsTrigger>
        <TabsTrigger value="chapter-content" className="text-xs">章节内容规则</TabsTrigger>
        <TabsTrigger value="anti-crawl" className="text-xs">反爬策略</TabsTrigger>
        <TabsTrigger value="storage" className="text-xs">存储策略</TabsTrigger>
        <TabsTrigger value="strategy" className="text-xs">采集策略</TabsTrigger>
        <TabsTrigger value="clean" className="text-xs">内容清洗</TabsTrigger>
      </TabsList>

      <TabsContent value="basic"><BasicInfoTab {...formAccess} /></TabsContent>
      <TabsContent value="list"><ListPageTab {...formAccess} /></TabsContent>
      <TabsContent value="book"><BookInfoTab {...formAccess} /></TabsContent>
      <TabsContent value="chapter-dir"><ChapterDirTab {...formAccess} /></TabsContent>
      <TabsContent value="chapter-content"><ChapterContentTab {...formAccess} /></TabsContent>
      <TabsContent value="anti-crawl"><AntiCrawlTab {...formAccess} /></TabsContent>
      <TabsContent value="storage"><StorageTab {...formAccess} /></TabsContent>
      <TabsContent value="strategy">
        <StrategyTab
          {...formAccess}
          onOpenAiAssistant={onOpenAiAssistant}
          onOpenVisualSelector={onOpenVisualSelector}
        />
      </TabsContent>
      <TabsContent value="clean"><CleanTab {...formAccess} /></TabsContent>
    </Tabs>
  );
}
