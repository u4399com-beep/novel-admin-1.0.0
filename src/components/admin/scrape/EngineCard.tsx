'use client'

/**
 * 采集引擎状态卡：展示 scraper-service 反反爬策略链（GET /api/scrape?proxy=strategies）。
 * 引擎重启/降级（502）时显示提示并保持 30s 自动重试，不阻塞其余区块。
 */

import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { RefreshCw } from 'lucide-react'
import { api } from './shared'
import type { StrategyInfo } from './types'

export function EngineCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['scraper-strategies'],
    queryFn: () => api<{ strategies: StrategyInfo[] }>('/api/scrape?proxy=strategies'),
    refetchInterval: 30_000,
  })
  const strategies = data?.strategies ?? []

  return (
    <section className="rounded-lg border p-4">
      <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <RefreshCw className="h-4 w-4" /> 采集引擎状态（scraper-service :3030）
      </h4>
      {isLoading && <p className="py-2 text-xs text-neutral-400">策略检测中…</p>}
      {isError && strategies.length === 0 && (
        <p className="py-2 text-xs text-neutral-400">引擎暂不可用（可能正在重启），稍后自动重试。</p>
      )}
      <div className="space-y-1.5">
        {strategies.map((s) => (
          <div key={s.name} className="flex items-start gap-2 text-xs">
            <Badge variant={s.available ? 'default' : 'secondary'} className="shrink-0">
              {s.available ? '可用' : '未启用'}
            </Badge>
            <span className="shrink-0 font-medium">{s.name}</span>
            <span className="min-w-0 flex-1 text-neutral-500">{s.description}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
        合规：默认 ≥1.2s/域名限速、robots 提示、仅公开页面；不含验证码破解/登录伪造。
      </p>
    </section>
  )
}
