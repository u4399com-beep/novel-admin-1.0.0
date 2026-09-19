import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/**
 * SiteSetting 单例（seoConfig JSON）读-改-写的进程内串行锁：
 * 并发 PATCH 时「读旧值 → 合并 → 写回」会互相覆盖（丢更新）；
 * SQLite/Prisma 事务无法阻止该交错，故以 Promise 链在同一进程内串行化所有写路径
 * （设置与 PSEO 配置的全部写入都经此函数）。挂在 globalThis 上，HMR 重载不失效。
 */
const gLock = globalThis as unknown as { __settingsWriteChain?: Promise<unknown> }

export function serializeSettingsWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = (gLock.__settingsWriteChain ?? Promise.resolve()).then(fn, fn)
  // 链上吞掉异常避免后续写入被拒，但把结果原样返回给本次调用方
  gLock.__settingsWriteChain = run.catch(() => {})
  return run
}