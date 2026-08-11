import { PrismaClient } from '@prisma/client'

// ─── Production Safety Check ─────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const secret = process.env.NEXTAUTH_SECRET || '';
  if (secret.length < 32 || secret.toLowerCase().includes('change-this')) {
    console.error('[FATAL] NEXTAUTH_SECRET is too weak or not set in production. Refusing to start.');
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