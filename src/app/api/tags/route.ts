import { db } from "@/lib/db";
import { safeJson, sanitizeField, isPrismaError } from "@/lib/api-utils";
import { NextRequest, NextResponse } from "next/server";
import { getOrCompute, invalidateCache } from "@/lib/cache";
import { withAuth } from "@/lib/api-auth";

const MAX_NAME_LENGTH = 50;
const VALID_COLOR_RE = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

// GET /api/tags - List all tags
export const GET = withAuth(async function GET() {
  try {
    const tags = await getOrCompute("tags:list", 60_000, () =>
      db.tag.findMany({
        orderBy: { createdAt: "desc" },
        take: 500,
        include: { _count: { select: { novels: true } } },
      })
    );
    return NextResponse.json(tags);
  } catch (error) {
    console.error("List tags error:", error);
    return NextResponse.json({ error: "获取标签列表失败" }, { status: 500 });
  }
});

// POST /api/tags - Create a tag
export const POST = withAuth(async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await safeJson(request);
    } catch {
      return NextResponse.json({ error: "请求数据格式错误" }, { status: 400 });
    }
    const { name, color } = body;

    if (!name?.trim()) {
      return NextResponse.json({ error: "标签名称不能为空" }, { status: 400 });
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `标签名称不能超过${MAX_NAME_LENGTH}个字符` }, { status: 400 });
    }
    if (color && !VALID_COLOR_RE.test(color)) {
      return NextResponse.json({ error: "颜色格式无效，请使用HEX格式（如#6b7280）" }, { status: 400 });
    }

    const tag = await db.tag.create({
      data: {
        name: sanitizeField(name, MAX_NAME_LENGTH),
        color: color || "#6b7280",
      },
      include: { _count: { select: { novels: true } } },
    });

    invalidateCache("tags:list");

    return NextResponse.json(tag, { status: 201 });
  } catch (error: unknown) {
    console.error("Create tag error:", error);
    if (isPrismaError(error, "P2002")) {
      return NextResponse.json({ error: "标签名称已存在" }, { status: 409 });
    }
    return NextResponse.json({ error: "创建标签失败" }, { status: 500 });
  }
});