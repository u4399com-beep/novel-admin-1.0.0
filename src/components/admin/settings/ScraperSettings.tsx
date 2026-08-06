'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';

interface ScraperSettingsProps {
  scrapeInterval: number;
  concurrentTasks: number;
  autoPublish: boolean;
  onUpdate: (key: string, value: unknown) => void;
}

export function ScraperSettings({ scrapeInterval, concurrentTasks, autoPublish, onUpdate }: ScraperSettingsProps) {
  return (
    <Card className="card-border-glow">
      <CardHeader>
        <CardTitle className="text-base">采集设置</CardTitle>
        <CardDescription>配置采集任务的默认行为参数</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="form-group">
          <Label htmlFor="scrapeInterval">默认采集间隔</Label>
          <div className="stack-responsive">
            <Input
              id="scrapeInterval"
              type="number"
              min={1}
              value={scrapeInterval}
              onChange={(e) => onUpdate('scrapeInterval', Math.max(1, Number(e.target.value) || 1))}
              className="w-32"
            />
            <span className="text-sm text-muted-foreground">分钟</span>
          </div>
        </div>

        <div className="form-group">
          <Label htmlFor="concurrentTasks">并发采集数</Label>
          <Input
            id="concurrentTasks"
            type="number"
            min={1}
            max={10}
            value={concurrentTasks}
            onChange={(e) => onUpdate('concurrentTasks', Math.min(10, Math.max(1, Number(e.target.value))))}
            className="w-32"
          />
          <p className="form-hint">建议值 1-10，过高可能导致服务器压力过大</p>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>自动发布</Label>
            <p className="form-hint mt-0.5">
              采集完成后自动发布小说和章节
            </p>
          </div>
          <Switch
            checked={autoPublish}
            onCheckedChange={(v) => onUpdate('autoPublish', v)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
