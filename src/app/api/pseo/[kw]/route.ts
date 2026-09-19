import { NextRequest, NextResponse } from 'next/server'
import { sanitizeKeyword } from '@/lib/suggest'
import { getGeneratedPseoPage, getNovelRowById, matchNovels, toListItem } from '@/lib/pseo'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ kw: string }> }

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { kw: rawKw } = await params
  // decodeURIComponent 对畸形转义序列（如 %zz）会抛 URIError，必须兜底
  let decoded: string
  try {
    decoded = decodeURIComponent(rawKw)
  } catch {
    decoded = rawKw
  }
  const keyword = sanitizeKeyword(decoded)
  if (!keyword) return NextResponse.json({ error: '关键词不能为空' }, { status: 400 })

  // 优先使用已生成的聚合数据（pageData 损坏/未生成时返回 null → 实时计算）
  const page = await getGeneratedPseoPage(keyword)
  if (page) return NextResponse.json(page)

  // 实时计算（命中不足 3 本由 matchNovels 用热门书垫底补位，聚合页永不空窗）
  const kwRow = await db.pseoKeyword.findUnique({ where: { keyword }, select: { novelId: true } })
  const novels = await matchNovels(keyword)
  // 关键词绑定了书籍但页面未生成/pageData 损坏：绑定书强制排第一（列表已有则移到首位，否则补插）
  const boundId = kwRow?.novelId
  if (boundId != null) {
    const at = novels.findIndex((n) => n.id === boundId)
    if (at > 0) novels.unshift(...novels.splice(at, 1))
    else if (at === -1) {
      const bound = await getNovelRowById(boundId)
      if (bound) novels.unshift(bound)
    }
  }
  const setting = await db.siteSetting.findUnique({ where: { id: 1 } })
  const siteName = setting?.siteName ?? '青阅文学'
  const data = {
    keyword,
    novels: novels.map(toListItem),
    generatedTitle: `${keyword}小说推荐_关于${keyword}的小说 - ${siteName}`,
    generatedDescription: `${siteName}为您精选与“${keyword}”相关的小说合集，包含 ${novels.length} 本热门作品，在线免费阅读。`,
    generatedKeywords: `${keyword},${keyword}小说,${keyword}推荐`,
  }
  return NextResponse.json(data)
}
