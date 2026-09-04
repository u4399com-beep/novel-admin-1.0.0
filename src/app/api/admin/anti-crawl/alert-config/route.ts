import { db } from '@/lib/db';
import { withAuth } from '@/lib/api-auth';
import { NextRequest, NextResponse } from 'next/server';
import { apiError, safeJson } from '@/lib/api-utils';

const SETTING_KEY = 'anti_crawl_alert_config';

const DEFAULT_THRESHOLDS = {
  captchaPerHour: 10,
  blockRate: 30,
  consecutiveFails: 5,
  proxyFailRate: 50,
};

export interface AlertConfigResponse {
  thresholds: {
    captchaPerHour: number;
    blockRate: number;
    consecutiveFails: number;
    proxyFailRate: number;
  };
  enabled: boolean;
}

// GET /api/admin/anti-crawl/alert-config
export const GET = withAuth(async function GET() {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: SETTING_KEY } });
    if (!row) {
      return NextResponse.json({
        thresholds: { ...DEFAULT_THRESHOLDS },
        enabled: true,
      } satisfies AlertConfigResponse);
    }
    const parsed = JSON.parse(row.value) as AlertConfigResponse;
    return NextResponse.json({
      thresholds: { ...DEFAULT_THRESHOLDS, ...parsed.thresholds },
      enabled: parsed.enabled ?? true,
    } satisfies AlertConfigResponse);
  } catch {
    return NextResponse.json({
      thresholds: { ...DEFAULT_THRESHOLDS },
      enabled: true,
    } satisfies AlertConfigResponse);
  }
});

// PUT /api/admin/anti-crawl/alert-config
export const PUT = withAuth(async function PUT(request: NextRequest) {
  try {
    const body = (await safeJson<Partial<AlertConfigResponse>>(request));

    // Read current config
    const row = await db.siteSetting.findUnique({ where: { key: SETTING_KEY } });
    let current: AlertConfigResponse = {
      thresholds: { ...DEFAULT_THRESHOLDS },
      enabled: true,
    };
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as AlertConfigResponse;
        current = {
          thresholds: { ...DEFAULT_THRESHOLDS, ...parsed.thresholds },
          enabled: parsed.enabled ?? true,
        };
      } catch {
        // use defaults
      }
    }

    // Merge incoming values
    const updated: AlertConfigResponse = {
      enabled: body.enabled ?? current.enabled,
      thresholds: { ...current.thresholds, ...body.thresholds },
    };

    // Validate: all thresholds must be positive numbers
    const { captchaPerHour, blockRate, consecutiveFails, proxyFailRate } = updated.thresholds;
    if (
      typeof captchaPerHour !== 'number' || captchaPerHour <= 0 ||
      typeof blockRate !== 'number' || blockRate <= 0 ||
      typeof consecutiveFails !== 'number' || consecutiveFails <= 0 ||
      typeof proxyFailRate !== 'number' || proxyFailRate <= 0
    ) {
      return apiError('所有阈值必须为正数', 400);
    }

    await db.siteSetting.upsert({
      where: { key: SETTING_KEY },
      update: { value: JSON.stringify(updated) },
      create: { key: SETTING_KEY, value: JSON.stringify(updated) },
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return apiError('请求体格式无效', 400);
    }
    return apiError('保存告警配置失败', 500);
  }
});
