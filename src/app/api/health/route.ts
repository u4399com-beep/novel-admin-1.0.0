import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const startTime = Date.now();
    await db.$queryRaw`SELECT 1`;
    const dbLatency = Date.now() - startTime;

    // Check scraper-service health (optional — non-blocking)
    let scraperService: { status: string; latencyMs?: number } = { status: "skipped" };
    try {
      const scraperUrl = process.env.SCRAPER_SERVICE_URL || "http://localhost:3099";
      const scraperStart = Date.now();
      const scraperRes = await fetch(`${scraperUrl}/health`, { signal: AbortSignal.timeout(3000) });
      scraperService = { status: scraperRes.ok ? "connected" : "error", latencyMs: Date.now() - scraperStart };
    } catch {
      scraperService = { status: "unreachable" };
    }

    return NextResponse.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        database: { status: "connected", latencyMs: dbLatency },
        scraperService,
      },
    });
  } catch (error) {
    console.error("Health check failed:", error);
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: "Database connection failed",
      },
      { status: 503 }
    );
  }
}