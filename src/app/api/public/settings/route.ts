import { db } from '@/lib/db';
import { NextResponse } from 'next/server';
import { getOrCompute } from '@/lib/cache';
import { withPublicRateLimit } from '@/lib/api-auth';
import { apiError } from "@/lib/api-utils"

// GET /api/public/settings - Get public-facing settings (siteName, siteDescription)
export const GET = withPublicRateLimit({ capacity: 120, refillRate: 4 }, async function GET() {
  try {
    const data = await getOrCompute('public:settings', 60_000, async () => {
      const rows = await db.siteSetting.findMany({
        where: { key: { in: ['siteName', 'siteDescription', 'itemsPerPage', 'themeColor', 'showWordCount'] } },
        select: { key: true, value: true },
      });

      const settings: Record<string, string> = {};
      for (const row of rows) {
        settings[row.key] = row.value;
      }
      return settings;
    });

    return NextResponse.json(data);
  } catch (error) {
    console.error('Get public settings error:', error);
    return apiError('获取设置失败', 500);
  }
});
