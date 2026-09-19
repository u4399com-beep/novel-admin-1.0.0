'use client'

/**
 * 封面回填卡：展示封面本地化覆盖统计 + 一键回填。
 *
 * 背景：采集时封面可能因图床限流/代理瞬断落盘失败（书仍以渐变 token 入库），
 * remoteCoverUrl + sourceRuleId 已随书籍入库持久化，POST /api/scrape/covers-backfill
 * 凭此按站点代理出口批量重试下载并转 webp 落盘。
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ImageDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, runBusy } from '@/components/admin/ui-shared'
import { qk } from '@/hooks/use-novel-data'
import { useState } from 'react'

interface CoverStats {
  total: number
  local: number
  gradient: number
  backfillable: number
}

interface BackfillResult {
  attempted: number
  upgraded: number
  failed: number
  remaining: number
}

export function CoversCard() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const { data: stats } = useQuery({
    queryKey: ['covers-stats'],
    queryFn: () => api<CoverStats>('/api/scrape/covers-backfill'),
    refetchInterval: 60_000,
  })

  const backfillable = stats?.backfillable ?? 0

  const runBackfill = () =>
    runBusy(setBusy, true, false, '封面回填失败', async () => {
      const res = await api<BackfillResult>('/api/scrape/covers-backfill', {
        method: 'POST',
        body: JSON.stringify({ limit: 60 }),
      })
      if (res.attempted === 0) {
        toast.info('没有可回填的封面（全部书籍已是本地 webp 或未采集到封面来源）')
      } else {
        toast.success(`回填完成：成功 ${res.upgraded} / 失败 ${res.failed}，剩余可回填 ${res.remaining}`)
      }
      await qc.invalidateQueries({ queryKey: ['covers-stats'] })
      await qc.invalidateQueries({ queryKey: ['novels'] })
      await qc.invalidateQueries({ queryKey: qk.home })
    })

  return (
    <section className="rounded-lg border p-4">
      <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <ImageDown className="h-4 w-4" /> 封面本地化（webp 落盘）
      </h4>
      {!stats ? (
        <p className="py-2 text-xs text-neutral-400">统计加载中…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-600">
          <span>
            书籍总数 <b className="text-neutral-900">{stats.total}</b>
          </span>
          <span>
            本地 webp 封面 <b className="text-emerald-700">{stats.local}</b>
          </span>
          <span>
            渐变 token <b className="text-neutral-900">{stats.gradient}</b>
          </span>
          <span>
            可回填（有远程来源） <b className="text-amber-700">{stats.backfillable}</b>
          </span>
        </div>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
        采集落盘失败的封面保留远程来源 URL；回填按来源规则的代理出口重试下载，转 webp 后写入 public/covers/。
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={runBackfill} disabled={busy || backfillable === 0}>
          {busy ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> 回填中…
            </>
          ) : (
            '回填封面'
          )}
        </Button>
        {backfillable === 0 && <span className="text-[11px] text-neutral-400">暂无可回填封面</span>}
      </div>
    </section>
  )
}
