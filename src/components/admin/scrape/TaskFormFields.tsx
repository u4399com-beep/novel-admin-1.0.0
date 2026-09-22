'use client'

/**
 * 任务表单公共件（新建任务与任务编辑对话框共用）：
 * - TaskFormState：表单字段值（数值字段保持字符串态便于输入，ruleId 以 'none' 表示不使用规则）
 * - parseTaskForm：与后端同口径校验并序列化为可提交字段
 * - TaskFormFields：表单控件（模式 / 目标 URL / 采集规则 / 列表页数+起始页 / 并发数）
 * 边界常量与校验规则对齐 /api/scrape-tasks 的 POST 与 PATCH action:'edit' 实现。
 */

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ScrapeRuleDto } from '@/lib/types'
import type { TaskRow } from './types'

/** 列表页数上限（页数上限放宽到 2000，仅防畸形输入） */
export const MAX_PAGES = 2000
/** 任务内并发度上限（list=同时采集书本数，single=同时抓取章节数） */
export const MAX_CONCURRENCY = 16

/** 表单字段值 */
export interface TaskFormState {
  mode: 'single' | 'list'
  targetUrl: string
  ruleId: string
  pages: string
  startPage: string
  concurrency: string
}

/** 新建表单默认值（调用方可覆写 mode 等） */
export function emptyTaskForm(mode: 'single' | 'list' = 'single'): TaskFormState {
  return { mode, targetUrl: '', ruleId: 'none', pages: '1', startPage: '1', concurrency: '3' }
}

/** 从任务行预填编辑表单 */
export function taskFormFromRow(t: TaskRow): TaskFormState {
  return {
    mode: t.mode === 'list' ? 'list' : 'single',
    targetUrl: t.targetUrl,
    ruleId: t.ruleId === null ? 'none' : String(t.ruleId),
    pages: String(t.pages ?? 1),
    startPage: String(t.startPage ?? 1),
    concurrency: String(t.concurrency ?? 3),
  }
}

type ParsedTaskForm = {
  mode: 'single' | 'list'
  targetUrl: string
  ruleId: number | null
  pages: number
  startPage: number
  concurrency: number
}

/**
 * 校验并序列化表单（与后端校验同口径）。
 * pages/startPage 仅 list 模式有业务意义：single 模式恒提交 1（与后端默认一致）。
 */
export function parseTaskForm(form: TaskFormState): ({ ok: true } & ParsedTaskForm) | { ok: false; error: string } {
  const url = form.targetUrl.trim()
  if (!url) return { ok: false, error: '请输入目标 URL' }
  const mode = form.mode === 'list' ? 'list' : 'single'

  let pages = 1
  if (mode === 'list') {
    pages = Math.floor(Number(form.pages) || 0)
    if (pages < 1 || pages > MAX_PAGES) return { ok: false, error: `列表页数需为 1-${MAX_PAGES} 的整数` }
  }

  let startPage = 1
  if (mode === 'list') {
    startPage = Math.floor(Number(form.startPage) || 0)
    if (startPage < 1) return { ok: false, error: '起始页需为正整数' }
  }

  const concurrency = Math.floor(Number(form.concurrency) || 0)
  if (concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return { ok: false, error: `并发数需为 1-${MAX_CONCURRENCY} 的整数` }
  }

  const rid = Number(form.ruleId)
  const ruleId = form.ruleId !== 'none' && Number.isInteger(rid) && rid > 0 ? rid : null
  return { ok: true, mode, targetUrl: url, ruleId, pages, startPage, concurrency }
}

/** 任务表单控件：模式 / 目标 URL / 采集规则 / 列表页数+起始页（list 模式）/ 并发数 */
export function TaskFormFields({
  form,
  rules,
  onChange,
  idPrefix = 'new-task',
}: {
  form: TaskFormState
  rules: ScrapeRuleDto[]
  /** 局部更新表单字段（父组件持有状态） */
  onChange: (patch: Partial<TaskFormState>) => void
  /** RadioGroupItem 的 id 前缀（新建/编辑同页共存时避免 id 冲突） */
  idPrefix?: string
}) {
  const isList = form.mode === 'list'
  return (
    <div className="space-y-3">
      <RadioGroup
        value={form.mode}
        onValueChange={(v) => onChange({ mode: v as 'single' | 'list' })}
        className="flex flex-wrap gap-4"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="single" id={`${idPrefix}-mode-single`} />
          <Label htmlFor={`${idPrefix}-mode-single`} className="text-xs">
            单本采集（书页 URL）
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="list" id={`${idPrefix}-mode-list`} />
          <Label htmlFor={`${idPrefix}-mode-list`} className="text-xs">
            范围采集（列表页 URL）
          </Label>
        </div>
      </RadioGroup>

      {/* 列模式随 mode 增减：list 多出「列表页数 / 起始页」两列；移动端单列堆叠不横向溢出 */}
      <div className={`grid gap-2 ${isList ? 'sm:grid-cols-[1fr_auto_auto_auto_auto]' : 'sm:grid-cols-[1fr_auto_auto_auto]'}`}>
        <div className="min-w-0 space-y-1">
          <Label className="text-xs">目标 URL</Label>
          <Input
            value={form.targetUrl}
            onChange={(e) => onChange({ targetUrl: e.target.value })}
            placeholder={
              isList
                ? '列表页地址，如 https://www.example.com/sort/1/'
                : '书页地址，如 https://www.example.com/book/1.html'
            }
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">采集规则</Label>
          <Select value={form.ruleId} onValueChange={(v) => onChange({ ruleId: v })}>
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
        {isList && (
          <>
            <div className="space-y-1">
              <Label className="text-xs">列表页数（1-{MAX_PAGES}）</Label>
              <Input
                type="number"
                min={1}
                max={MAX_PAGES}
                value={form.pages}
                onChange={(e) => onChange({ pages: e.target.value })}
                className="h-8 w-20 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">起始页</Label>
              <Input
                type="number"
                min={1}
                value={form.startPage}
                onChange={(e) => onChange({ startPage: e.target.value })}
                className="h-8 w-20 text-xs"
                title="列表起始页码（正整数），可从任意页开始采集"
              />
            </div>
          </>
        )}
        <div className="space-y-1">
          <Label className="text-xs">并发数（1-{MAX_CONCURRENCY}）</Label>
          <Input
            type="number"
            min={1}
            max={MAX_CONCURRENCY}
            value={form.concurrency}
            onChange={(e) => onChange({ concurrency: e.target.value })}
            className="h-8 w-20 text-xs"
            title={isList ? '任务内并发度：同时采集的书本数' : '任务内并发度：同时抓取的章节数'}
          />
        </div>
      </div>
    </div>
  )
}
