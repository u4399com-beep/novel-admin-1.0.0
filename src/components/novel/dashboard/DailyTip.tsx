'use client';

import { useState, useEffect } from 'react';
import { Lightbulb, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const TIPS = [
  { title: '阅读节奏', content: '每阅读30分钟休息5分钟，有助于保持注意力和记忆力。' },
  { title: '采集优化', content: '为目标网站设置合理的采集间隔，避免触发反爬机制。' },
  { title: '分类管理', content: '善用分类和标签系统，可以帮助读者更快找到感兴趣的内容。' },
  { title: '章节编辑', content: '使用批量编辑功能可以同时修改多个章节的属性，提高效率。' },
  { title: '阅读目标', content: '设定每日阅读目标，坚持打卡可以培养良好的阅读习惯。' },
  { title: '数据备份', content: '定期导出小说数据，防止意外数据丢失。' },
  { title: '主题定制', content: '为不同站点设置不同的阅读主题，提供个性化的阅读体验。' },
  { title: '搜索引擎', content: '在搜索框中使用空格分隔多个关键词，可以更精确地查找内容。' },
];

export function DailyTip() {
  const [tip, setTip] = useState(TIPS[0]);
  const [key, setKey] = useState(0);

  useEffect(() => {
    queueMicrotask(() => setTip(TIPS[Math.floor(Math.random() * TIPS.length)]));
  }, [key]);

  return (
    <div className="rounded-xl border bg-card p-4 card-glow hover-scale">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10">
          <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
        </div>
        <span className="text-xs font-medium text-muted-foreground">每日提示</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6"
          onClick={() => setKey((k) => k + 1)}
          aria-label="换一条提示"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
      <p className="text-sm font-medium mb-1">{tip.title}</p>
      <p className="text-xs text-muted-foreground leading-relaxed">{tip.content}</p>
    </div>
  );
}
