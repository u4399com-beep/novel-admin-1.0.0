'use client'

/**
 * 采集中心面板（薄组合层）：
 * - 默认导出、无 props、自包含（规则列表查询在层内，子区块各自管理状态与请求）
 * - 由管理控制台的「采集中心」区块渲染（AdminConsole.tsx：import ScrapeCenter from '@/components/admin/ScrapeCenter'）
 * - 子组件拆分于 ./scrape/：EngineCard（引擎策略状态）/ RulesCard（规则编辑+存量清洗）/
 *   NewTaskCard（新建任务）/ TasksCard（任务列表+日志）
 * - 后端 API 契约见 /api/scrape-tasks 与 /api/scrape-rules
 */

import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ScrapeRuleDto } from '@/lib/types'
import { CoversCard } from './scrape/CoversCard'
import { EngineCard } from './scrape/EngineCard'
import { NewTaskCard } from './scrape/NewTaskCard'
import { RulesCard } from './scrape/RulesCard'
import { TasksCard } from './scrape/TasksCard'
import { api } from './scrape/shared'

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
      <EngineCard />
      <CoversCard />
      <RulesCard rules={rules} />
      <NewTaskCard rules={rules ?? []} onCreated={handleCreated} />
      <section ref={taskSectionRef}>
        <TasksCard key={taskListKey} />
      </section>
    </div>
  )
}
