import { db } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const startTime = Date.now();
    await db.$queryRaw`SELECT 1`;
    const dbLatency = Date.now() - startTime;

    return NextResponse.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
      uptime: process.uptime(),
      services: {
        database: { status: "connected", latencyMs: dbLatency },
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