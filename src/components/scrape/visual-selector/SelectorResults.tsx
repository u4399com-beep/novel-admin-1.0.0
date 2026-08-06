'use client';

import { useState } from 'react';
import { AlertCircle, Copy, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SelectorMatch } from './types';

interface SelectorResultsProps {
  selectorValue: string;
  selectorType: 'css' | 'xpath' | 'regex';
  matches: SelectorMatch[];
  testing: boolean;
  onSelectorValueChange: (value: string) => void;
  onSelectorTypeChange: (type: 'css' | 'xpath' | 'regex') => void;
  onTest: () => void;
  onCopy: () => void;
}

export function SelectorResults({
  selectorValue,
  selectorType,
  matches,
  testing,
  onSelectorValueChange,
  onSelectorTypeChange,
  onTest,
  onCopy,
}: SelectorResultsProps) {
  return (
    <div className="space-y-4">
      {/* Selector Input */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">选择器</Label>
        <div className="flex gap-2">
          <Select
            value={selectorType}
            onValueChange={(v) =>
              onSelectorTypeChange(v as 'css' | 'xpath' | 'regex')
            }
          >
            <SelectTrigger className="w-[120px] shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="css">CSS选择器</SelectItem>
              <SelectItem value="xpath">XPath</SelectItem>
              <SelectItem value="regex">正则表达式</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="flex-1 font-mono text-sm"
            placeholder={
              selectorType === 'css'
                ? '.class-name, #id, div > p'
                : selectorType === 'xpath'
                  ? '//div[@class="name"]'
                  : '正则表达式'
            }
            value={selectorValue}
            onChange={(e) => onSelectorValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onTest();
            }}
          />
          <Button
            variant="outline"
            size="icon"
            className="shrink-0"
            aria-label="复制"
            onClick={onCopy}
            title="复制"
          >
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            onClick={onTest}
            disabled={testing}
            className="gap-1.5 shrink-0"
          >
            {testing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            测试
          </Button>
        </div>
      </div>

      {/* Matches */}
      <MatchedElements matches={matches} />
    </div>
  );
}

function MatchedElements({ matches }: { matches: SelectorMatch[] }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  if (matches.length === 0) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        未找到匹配的元素
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          找到 {matches.length} 个匹配元素
        </span>
        <Badge variant="secondary" className="text-xs">
          {matches.length} 匹配
        </Badge>
      </div>
      <ScrollArea className="h-[250px] w-full rounded-lg border">
        <div className="p-2 space-y-1">
          {matches.slice(0, 50).map((match, i) => (
            <div key={i}>
              <button
                className="w-full text-left rounded-md px-2 py-1.5 text-xs hover:bg-muted/60 transition-colors flex items-center gap-2"
                onClick={() =>
                  setExpandedIndex(expandedIndex === i ? null : i)
                }
              >
                <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5">
                  {match.tag}
                </Badge>
                <span className="truncate font-mono text-foreground/70">
                  {match.text || '(无文本内容)'}
                </span>
              </button>
              {expandedIndex === i && (
                <div className="ml-6 mt-1 rounded-md bg-muted/40 p-2 space-y-1">
                  {Object.entries(match.attrs).slice(0, 5).map(([key, val]) => (
                    <p key={key} className="text-[10px] font-mono text-muted-foreground">
                      <span className="text-foreground/60">{key}</span>=
                      <span className="text-primary/80">&quot;{val}&quot;</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
          {matches.length > 50 && (
            <p className="text-xs text-center text-muted-foreground py-2">
              还有 {matches.length - 50} 个匹配元素未显示...
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
