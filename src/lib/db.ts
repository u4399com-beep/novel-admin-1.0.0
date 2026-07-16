import { PrismaClient } from '@prisma/client'

// Production secret strength validation - fail fast before any DB connection
if (process.env.NODE_ENV === 'production') {
  const secret = process.env.NEXTAUTH_SECRET || '';
  if (secret.length < 32 || secret.includes('change-this')) {
    console.error('[FATAL] NEXTAUTH_SECRET is not properly configured for production');
    process.exit(1);
  }
  const serviceToken = process.env.SCRAPER_SERVICE_TOKEN || '';
  if (serviceToken.length < 32 || serviceToken.includes('change-this')) {
    console.error('[FATAL] SCRAPER_SERVICE_TOKEN is not properly configured for production');
    process.exit(1);
  }
}

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