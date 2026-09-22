/**
 * Prisma 错误分类与消息工具（纯函数，无 db 依赖；服务端/路由共用）。
 *
 * 收敛点（12-g）：firstLine 此前在 4 个路由各自复制（clean-all/scrape-rules/
 * resort-chapters/recalc-words）；isUniqueConflict / isRecordMissingError 原在
 * lib/scrape/store.ts，属纯错误分类逻辑，与入库层无关，一并上移至此。
 * store.ts re-export 保持既有 import 路径（'@/lib/scrape/store'）不变。
 */

/** Prisma 错误消息首行（不含调用点源码路径，避免把服务器内部路径泄露给客户端） */
export function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200)
}

/**
 * Prisma 唯一约束冲突（P2002）。P1-1 收紧：旧实现 /unique|constraint/i 会命中
 * FK 错误文案（"Foreign key constraint violated"）——对已删除书籍的章节写入被误判
 * 为唯一冲突而盲目顺延重试（dev.log 实证 190 条 FK 报错刷屏 + 5 次无效 create/章）。
 * 现只认 Prisma P2002 code 与 Prisma 唯一约束的标准文案；FK/P2025 类错误由
 * isRecordMissingError 单独识别（调用方据此快速中止本书）。
 */
export function isUniqueConflict(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  return (e as { code?: string }).code === 'P2002' || /Unique constraint failed/i.test(e.message)
}

/**
 * 记录缺失类错误（P1-3）：Prisma P2025（操作的记录不存在）或外键违规（P2003 / FK 文案）。
 * 采集中书籍被删除（Novel ← Chapter onDelete: Cascade）时：章节 create 撞 FK（P2003）、
 * 章节 update 撞 P2025（级联删）、novel.update 撞 P2025——调用方据此立即中止本书，
 * 不再对源站发起剩余全部章节请求（旧行为：逐章 FK 失败刷屏 + 浪费带宽/刺激站点）。
 */
export function isRecordMissingError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as { code?: string }).code
  if (code === 'P2025' || code === 'P2003') return true
  return /foreign key|no record was found|record to update does not exist|records? that were required but/i.test(e.message)
}
