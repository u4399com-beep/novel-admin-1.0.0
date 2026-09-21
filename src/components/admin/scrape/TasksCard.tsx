'use client'

/**
 * 采集任务列表区块：状态徽章 / 双口径进度 / 日志查看 / 暂停 / 恢复 / 取消 / 删除 / 分页。
 * 自 ScrapeCenter.tsx 原样拆分（执行中任务列表 3s 轮询、终态自停等行为不变）。
 * 用户指令「任务可编辑，可随时暂停/重启」：执行中/待执行可暂停（协作式安全停手、进度
 * 保留），已暂停可恢复（重新入队续传）或直接编辑参数后再恢复。
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Pencil, Pause, Play, ScrollText, Square, Trash2 } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ScrapeRuleDto } from '@/lib/types'
import { timeAgo } from '@/lib/format'
import { runBusy } from '../ui-shared'
import { api, truncate } from './shared'
import type { TaskDetail, TaskRow } from './types'

const PAGE_SIZE = 20

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '待执行', cls: 'bg-neutral-200 text-neutral-600' },
  running: { label: '执行中', cls: 'bg-slate-500 text-white animate-pulse' },
  paused: { label: '已暂停', cls: 'bg-violet-600 text-white' },
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

/**
 * 编辑待执行/已暂停任务对话框（用户指令「采集任务要可编辑」）：
 * pending/paused 任务开放入口；running/终态由 API 409 拒绝，前端也不展示按钮。
 * paused 编辑的意义：暂停 → 改参数（换规则/换目标/扩页数）→ 恢复，按新参数续采。
 * 字段与新建任务同口径：mode/targetUrl/ruleId/pages，局部提交（只传修改过的字段）。
 */
function EditTaskDialog({
  task,
  rules,
  onClose,
  onSaved,
}: {
  task: TaskRow
  rules: ScrapeRuleDto[]
  onClose: () => void
  onSaved: () => void
}) {
  const [mode, setMode] = useState<'single' | 'list'>(task.mode === 'list' ? 'list' : 'single')
  const [targetUrl, setTargetUrl] = useState(task.targetUrl)
  const [ruleId, setRuleId] = useState<string>(task.ruleId ? String(task.ruleId) : 'none')
  const [pages, setPages] = useState(String(task.pages ?? 1))
  const [saving, setSaving] = useState(false)

  const submit = () => {
    const url = targetUrl.trim()
    if (!url) return toast.error('请输入目标 URL')
    let p = 1
    if (mode === 'list') {
      p = Math.floor(Number(pages) || 0)
      if (p < 1 || p > 999) return toast.error('列表页数需为 1-999 的整数')
    }
    // 局部提交：仅携带变化的字段，减少与并发操作的冲突面
    const body: Record<string, unknown> = {}
    if (mode !== task.mode) body.mode = mode
    if (url !== task.targetUrl) body.targetUrl = url
    const nextRule = ruleId === 'none' ? null : Number(ruleId)
    if (nextRule !== (task.ruleId ?? null)) body.ruleId = nextRule
    if (mode === 'list' && p !== task.pages) body.pages = p
    if (Object.keys(body).length === 0) {
      toast.info('没有修改任何字段')
      onClose()
      return
    }
    return runBusy(setSaving, true, false, '保存失败', async () => {
      await api(`/api/scrape-tasks/${task.id}`, { method: 'PUT', body: JSON.stringify(body) })
      toast.success(`任务 #${task.id} 已更新`)
      onSaved()
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">编辑任务 #{task.id}</DialogTitle>
          <DialogDescription>仅待执行 / 已暂停状态的任务可修改参数（暂停中改完再恢复即按新参数续采）</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as 'single' | 'list')}
            className="flex flex-wrap gap-4"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="single" id={`edit-mode-single-${task.id}`} />
              <Label htmlFor={`edit-mode-single-${task.id}`} className="text-xs">
                单本采集（书页 URL）
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="list" id={`edit-mode-list-${task.id}`} />
              <Label htmlFor={`edit-mode-list-${task.id}`} className="text-xs">
                范围采集（列表页 URL）
              </Label>
            </div>
          </RadioGroup>
          <div className="space-y-1">
            <Label className="text-xs">目标 URL</Label>
            <Input
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">采集规则</Label>
              <Select value={ruleId} onValueChange={setRuleId}>
                <SelectTrigger className="h-8 text-xs">
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
                <Label className="text-xs">列表页数（1-999）</Label>
                <Input
                  type="number"
                  min={1}
                  max={999}
                  value={pages}
                  onChange={(e) => setPages(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TasksCard({ rules = [] }: { rules?: ScrapeRuleDto[] }) {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [logTask, setLogTask] = useState<TaskRow | null>(null)
  const [editTask, setEditTask] = useState<TaskRow | null>(null)
  // 暂停/恢复/取消/删除/编辑进行中的任务 id（防重复提交）
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

  const cancel = (t: TaskRow) => {
    if (busyId !== null) return
    return runBusy(setBusyId, t.id, null, '取消失败', async () => {
      await api(`/api/scrape-tasks/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'cancel' }),
      })
      await refresh()
      toast.success(`已发送取消指令（任务 #${t.id}）`)
    })
  }

  /** 暂停：执行中任务由 worker 协作式感知，数秒内在安全点停手（进度保留） */
  const pause = (t: TaskRow) => {
    if (busyId !== null) return
    return runBusy(setBusyId, t.id, null, '暂停失败', async () => {
      await api(`/api/scrape-tasks/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'pause' }),
      })
      await refresh()
      toast.success(`已发送暂停指令（任务 #${t.id}），执行中任务会在数秒内安全停手`)
    })
  }

  /** 恢复：重新入队 pending，runner 领取后按已采进度自动续传 */
  const resume = (t: TaskRow) => {
    if (busyId !== null) return
    return runBusy(setBusyId, t.id, null, '恢复失败', async () => {
      await api(`/api/scrape-tasks/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'resume' }),
      })
      await refresh()
      toast.success(`任务 #${t.id} 已恢复，等待 runner 领取继续采集`)
    })
  }

  const remove = (t: TaskRow) => {
    if (busyId !== null) return
    return runBusy(setBusyId, t.id, null, '删除失败', async () => {
      await api(`/api/scrape-tasks/${t.id}`, { method: 'DELETE' })
      // 末页删空自愈：当前页仅剩这一条且不是第一页时回退一页（与书籍列表口径一致）
      if (rows.length === 1 && page > 1) setPage(page - 1)
      await refresh()
      toast.success('任务已删除')
    })
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
                <TableHead className="h-8 w-28 text-right text-xs">操作</TableHead>
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
                        {(t.status === 'pending' || t.status === 'paused') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5"
                            disabled={busyId === t.id}
                            title="编辑任务（待执行/已暂停）"
                            aria-label={`编辑任务 ${t.id}`}
                            onClick={() => setEditTask(t)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {active && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5 text-violet-600 hover:text-violet-700"
                            disabled={busyId === t.id}
                            title="暂停任务（进度保留，可恢复）"
                            aria-label={`暂停任务 ${t.id}`}
                            onClick={() => pause(t)}
                          >
                            <Pause className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {t.status === 'paused' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5 text-emerald-600 hover:text-emerald-700"
                            disabled={busyId === t.id}
                            title="恢复任务（重新入队续采）"
                            aria-label={`恢复任务 ${t.id}`}
                            onClick={() => resume(t)}
                          >
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                        )}
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
      {editTask && (
        <EditTaskDialog
          task={editTask}
          rules={rules}
          onClose={() => setEditTask(null)}
          onSaved={refresh}
        />
      )}
    </section>
  )
}
