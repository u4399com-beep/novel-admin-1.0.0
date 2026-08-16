'use server';

import { withAuth } from '@/lib/api-auth';
import { NextResponse } from 'next/server';

const LOG_STREAM_URL = process.env.LOG_STREAM_URL || 'http://localhost:3004';
const TIMEOUT_MS = 5000;

/** Mock fallback when log-stream-service is not reachable */
function mockStats() {
  return {
    connectedClients: 0,
    rooms: {},
    eventsPerSecond: 0,
    serviceReachable: false,
  };
}

// GET /api/admin/scraper/log-stream-stats
export const GET = withAuth(async function GET() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${LOG_STREAM_URL}/stats`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return NextResponse.json(mockStats());
    }

    const data = await res.json();
    return NextResponse.json({
      ...data,
      serviceReachable: true,
    });
  } catch {
    clearTimeout(timer);
    return NextResponse.json(mockStats());
  }
});
