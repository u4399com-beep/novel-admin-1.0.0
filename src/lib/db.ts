import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const isDev = process.env.NODE_ENV !== 'production';

  return new PrismaClient({
    log: isDev
      ? [{ level: 'error', emit: 'stdout' }, { level: 'warn', emit: 'stdout' }]
      : [{ level: 'error', emit: 'stdout' }],
  });
}

export const db =
  globalForPrisma.prisma ??
  createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db