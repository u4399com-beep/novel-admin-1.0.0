/**
 * 任务运行日志与进度写回（服务端专用）。
 *
 * flush 走类型化 Prisma update：chaptersDone/chaptersTotal 已在 Task 17 落入 schema，
 * 当前生成的 Prisma Client 已含这些字段（曾用于兼容旧 client 的 $executeRaw 兜底
 * 已在 Task 20-b 移除；若运行期复现 Unknown field 类错误，回退方案见 worklog 证据）。
 */
import { db } from '@/lib/db'
import type { TaskFlushFields } from './types'

export const MAX_LOG_LINES = 100
export const MAX_WARNINGS_LOGGED = 3

function ts(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export class Run {
  readonly taskId: number
  private lines: string[] = []
  /** 任务级成果计数（跨多本书累积） */
  counters = { created: 0, updated: 0, chapters: 0 }

  constructor(taskId: number) {
    this.taskId = taskId
  }

  log(msg: string): void {
    this.lines.push(`[${ts()}] ${msg}`.slice(0, 500))
    if (this.lines.length > MAX_LOG_LINES) this.lines = this.lines.slice(-MAX_LOG_LINES)
  }

  logWarnings(warnings: unknown[]): void {
    for (const w of warnings.slice(0, MAX_WARNINGS_LOGGED)) this.log(`引擎提示: ${String(w).slice(0, 200)}`)
  }

  logText(): string {
    return this.lines.join('\n')
  }

  /**
   * 写回日志与进度字段；任务记录被删除时返回 false（调用方应停止执行）。
   * 与 isCanceled 的 fail-open 哲学一致：P2025（记录不存在）才判定「已删除」；
   * 其他错误（如 SQLite 瞬时锁）短暂退避后重试一次，仍失败不视为删除——
   * 日志行留驻内存，由下一次成功的 flush 一并落盘。
   */
  async flush(extra?: TaskFlushFields): Promise<boolean> {
    const write = (): Promise<unknown> =>
      db.scrapeTask.update({ where: { id: this.taskId }, data: { log: this.logText(), ...extra } })
    try {
      await write()
      return true
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') return false
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await write()
        return true
      } catch (e2) {
        return (e2 as { code?: string }).code !== 'P2025'
      }
    }
  }
}
