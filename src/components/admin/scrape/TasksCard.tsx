'use client'

/**
 * 采集任务列表区块：状态徽章 / 双口径进度 / 日志查看 / 编辑 / 重新采集 / 取消 / 删除 / 分页。
 * 自 ScrapeCenter.tsx 原样拆分（执行中任务列表 3s 轮询、终态自停等行为不变）。
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
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Pencil, RotateCcw, ScrollText, Square, Trash2 } from 'lucide-react'
import { timeAgo } from '@/lib/format'
import type { ScrapeRuleDto } from '@/lib/types'
import { runBusy } from '../ui-shared'
import { api, truncate } from './shared'
import { TaskFormFields, parseTaskForm, taskFormFromRow, type TaskFormState } from './TaskFormFields'
import type { TaskDetail, TaskRow } from './types'

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

/** 终态集合（与后端一致）：可重新采集 */
const TERMINAL_STATUSES = new Set(['success', 'partial', 'failed', 'canceled'])

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
 * 任务编辑对话框：复用新建表单的控件与校验（TaskFormFields），预填当前任务值，
 * 保存走 PATCH action:'edit'（执行中任务后端返回 409，由 api/runBusy 统一 toast 后端文案）。
 */
function EditTaskDialog({
  task,
  onClose,
  onSaved,
}: {
  task: TaskRow
  onClose: () => void
  onSaved: () => void
}) {
  // 规则下拉复用 ScrapeCenter 的规则列表缓存（同 queryKey，无额外请求）
  const { data: rules = [] } = useQuery({
    queryKey: ['scrape-rules'],
    queryFn: () => api<ScrapeRuleDto[]>('/api/scrape-rules'),
  })
  const [form, setForm] = useState<TaskFormState>(() => taskFormFromRow(task))
  const [saving, setSaving] = useState(false)

  const save = () => {
    const parsed = parseTaskForm(form)
    if (!parsed.ok) return toast.error(parsed.error)
    return runBusy(setSaving, true, false, '保存失败', async () => {
      await api(`/api/scrape-tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'edit',
          mode: parsed.mode,
          targetUrl: parsed.targetUrl,
          ruleId: parsed.ruleId,
          pages: parsed.pages,
          startPage: parsed.startPage,
          concurrency: parsed.concurrency,
        }),
      })
      toast.success(`任务 #${task.id} 已更新`)
      onSaved()
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">编辑任务 #{task.id}</DialogTitle>
          <DialogDescription>修改任务配置后保存生效；执行中任务需先取消才能编辑。</DialogDescription>
        </DialogHeader>
        <TaskFormFields
          form={form}
          rules={rules}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          idPrefix="edit-task"
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function TasksCard() {
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [logTask, setLogTask] = useState<TaskRow | null>(null)
  const [editTask, setEditTask] = useState<TaskRow | null>(null)
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

  const rerun = (t: TaskRow) => {
    if (busyId !== null) return
    return runBusy(setBusyId, t.id, null, '重新采集失败', async () => {
      await api(`/api/scrape-tasks/${t.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'rerun' }),
      })
      await refresh()
      toast.success('任务已重新排队')
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
                const running = t.status === 'running'
                const active = t.status === 'pending' || running
                const terminal = TERMINAL_STATUSES.has(t.status)
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
                      <div className="flex flex-wrap justify-end gap-0.5">
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
                        {!running && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5"
                            disabled={busyId === t.id}
                            title="编辑任务"
                            aria-label={`编辑任务 ${t.id}`}
                            onClick={() => setEditTask(t)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {terminal && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-1.5 text-emerald-600 hover:text-emerald-700"
                            disabled={busyId === t.id}
                            title="重新采集（重置进度并重新排队执行）"
                            aria-label={`重新采集任务 ${t.id}`}
                            onClick={() => rerun(t)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
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
          onClose={() => setEditTask(null)}
          onSaved={() => {
            setEditTask(null)
            refresh()
          }}
        />
      )}
    </section>
  )
}
