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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Globe, FileText } from 'lucide-react';

const PAGE_SIZE_OPTIONS = ['10', '15', '20', '30'];

interface GeneralSettingsProps {
  siteName: string;
  siteDescription: string;
  itemsPerPage: string;
  onUpdate: (key: string, value: string) => void;
}

export function GeneralSettings({ siteName, siteDescription, itemsPerPage, onUpdate }: GeneralSettingsProps) {
  return (
    <Card className="card-border-glow">
      <CardHeader>
        <CardTitle className="text-base settings-section-title">基本设置</CardTitle>
        <CardDescription>配置站点基本信息和显示参数</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Section: Site Identity */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Globe className="h-3.5 w-3.5" />
            站点信息
          </div>
          <div className="form-group">
            <Label htmlFor="siteName">站点名称</Label>
            <Input
              id="siteName"
              value={siteName}
              onChange={(e) => onUpdate('siteName', e.target.value)}
              placeholder="请输入站点名称"
            />
          </div>

          <div className="form-group">
            <Label htmlFor="siteDescription">站点描述</Label>
            <Textarea
              id="siteDescription"
              value={siteDescription}
              onChange={(e) => onUpdate('siteDescription', e.target.value)}
              placeholder="请输入站点描述"
              rows={3}
            />
          </div>
        </div>

        <Separator />

        {/* Section: Display Settings */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <FileText className="h-3.5 w-3.5" />
            显示设置
          </div>
          <div className="form-group">
            <Label htmlFor="settings-page-size">每页显示数量</Label>
            <Select
              value={itemsPerPage}
              onValueChange={(v) => onUpdate('itemsPerPage', v)}
            >
              <SelectTrigger id="settings-page-size" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt} 条
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
