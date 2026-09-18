import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params
  const nid = Number(id)
  if (!Number.isInteger(nid)) return NextResponse.json({ error: '无效 ID' }, { status: 400 })

  const chapters = await db.chapter.findMany({
    where: { novelId: nid },
    orderBy: { idx: 'asc' },
    select: { id: true, idx: true, title: true, wordCount: true },
  })
  return NextResponse.json(chapters)
}
