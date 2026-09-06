import { PrismaClient } from '@prisma/client'

// ─── Production Safety Check ─────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const secret = process.env.NEXTAUTH_SECRET || '';
  if (secret.length < 32 || secret.toLowerCase().includes('change-this')) {
    console.error('[FATAL] NEXTAUTH_SECRET is too weak or not set in production. Refusing to start.');
    process.exit(1);
  }
  // Validate required service tokens in production
  if (!process.env.SCRAPER_SERVICE_TOKEN || process.env.SCRAPER_SERVICE_TOKEN.length < 16) {
    console.error('[FATAL] SCRAPER_SERVICE_TOKEN is not set or too short in production. Refusing to start.');
    process.exit(1);
  }
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.error('[FATAL] ADMIN_USERNAME and ADMIN_PASSWORD must be set in production. Refusing to start.');
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
      ? [
          { level: 'query', emit: 'event' },
          { level: 'error', emit: 'stdout' },
          { level: 'warn', emit: 'stdout' },
        ]
      : [{ level: 'error', emit: 'stdout' }],
  });
}

export const db =
  globalForPrisma.prisma ??
  createPrismaClient()

// ─── Dev Query Timing ─────────────────────────────────────────────
// Log slow queries (>100ms) in development for performance debugging
if (process.env.NODE_ENV !== 'production') {
  try {
    (db as any).$on('query', (e: { duration: number; query: string; params: string }) => {
      if (e.duration > 100) {
        console.warn(`[Slow Query ${e.duration}ms] ${e.query.slice(0, 200)}${e.query.length > 200 ? '...' : ''}`);
      }
    });
  } catch {
    // $on may not be available in all Prisma client versions
  }
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
