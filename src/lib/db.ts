import { PrismaClient } from '@prisma/client'

// 缓存 key 带 epoch：db 文件曾被原子替换（mv 新 inode），旧 client 的 fd 指向
// 已删除的旧文件 → 间歇性 "database disk image is malformed"（500）。
// 递增 epoch 强制 HMR 后新建 client（fd 指向当前 db 文件），旧实例断开废弃。
const globalForPrisma = globalThis as unknown as {
  // key 写死：epoch 递增时同步改此 key（罕见操作，显式最清晰）
  __prismaV2?: PrismaClient
  __prismaPrev?: PrismaClient
}

export const db =
  globalForPrisma.__prismaV2 ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') {
  if (!globalForPrisma.__prismaV2 && globalForPrisma.__prismaPrev && globalForPrisma.__prismaPrev !== db) {
    // 旧 epoch 实例（可能持旧 inode fd）：后台断开释放，不阻塞当前请求
    void globalForPrisma.__prismaPrev.$disconnect().catch(() => {})
  }
  globalForPrisma.__prismaV2 = db
  globalForPrisma.__prismaPrev = db
}

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