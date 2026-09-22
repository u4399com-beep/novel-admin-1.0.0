/**
 * 封面回填端点（POST /api/scrape/covers-backfill）—— 已退役（410 Gone）。
 *
 * 历史：曾经凭 Novel.remoteCoverUrl（远程封面来源）+ Novel.sourceRuleId（规则代理出口）
 * 对「封面落盘失败仍为渐变 token」的书籍批量重试下载。这两个字段已随 schema 演进移除，
 * 采集端（src/lib/scrape/store.ts）现改为入库时即时下载封面：抓到远程 URL 直接
 * fetchAndStoreCover 落盘为 /covers/{id}.webp，失败保留渐变 token，且不再持久化远程来源。
 *
 * 为何无法修复而非简化重写：现存字段（Novel.cover=渐变 token 或本地路径、
 * ScrapeTask.targetUrl=列表页/书页 URL）无法反推「某本书的远程封面 URL」——
 * ScrapeTask 无 novelId 外键（list 模式存列表页 URL），重写需按标题全站重搜，
 * 代价与误配风险远超收益，故端点退役并返回 410 说明。
 *
 * GET 仍返回封面本地化统计（total/local/gradient 均可由 Novel.cover 判定；
 * backfillable 恒为 0，管理后台 CoversCard 据此保持回填按钮禁用）。
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** GET：封面覆盖统计（管理后台 CoversCard 展示用） */
export async function GET() {
  const [total, local] = await Promise.all([
    db.novel.count().catch(() => 0),
    db.novel.count({ where: { cover: { startsWith: '/covers/' } } }).catch(() => 0),
  ])
  return NextResponse.json({
    total,
    local,
    gradient: Math.max(0, total - local),
    backfillable: 0, // remoteCoverUrl 字段链已移除，无远程来源可回填
    available: false,
  })
}

const GONE_MESSAGE =
  '封面回填已退役：远程封面来源（remoteCoverUrl/sourceRuleId）字段已随 schema 演进移除，' +
  '采集入库时会即时下载封面落盘（/covers/{id}.webp），失败书籍保留渐变 token；' +
  '如需修复个别封面，请对对应书籍重新采集。'

/** POST：410 Gone——功能依赖的字段链已不存在，无法凭现存字段定位远程封面来源 */
export async function POST() {
  return NextResponse.json({ error: GONE_MESSAGE, available: false }, { status: 410 })
}
