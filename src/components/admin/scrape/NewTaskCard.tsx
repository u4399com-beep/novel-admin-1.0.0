'use client'

/**
 * 新建采集任务区块：单本采集 / 范围采集（自 ScrapeCenter.tsx 原样拆分）。
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ListPlus } from 'lucide-react'
import type { ScrapeRuleDto } from '@/lib/types'
import { api } from './shared'

export function NewTaskCard({
  rules,
  onCreated,
}: {
  rules: ScrapeRuleDto[]
  onCreated: () => void
}) {
  const [mode, setMode] = useState<'single' | 'list'>('single')
  const [targetUrl, setTargetUrl] = useState('')
  const [ruleId, setRuleId] = useState<string>('none')
  const [pages, setPages] = useState('1')
  const [creating, setCreating] = useState(false)

  const selectedRule = rules.find((r) => String(r.id) === ruleId)

  const submit = async () => {
    const url = targetUrl.trim()
    if (!url) return toast.error('请输入目标 URL')
    let p = 1
    if (mode === 'list') {
      p = Math.floor(Number(pages) || 0)
      if (p < 1 || p > 20) return toast.error('列表页数需为 1-20 的整数')
    }
    setCreating(true)
    try {
      await api('/api/scrape-tasks', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          targetUrl: url,
          ruleId: ruleId === 'none' ? undefined : Number(ruleId),
          pages: p,
        }),
      })
      toast.success('采集任务已创建，开始执行')
      setTargetUrl('')
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <h4 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <ListPlus className="h-4 w-4" /> 新建采集任务
      </h4>

      <div className="space-y-3">
        <RadioGroup
          value={mode}
          onValueChange={(v) => setMode(v as 'single' | 'list')}
          className="flex flex-wrap gap-4"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="single" id="mode-single" />
            <Label htmlFor="mode-single" className="text-xs">
              单本采集（书页 URL）
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="list" id="mode-list" />
            <Label htmlFor="mode-list" className="text-xs">
              范围采集（列表页 URL）
            </Label>
          </div>
        </RadioGroup>

        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
          <div className="space-y-1">
            <Label className="text-xs">目标 URL</Label>
            <Input
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder={
                mode === 'single'
                  ? '书页地址，如 https://www.example.com/book/1.html'
                  : '列表页地址，如 https://www.example.com/sort/1/'
              }
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">采集规则</Label>
            <Select value={ruleId} onValueChange={setRuleId}>
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不使用规则</SelectItem>
                {rules.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {mode === 'list' && (
            <div className="space-y-1">
              <Label className="text-xs">列表页数（1-20）</Label>
              <Input
                type="number"
                min={1}
                max={20}
                value={pages}
                onChange={(e) => setPages(e.target.value)}
                className="h-8 w-28 text-xs"
              />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-neutral-400">
            {selectedRule
              ? `已选规则「${selectedRule.name}」（charset=${selectedRule.charset}）`
              : '不使用规则时将依赖引擎内置启发式提取；仅采集公开页面，引擎内置域名限速与 robots 提示。'}
          </p>
          <Button size="sm" onClick={submit} disabled={creating}>
            {creating ? '创建中…' : '创建任务'}
          </Button>
        </div>
      </div>
    </section>
  )
}
