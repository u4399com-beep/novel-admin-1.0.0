import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// SQLite busy_timeout: wait up to 5 seconds for write lock instead of immediate SQLITE_BUSY
// This is critical for concurrent write operations during scraping tasks.
// Also set connection_limit=1 for SQLite (single-writer model).
const DATABASE_URL = process.env.DATABASE_URL || 'file:./db/dev.db';
const dbUrlWithParams = DATABASE_URL.includes('?')
  ? `${DATABASE_URL}&busy_timeout=5000&connection_limit=1`
  : `${DATABASE_URL}?busy_timeout=5000&connection_limit=1`;

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: dbUrlWithParams,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db