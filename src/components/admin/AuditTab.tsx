'use client'

/**
 * 目录体检面板：全站章节目录健康度扫描（重复标题 / idx 断档 / 编号乱序 / 空骨架），
 * 支持单书一键去重与按「第N章」编号重排。数据源 /api/chapters/audit。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshCw, Wand2, ArrowDownUp } from 'lucide-react'
import { api, runBusy } from './ui-shared'

interface AuditItem {
  novelId: number
  title: string
  chapters: number
  dupGroups: number
  dupRows: number
  idxGaps: number
  emptyRows: number
  disordered: boolean
  disorderSamples: string[]
}

interface AuditOverview {
  mode: string
  novels: number
  healthy: number
  problem: AuditItem[]
}

export function AuditTab() {
  const [report, setReport] = useState<AuditOverview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const scan = () =>
    runBusy(setBusy, 'scan', null, '体检失败', async () => {
      const d = await api<AuditOverview>('/api/chapters/audit')
      setReport(d)
      toast.success(`体检完成：${d.healthy}/${d.novels} 本健康`)
    })

  const fix = (item: AuditItem, action: 'dedupe' | 'reindex') =>
    runBusy(setBusy, `${action}-${item.novelId}`, null, '修复失败', async () => {
      const d = await api<{ removed: number; moved: number }>(`/api/chapters/audit`, {
        method: 'POST',
        body: JSON.stringify({ action, novelId: item.novelId }),
      })
      toast.success(
        action === 'dedupe'
          ? `《${item.title.slice(0, 16)}》去重完成：删除 ${d.removed} 行`
          : `《${item.title.slice(0, 16)}》重排完成：移动 ${d.moved} 行`,
      )
      await scan()
    })

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={scan} disabled={busy === 'scan'}>
          <RefreshCw className={`mr-1 h-3.5 w-3.5 ${busy === 'scan' ? 'animate-spin' : ''}`} aria-hidden />
          {busy === 'scan' ? '体检中…' : '全站目录体检'}
        </Button>
        <p className="text-xs text-neutral-500">
          检测同名重复章、idx 断档、「第N章」编号乱序与空骨架（采集进行中空骨架属正常，不影响判定）
        </p>
      </div>

      {report && (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">共 {report.novels} 本</Badge>
            <Badge variant="outline">健康 {report.healthy} 本</Badge>
            <Badge variant={report.problem.length ? 'destructive' : 'outline'}>问题 {report.problem.length} 本</Badge>
          </div>

          {report.problem.length === 0 ? (
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
              全部书目目录健康，无需修复。
            </p>
          ) : (
            <div className="max-h-96 space-y-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
              {report.problem.map((p) => (
                <div key={p.novelId} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      #{p.novelId} 《{p.title}》
                    </span>
                    <span className="text-[11px] text-neutral-400">{p.chapters} 章</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {p.dupRows > 0 && <Badge variant="destructive">重复 {p.dupRows} 行</Badge>}
                    {p.idxGaps > 0 && <Badge variant="destructive">断档 {p.idxGaps}</Badge>}
                    {p.disordered && <Badge variant="secondary">编号乱序</Badge>}
                    <div className="ml-auto flex gap-1.5">
                      {p.dupRows > 0 && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy !== null} onClick={() => fix(p, 'dedupe')}>
                          <Wand2 className="mr-1 h-3 w-3" aria-hidden />
                          {busy === `dedupe-${p.novelId}` ? '处理中…' : '去重'}
                        </Button>
                      )}
                      {(p.disordered || p.idxGaps > 0) && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy !== null} onClick={() => fix(p, 'reindex')}>
                          <ArrowDownUp className="mr-1 h-3 w-3" aria-hidden />
                          {busy === `reindex-${p.novelId}` ? '处理中…' : '重排'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {p.disordered && p.disorderSamples.length > 0 && (
                    <p className="mt-1.5 truncate text-[11px] text-neutral-400">例：{p.disorderSamples[0]}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {!report && busy !== 'scan' && <p className="text-sm text-neutral-400">点击「全站目录体检」开始扫描。</p>}
    </div>
  )
}
