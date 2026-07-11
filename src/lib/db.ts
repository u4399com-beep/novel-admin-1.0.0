import { PrismaClient } from '@prisma/client'

// Production secret strength validation - fail fast before any DB connection
if (process.env.NODE_ENV === 'production') {
  const secret = process.env.NEXTAUTH_SECRET || '';
  if (secret.length < 32 || secret.includes('change-this')) {
    console.error('[FATAL] NEXTAUTH_SECRET is not properly configured for production');
    process.exit(1);
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: (process.env.DATABASE_URL || '') + (process.env.DATABASE_URL?.includes('?') ? '&' : '?') + 'connection_limit=10&pool_timeout=30',
      },
    },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db