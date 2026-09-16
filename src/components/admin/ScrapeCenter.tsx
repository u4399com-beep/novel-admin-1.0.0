'use client'

/**
 * 采集中心面板（契约文件）：
 * - 默认导出、无 props、自包含（自己发请求/管理状态）
 * - 由管理控制台的「采集中心」区块渲染
 * - 后端 API 契约见 /api/scrape-tasks 与 /api/scrape-rules
 *
 * 三个子区块：
 *   1. 采集规则编辑（列表 + 编辑对话框 + 内置模板入库）
 *   2. 新建采集任务（单本采集 / 范围采集）
 *   3. 任务列表（状态徽章 / 进度 / 日志查看 / 取消 / 删除）
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { BookOpen, ListPlus, Pencil, Plus, ScrollText, Sparkles, Square, Trash2 } from 'lucide-react'
import { timeAgo } from '@/lib/format'
import type { BookRule, ChapterRule, ListRule, ScrapeRuleDto } from '@/lib/types'

// ==================== 通用 ====================

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(data.error ?? `请求失败(${res.status})`)
  return data as T
}

interface TaskRow {
  id: number
  ruleId: number | null
  mode: string
  targetUrl: string
  pages: number
  status: string
  total: number
  done: number
  chaptersDone: number
  chaptersTotal: number
  created: number
  updated: number
  chapters: number
  message: string
  createdAt: string
  updatedAt: string
}

interface TaskDetail extends TaskRow {
  log: string
  rule?: { id: number; name: string; charset: string } | null
}

/** 仅保留非空字符串字段 */
function cleanRule(obj: object): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

// ==================== 1. 采集规则编辑 ====================

interface RuleFormState {
  id: number | null
  name: string
  siteUrl: string
  enabled: boolean
  charset: string
  notes: string
  listRule: ListRule
  bookRule: BookRule
  chapterRule: ChapterRule
}

const EMPTY_RULE_FORM: RuleFormState = {
  id: null,
  name: '',
  siteUrl: '',
  enabled: true,
  charset: 'utf-8',
  notes: '',
  listRule: {},
  bookRule: {},
  chapterRule: {},
}

const CHARSETS = ['utf-8', 'gbk', 'gb2312', 'big5']

interface FieldDef {
  key: string
  label: string
  ph: string
}

const LIST_FIELDS: FieldDef[] = [
  { key: 'itemSelector', label: '列表项 itemSelector', ph: '如 #newscontent li / .book-item' },
  { key: 'titleSelector', label: '书名 titleSelector', ph: '如 .s2 a' },
  { key: 'linkSelector', label: '书籍链接 linkSelector', ph: '默认 a[href]' },
  { key: 'authorSelector', label: '作者 authorSelector', ph: '如 .s5（可选）' },
  { key: 'categorySelector', label: '分类 categorySelector', ph: '分类选择器（可选）' },
]

const BOOK_FIELDS: FieldDef[] = [
  { key: 'titleSelector', label: '书名 titleSelector', ph: '如 #info h1' },
  { key: 'authorSelector', label: '作者 authorSelector', ph: '如 #info p:first-of-type a' },
  { key: 'descriptionSelector', label: '简介 descriptionSelector', ph: '如 #intro' },
  { key: 'coverSelector', label: '封面 coverSelector', ph: '如 #fmimg img@src（可选）' },
  { key: 'statusSelector', label: '连载状态 statusSelector', ph: '如 .book-status（可选）' },
  { key: 'categorySelector', label: '分类 categorySelector', ph: '如 .book-cat（可选）' },
  { key: 'chapterLinkSelector', label: '章节链接 chapterLinkSelector', ph: '如 #list dl dd a' },
  { key: 'chapterTitleSelector', label: '章节标题 chapterTitleSelector', ph: '链接元素内标题选择器（可选）' },
]

const CHAPTER_FIELDS: FieldDef[] = [
  { key: 'titleSelector', label: '章节标题 titleSelector', ph: '如 .bookname h1' },
  { key: 'contentSelector', label: '正文容器 contentSelector', ph: '如 #content' },
  { key: 'nextSelector', label: '下一页链接 nextSelector', ph: '如 #link_next（可选）' },
]

