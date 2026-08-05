'use client';

import { useState, useEffect } from 'react';
import { Brain, Sparkles } from 'lucide-react';
import { Progress } from '@/components/ui/progress';

export function AnalyzingView({ url }: { url: string }) {
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('正在连接目标站点...');

  useEffect(() => {
    const stages = [
      { at: 5, text: '正在连接目标站点...' },
      { at: 15, text: '正在获取页面内容...' },
      { at: 30, text: '正在分析页面结构...' },
      { at: 45, text: '正在识别列表页模式...' },
      { at: 55, text: '正在识别书籍信息字段...' },
      { at: 65, text: '正在生成选择器规则...' },
      { at: 75, text: '正在测试选择器匹配...' },
      { at: 85, text: '正在优化反爬策略...' },
      { at: 95, text: '正在生成最终配置...' },
    ];

    const interval = setInterval(() => {
      setProgress((prev) => {
        const next = Math.min(prev + Math.random() * 8 + 1, 99);
        const stage = [...stages].reverse().find((s) => next >= s.at);
        if (stage) setStatusText(stage.text);
        return next;
      });
    }, 600);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12">
      {/* Animated brain/sparkles */}
      <div className="relative">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
          <Brain className="h-10 w-10 text-primary animate-pulse" />
        </div>
        <Sparkles className="absolute -top-2 -right-2 h-5 w-5 text-primary/60 animate-bounce" />
        <Sparkles className="absolute -bottom-1 -left-3 h-4 w-4 text-primary/40 animate-bounce [animation-delay:150ms]" />
      </div>

      <div className="space-y-2 text-center">
        <h3 className="text-sm font-semibold">AI 正在分析页面</h3>
        <p className="text-xs text-muted-foreground max-w-xs">{statusText}</p>
      </div>

      <div className="w-full max-w-sm space-y-2">
        <Progress value={progress} className="h-2" />
        <p className="text-center text-[10px] text-muted-foreground">
          目标: {url}
        </p>
      </div>

      {/* Animated dots */}
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-2 w-2 rounded-full bg-primary/40 animate-bounce"
            style={{ animationDelay: `${i * 200}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
