'use client'

/**
 * 新建采集任务区块：单本采集 / 范围采集（自 ScrapeCenter.tsx 原样拆分）。
 * 表单控件与校验由 TaskFormFields 提供（与任务编辑对话框共用）。
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ListPlus } from 'lucide-react'
import type { ScrapeRuleDto } from '@/lib/types'
import { runBusy } from '../ui-shared'
import { api } from './shared'
import { TaskFormFields, emptyTaskForm, parseTaskForm, type TaskFormState } from './TaskFormFields'

export function NewTaskCard({
  rules,
  onCreated,
}: {
  rules: ScrapeRuleDto[]
  onCreated: () => void
}) {
  const [form, setForm] = useState<TaskFormState>(emptyTaskForm())
  const [creating, setCreating] = useState(false)

  const selectedRule = rules.find((r) => String(r.id) === form.ruleId)

  const submit = () => {
    const parsed = parseTaskForm(form)
    if (!parsed.ok) return toast.error(parsed.error)
    return runBusy(setCreating, true, false, '创建失败', async () => {
      await api('/api/scrape-tasks', {
        method: 'POST',
        body: JSON.stringify({
          mode: parsed.mode,
          targetUrl: parsed.targetUrl,
          ruleId: parsed.ruleId ?? undefined,
          pages: parsed.pages,
          startPage: parsed.startPage,
          concurrency: parsed.concurrency,
        }),
      })
      toast.success('采集任务已创建，开始执行')
      // 保留当前模式与规则，仅清空 URL，便于连续创建多个任务并行采集
      setForm((f) => ({ ...f, targetUrl: '' }))
      onCreated()
    })
  }

  return (
    <section className="rounded-lg border p-4">
      <h4 className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
        <ListPlus className="h-4 w-4" /> 新建采集任务
      </h4>

      <TaskFormFields form={form} rules={rules} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5 text-[11px] text-neutral-400">
          <p>
            {selectedRule
              ? `已选规则「${selectedRule.name}」（charset=${selectedRule.charset}）`
              : '不使用规则时将依赖引擎内置启发式提取；仅采集公开页面，引擎内置域名限速与 robots 提示。'}
          </p>
          <p>任务间天然并行：可连续创建多个任务同时采集；任务内并发度可调。</p>
        </div>
        <Button size="sm" onClick={submit} disabled={creating}>
          {creating ? '创建中…' : '创建任务'}
        </Button>
      </div>
    </section>
  )
}