function RuleFieldGroup({
  title,
  desc,
  fields,
  values,
  onChange,
}: {
  title: string
  desc: string
  fields: FieldDef[]
  values: ListRule | BookRule | ChapterRule
  onChange: (key: string, value: string) => void
}) {
  const rec = values as Record<string, string | undefined>
  return (
    <fieldset className="rounded-md border p-3">
      <legend className="px-1 text-xs font-semibold text-neutral-700">{title}</legend>
      <p className="mb-2 text-[11px] leading-relaxed text-neutral-400">{desc}</p>
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label className="text-[11px] font-medium text-neutral-500">{f.label}</Label>
            <Input
              value={rec[f.key] ?? ''}
              onChange={(e) => onChange(f.key, e.target.value)}
              placeholder={f.ph}
              className="h-8 text-xs"
            />
          </div>
        ))}
      </div>
    </fieldset>
  )
}

/** 规则编辑/新建对话框（父组件条件渲染 + key 挂载，避免 effect 同步 state） */
function RuleDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: ScrapeRuleDto | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<RuleFormState>(
    initial
      ? {
          id: initial.id,
          name: initial.name,
          siteUrl: initial.siteUrl,
          enabled: initial.enabled,
          charset: initial.charset,
          notes: initial.notes,
          listRule: initial.listRule ?? {},
          bookRule: initial.bookRule ?? {},
          chapterRule: initial.chapterRule ?? {},
        }
      : EMPTY_RULE_FORM,
  )
  const [saving, setSaving] = useState(false)

  const setGroup = (group: 'listRule' | 'bookRule' | 'chapterRule', key: string, value: string) =>
    setForm((f) => ({ ...f, [group]: { ...f[group], [key]: value } }))

  const save = async () => {
    if (!form.name.trim()) return toast.error('规则名称必填')
    const url = form.siteUrl.trim()
    if (!url) return toast.error('站点 URL 必填')
    // 与服务端 parseSiteUrl 对齐的前置校验：避免明显非法的 URL 走一趟请求才报错
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return toast.error('站点 URL 仅支持 http/https 协议')
      }
    } catch {
      return toast.error('站点 URL 格式不正确')
    }
    setSaving(true)
    try {
      await api('/api/scrape-rules', {
        method: 'PUT',
        body: JSON.stringify({
          id: form.id ?? undefined,
          name: form.name.trim(),
          siteUrl: form.siteUrl.trim(),
          enabled: form.enabled,
          charset: form.charset,
          notes: form.notes,
          listRule: cleanRule(form.listRule),
          bookRule: cleanRule(form.bookRule),
          chapterRule: cleanRule(form.chapterRule),
        }),
      })
      toast.success(form.id ? '规则已保存' : '规则已创建')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{form.id ? '编辑采集规则' : '新建采集规则'}</DialogTitle>
          <DialogDescription>
            选择器支持逗号分隔的备选与 <code>sel@attr</code> 取属性语法；留空的字段将使用引擎内置启发式。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">规则名称 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="如：笔趣阁系通用模板"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">站点 URL *</Label>
              <Input
                value={form.siteUrl}
                onChange={(e) => setForm((f) => ({ ...f, siteUrl: e.target.value }))}
                placeholder="https://www.example.com/"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">编码 charset</Label>
              <Select value={form.charset} onValueChange={(v) => setForm((f) => ({ ...f, charset: v }))}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHARSETS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pt-5">
              <Switch
                id="rule-enabled"
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
              <Label htmlFor="rule-enabled" className="text-xs">
                启用该规则
              </Label>
            </div>
          </div>

          <RuleFieldGroup
            title="列表页规则 listRule（范围采集）"
            desc="用于从列表/分类页批量提取书籍条目。"
            fields={LIST_FIELDS}
            values={form.listRule}
            onChange={(k, v) => setGroup('listRule', k, v)}
          />
          <RuleFieldGroup
            title="书籍页规则 bookRule（单本/范围共用）"
            desc="用于从书页提取书籍信息与章节链接列表。"
            fields={BOOK_FIELDS}
            values={form.bookRule}
            onChange={(k, v) => setGroup('bookRule', k, v)}
          />
          <RuleFieldGroup
            title="正文页规则 chapterRule"
            desc="用于抓取单章正文内容。"
            fields={CHAPTER_FIELDS}
            values={form.chapterRule}
            onChange={(k, v) => setGroup('chapterRule', k, v)}
          />

          <div className="space-y-1">
            <Label className="text-xs">备注 notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="站点结构说明、注意事项等"
              className="min-h-16 text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存规则'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RulesSection({ rules }: { rules: ScrapeRuleDto[] | undefined }) {
  const qc = useQueryClient()
  // undefined=关闭 / null=新建 / 规则对象=编辑
  const [dialogRule, setDialogRule] = useState<ScrapeRuleDto | null | undefined>(undefined)
  // 启停/删除进行中的规则 id（防重复提交）
  const [busyId, setBusyId] = useState<number | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['scrape-rules'] })

  const seed = async () => {
    try {
      const res = await api<{ added: number }>('/api/scrape-rules', {
        method: 'PUT',
        body: JSON.stringify({ seed: true }),
      })
      await refresh()
      toast.success(`内置模板入库完成：新增 ${res.added} 条`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  const toggleEnabled = async (r: ScrapeRuleDto, enabled: boolean) => {
    if (busyId !== null) return
    setBusyId(r.id)
    try {
      await api('/api/scrape-rules', {
        method: 'PUT',
        body: JSON.stringify({
          id: r.id,
          name: r.name,
          siteUrl: r.siteUrl,
          enabled,
          charset: r.charset,
          notes: r.notes,
          listRule: cleanRule(r.listRule),
          bookRule: cleanRule(r.bookRule),
          chapterRule: cleanRule(r.chapterRule),
        }),
      })
      await refresh()
      toast.success(`规则「${r.name}」已${enabled ? '启用' : '停用'}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (r: ScrapeRuleDto) => {
    if (busyId !== null) return
    if (!confirm(`确认删除规则「${r.name}」？此操作不可恢复。`)) return
    setBusyId(r.id)
    try {
      await api(`/api/scrape-rules?id=${r.id}`, { method: 'DELETE' })
      await refresh()
      toast.success('规则已删除')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <BookOpen className="h-4 w-4" /> 采集规则（{rules?.length ?? 0}）
        </h4>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={seed}>
            <Sparkles className="h-3.5 w-3.5" /> 内置模板入库
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialogRule(null)}>
            <Plus className="h-3.5 w-3.5" /> 新建规则
          </Button>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto">
        {rules === undefined ? (
          <p className="py-6 text-center text-xs text-neutral-400">规则加载中…</p>
        ) : rules.length === 0 ? (
          <p className="py-6 text-center text-xs text-neutral-400">
            暂无规则，点击「内置模板入库」或「新建规则」开始
          </p>
        ) : (
          <div className="space-y-1.5">
            {rules.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs transition hover:bg-neutral-50"
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={r.name}>
                  {r.name}
                </span>
                <span className="hidden max-w-40 truncate text-neutral-400 sm:inline" title={r.siteUrl}>
                  {truncate(r.siteUrl, 30)}
                </span>
                <Badge variant="outline" className="shrink-0 font-normal">
                  {r.charset}
                </Badge>
                <Switch checked={r.enabled} disabled={busyId === r.id} onCheckedChange={(v) => toggleEnabled(r, v)} aria-label={`启用规则 ${r.name}`} />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => setDialogRule(r)}
                  aria-label={`编辑规则 ${r.name}`}
                >
                  <Pencil className="h-3 w-3" /> 编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-red-500 hover:text-red-600"
                  disabled={busyId === r.id}
                  onClick={() => remove(r)}
                  aria-label={`删除规则 ${r.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {dialogRule !== undefined && (
        <RuleDialog
          key={dialogRule ? dialogRule.id : 'new'}
          initial={dialogRule}
          onClose={() => setDialogRule(undefined)}
          onSaved={refresh}
        />
      )}
    </section>
  )
}

// ==================== 2. 新建采集任务 ====================

function NewTaskSection({
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

// ==================== 3. 任务列表 ====================

const PAGE_SIZE = 20

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '待执行', cls: 'bg-neutral-200 text-neutral-600' },
  running: { label: '执行中', cls: 'bg-slate-500 text-white animate-pulse' },
  success: { label: '成功', cls: 'bg-emerald-600 text-white' },
  partial: { label: '部分成功', cls: 'bg-amber-500 text-white' },
  failed: { label: '失败', cls: 'bg-red-600 text-white' },
  canceled: { label: '已取消', cls: 'bg-neutral-400 text-white' },
}

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, cls: 'bg-neutral-200 text-neutral-600' }
  return <Badge className={`shrink-0 border-transparent ${meta.cls}`}>{meta.label}</Badge>
}

function ModeBadge({ mode }: { mode: string }) {
  return mode === 'list' ? (
    <Badge variant="secondary" className="shrink-0">
      范围
    </Badge>
  ) : (
    <Badge variant="outline" className="shrink-0">
      单本
    </Badge>
  )
}

/** 任务日志对话框（执行中的任务每 2s 刷新并自动滚到底部） */
function LogDialog({ task, onClose }: { task: TaskRow; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['scrape-task', task.id],
    queryFn: () => api<{ task: TaskDetail }>(`/api/scrape-tasks/${task.id}`),
    // 轮询开关跟随最新状态（而非打开时的快照），任务结束后自动停止
    refetchInterval: (query) => {
      const s = query.state.data?.task?.status ?? task.status
      return s === 'pending' || s === 'running' ? 2000 : false
    },
  })
  const detail = data?.task
  const preRef = useRef<HTMLPreElement>(null)
  const log = detail?.log ?? ''
  // 日志更新后滚动到底部（ref 副作用，无 state 同步）
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [log])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            任务 #{task.id} 日志 <StatusBadge status={detail?.status ?? task.status} />
          </DialogTitle>
          <DialogDescription className="break-all">
            {truncate(detail?.targetUrl ?? task.targetUrl, 80)}
            {detail?.message ? ` — ${detail.message}` : ''}
          </DialogDescription>
        </DialogHeader>
        <pre
          ref={preRef}
          className="max-h-96 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-neutral-950 p-3 font-mono text-[11px] leading-relaxed text-emerald-300"
        >
          {isLoading ? '日志加载中…' : log || '暂无日志'}
        </pre>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TaskListSection() {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [logTask, setLogTask] = useState<TaskRow | null>(null)
  // 取消/删除进行中的任务 id（防重复提交）
  const [busyId, setBusyId] = useState<number | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['scrape-tasks', page],
    queryFn: () =>
      api<{ list: TaskRow[]; total: number }>(`/api/scrape-tasks?page=${page}&pageSize=${PAGE_SIZE}`),
    refetchInterval: (query) => {
      const list = query.state.data?.list ?? []
      return list.some((t) => t.status === 'pending' || t.status === 'running') ? 3000 : false
    },
  })

  const rows = data?.list ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const refresh = () => qc.invalidateQueries({ queryKey: ['scrape-tasks'] })

  const cancel = async (t: TaskRow) => {
    if (busyId !== null) return
    setBusyId(t.id)
    try {
      await api(`/api/scrape-tasks/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'cancel' }),
      })
      await refresh()
      toast.success(`已发送取消指令（任务 #${t.id}）`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '取消失败')
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (t: TaskRow) => {
    if (busyId !== null) return
    setBusyId(t.id)
    try {
      await api(`/api/scrape-tasks/${t.id}`, { method: 'DELETE' })
      await refresh()
      toast.success('任务已删除')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold">采集任务（{total}）</h4>
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5 text-xs text-neutral-500">
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <span className="tabular-nums">
              {page} / {totalPages}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <p className="py-8 text-center text-xs text-neutral-400">任务加载中…</p>
      ) : rows.length === 0 ? (
        <p className="flex flex-wrap items-center justify-center gap-2 py-8 text-xs text-neutral-400">
          {page > 1 ? '当前页无任务' : '暂无采集任务，请在上方创建'}
          {page > 1 && (
            <Button size="sm" variant="outline" className="h-7" onClick={() => setPage(1)}>
              返回第一页
            </Button>
          )}
        </p>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 w-10 text-xs">ID</TableHead>
                <TableHead className="h-8 w-14 text-xs">模式</TableHead>
                <TableHead className="h-8 text-xs">目标 URL</TableHead>
                <TableHead className="h-8 w-20 text-xs">状态</TableHead>
                <TableHead className="h-8 w-32 text-xs">进度</TableHead>
                <TableHead className="hidden h-8 w-36 text-xs md:table-cell">成果</TableHead>
                <TableHead className="hidden h-8 w-20 text-xs md:table-cell">时间</TableHead>
                <TableHead className="h-8 w-24 text-right text-xs">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => {
                const pct = t.total > 0 ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0
                const active = t.status === 'pending' || t.status === 'running'
                return (
                  <TableRow key={t.id}>
                    <TableCell className="p-2 text-xs tabular-nums text-neutral-500">{t.id}</TableCell>
                    <TableCell className="p-2">
                      <ModeBadge mode={t.mode} />
                    </TableCell>
                    <TableCell className="max-w-0 p-2">
                      <span className="block truncate text-xs" title={t.targetUrl}>
                        {truncate(t.targetUrl, 40)}
                      </span>
                      {t.message && (
                        <span className="block truncate text-[11px] text-neutral-400" title={t.message}>
                          {truncate(t.message, 40)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="p-2">
                      <StatusBadge status={t.status} />
                    </TableCell>
                    <TableCell className="p-2">
                      <div className="flex items-center gap-1.5">
                        <span className="w-14 shrink-0 text-[11px] tabular-nums text-neutral-500">
                          {t.done}/{t.total}
                        </span>
                        <Progress value={pct} className="h-1.5 w-16" aria-label={`任务 ${t.id} 进度 ${pct}%`} />
                      </div>
                      {/* list 模式：主进度按「书」计，章节进度作副标题展示（single 模式主进度即章节，不重复展示） */}
                      {t.chaptersTotal > 0 && (
                        <span className="mt-0.5 block text-[10px] tabular-nums text-neutral-400">
                          已采集 {t.chaptersDone}/{t.chaptersTotal} 章
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden p-2 text-[11px] tabular-nums text-neutral-500 md:table-cell">
                      新建 {t.created} · 更新 {t.updated} · 章节 {t.chapters}
                    </TableCell>
                    <TableCell className="hidden p-2 text-[11px] text-neutral-400 md:table-cell">
                      {timeAgo(t.updatedAt)}
                    </TableCell>
                    <TableCell className="p-2 text-right">
                      <div className="flex justify-end gap-0.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-1.5"
                          title="查看日志"
                          aria-label={`查看任务 ${t.id} 日志`}
                          onClick={() => setLogTask(t)}
                        >
                          <ScrollText className="h-3.5 w-3.5" />
                        </Button>
                        {active && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5 text-amber-600 hover:text-amber-700"
                            disabled={busyId === t.id}
                            title="取消任务"
                            aria-label={`取消任务 ${t.id}`}
                            onClick={() => cancel(t)}
                          >
                            <Square className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-1.5 text-red-500 hover:text-red-600"
                          disabled={busyId === t.id}
                          title="删除任务"
                          aria-label={`删除任务 ${t.id}`}
                          onClick={() => remove(t)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {logTask && <LogDialog task={logTask} onClose={() => setLogTask(null)} />}
    </section>
  )
}

// ==================== 入口 ====================

export default function ScrapeCenter() {
  const qc = useQueryClient()
  const { data: rules } = useQuery({
    queryKey: ['scrape-rules'],
    queryFn: () => api<ScrapeRuleDto[]>('/api/scrape-rules'),
  })
  const taskSectionRef = useRef<HTMLElement>(null)
  const [taskListKey, setTaskListKey] = useState(0)

  const handleCreated = () => {
    void qc.invalidateQueries({ queryKey: ['scrape-tasks'] })
    setTaskListKey((k) => k + 1) // 重挂载任务列表，回到第 1 页
    taskSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="space-y-4">
      <RulesSection rules={rules} />
      <NewTaskSection rules={rules ?? []} onCreated={handleCreated} />
      <section ref={taskSectionRef}>
        <TaskListSection key={taskListKey} />
      </section>
    </div>
  )
}
