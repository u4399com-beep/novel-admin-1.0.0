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

// Auto-detect database type and apply appropriate configuration
function createPrismaClient(): PrismaClient {
  const isPostgres = process.env.DATABASE_URL?.startsWith('postgresql');
  const isDev = process.env.NODE_ENV !== 'production';

  // Common config
  const baseConfig = {
    log: isDev ? ['error', 'warn'] : ['error'],
  };

  // PostgreSQL-specific: add connection pool parameters via datasource URL
  if (isPostgres) {
    const url = new URL(process.env.DATABASE_URL!);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', '20');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '30');
    }
    baseConfig.datasources = { db: { url: url.toString() } };
  }

  return new PrismaClient(baseConfig);
}

export const db =
  globalForPrisma.prisma ??
  createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db