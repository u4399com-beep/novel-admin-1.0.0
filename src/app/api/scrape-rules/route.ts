import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** 安全解析 DB 中的规则 JSON（历史数据可能损坏） */
function safeParseRule(json: string | null | undefined): Record<string, string> {
  if (!json) return {}
  try {
    const v = JSON.parse(json) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, string> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && val.trim()) out[k] = val.trim().slice(0, 300)
      }
      return out
    }
    return {}
  } catch {
    return {}
  }
}

/** 运行时清洗选择器规则：仅保留字符串值并限长 */
function sanitizeRuleInput(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 300)
    }
  }
  return out
}

/** 校验站点 URL：必须是合法 http/https 地址 */
function parseSiteUrl(raw: unknown): { ok: true; url: string } | { ok: false; message: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: 'siteUrl 必填' }
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: 'siteUrl 仅支持 http/https' }
    return { ok: true, url: u.toString().slice(0, 200) }
  } catch {
    return { ok: false, message: `siteUrl 无法解析: ${raw.slice(0, 100)}` }
  }
}

// GET 采集规则列表
export async function GET() {
  const rows = await db.scrapeRule.findMany({ orderBy: { id: 'asc' } })
  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      siteUrl: r.siteUrl,
      enabled: r.enabled,
      charset: r.charset,
      listRule: safeParseRule(r.listRule),
      bookRule: safeParseRule(r.bookRule),
      chapterRule: safeParseRule(r.chapterRule),
      notes: r.notes,
    }))
  )
}

// 新建/更新采集规则（POST 与 PUT 共用保存逻辑；body 由调用方解析一次后传入，
// Request body 流只能读一次，不能在 handleSave 内重复 req.json()）
interface SaveBody {
  id?: number
  name?: string
  siteUrl?: string
  enabled?: boolean
  charset?: string
  listRule?: Record<string, string>
  bookRule?: Record<string, string>
  chapterRule?: Record<string, string>
  notes?: string
}

async function handleSave(body: SaveBody | null): Promise<NextResponse> {
  if (!body) return NextResponse.json({ error: '请求体必须是 JSON 对象' }, { status: 400 })

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name 必填' }, { status: 400 })
  }
  const site = parseSiteUrl(body.siteUrl)
  if (!site.ok) return NextResponse.json({ error: site.message }, { status: 400 })

  if (body.id !== undefined && (!Number.isInteger(body.id) || body.id <= 0)) {
    return NextResponse.json({ error: '无效 id' }, { status: 400 })
  }

  const data = {
    name: body.name.trim().slice(0, 80),
    siteUrl: site.url,
    enabled: body.enabled ?? true,
    charset: (body.charset || 'utf-8').toLowerCase().slice(0, 32),
    listRule: JSON.stringify(sanitizeRuleInput(body.listRule)),
    bookRule: JSON.stringify(sanitizeRuleInput(body.bookRule)),
    chapterRule: JSON.stringify(sanitizeRuleInput(body.chapterRule)),
    notes: (body.notes ?? '').slice(0, 1000),
  }
  try {
    if (body.id) {
      const updated = await db.scrapeRule.update({ where: { id: body.id }, data })
      return NextResponse.json({ id: updated.id })
    }
    const created = await db.scrapeRule.create({ data })
    return NextResponse.json({ id: created.id }, { status: 201 })
  } catch (e) {
    // 更新不存在的规则（P2025）应返回 404 而非 500
    const code = e instanceof Error ? (e as { code?: string }).code : ''
    if (code === 'P2025') return NextResponse.json({ error: '规则不存在' }, { status: 404 })
    const msg = e instanceof Error ? e.message : 'unknown'
    const conflict = /unique|constraint/i.test(msg)
    return NextResponse.json(
      { error: conflict ? '规则名称已存在' : '保存失败', detail: conflict ? undefined : msg },
      { status: conflict ? 409 : 500 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: '无效 id' }, { status: 400 })
  await db.scrapeRule.delete({ where: { id } }).catch(() => {})
  return NextResponse.json({ ok: true })
}

// POST /api/scrape-rules —— 新建（body.id 存在时为更新）
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as SaveBody | null
  return handleSave(body)
}

// —— 内置规则种子：基于站点分析产出的 CMS 家族通用选择器（可编辑） ——
const SEED_RULES = [
  {
    name: '笔趣阁系通用模板',
    siteUrl: 'https://www.23qb.net/',
    charset: 'utf-8',
    listRule: { itemSelector: '#hotcontent li, #newscontent li', titleSelector: '.s2 a', authorSelector: '.s5' },
    bookRule: { titleSelector: '#info h1', authorSelector: '#info p:first-of-type a', descriptionSelector: '#intro', chapterLinkSelector: '#list dl dd a' },
    chapterRule: { titleSelector: '.bookname h1', contentSelector: '#content', nextSelector: '#link_next' },
    notes: '杰奇/笔趣阁系结构：列表 li 分列，正文 #content。',
  },
  {
    name: '顶点系通用模板',
    siteUrl: 'https://www.ddyueshu.cc/',
    charset: 'gbk',
    listRule: { itemSelector: '#main .novellist li', titleSelector: 'a', authorSelector: '' },
    bookRule: { titleSelector: '#title h1', authorSelector: '#title span', descriptionSelector: '#intro', chapterLinkSelector: '.chapterlist a' },
    chapterRule: { titleSelector: 'h1', contentSelector: '#content', nextSelector: '#link_next' },
    notes: 'GBK 编码站代表，需 charset=gbk。',
  },
  {
    name: 'ShipSay CMS 模板',
    siteUrl: 'http://demo.shipsay.com/',
    charset: 'utf-8',
    listRule: { itemSelector: '.book-list .book', titleSelector: '.title a', authorSelector: '.author' },
    bookRule: { titleSelector: 'h1.book-title', authorSelector: '.book-author', descriptionSelector: '.book-intro', chapterLinkSelector: '.chapter-list a' },
    chapterRule: { titleSelector: 'h1.chapter-title', contentSelector: '.chapter-content', nextSelector: 'a.next-chapter' },
    notes: 'ShipSay 演示模板，类名结构化清晰。',
  },
  {
    name: '爱尚系现代模板',
    siteUrl: 'https://www.aijjxs.com/',
    charset: 'utf-8',
    listRule: { itemSelector: '.book-item, .rank-item', titleSelector: '.book-title a', authorSelector: '.book-author' },
    bookRule: { titleSelector: 'h1.novel-title', authorSelector: '.author-name', descriptionSelector: '.novel-desc', chapterLinkSelector: '.chapter-grid a' },
    chapterRule: { titleSelector: 'h1.chapter-heading', contentSelector: '.chapter-body', nextSelector: 'a[rel="next"]' },
    notes: '现代卡片式布局站点。',
  },
]

// PUT /api/scrape-rules —— { seed: true } 内置模板入库；否则与 POST 相同的全字段保存
export async function PUT(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as (SaveBody & { seed?: boolean }) | null
  if (body?.seed) {
    // seed 循环仅 4 条内置规则（几条内、纯本地 SQLite 读写，远低于 $transaction 默认 5s 超时），
    // 包事务保证「要么全部入库要么全部回滚」，避免部分失败留下半套模板（幂等：已存在的按 name 跳过）
    try {
      const added = await db.$transaction(async (tx) => {
        let n = 0
        for (const r of SEED_RULES) {
          const exists = await tx.scrapeRule.findUnique({ where: { name: r.name } })
          if (exists) continue
          await tx.scrapeRule.create({
            data: {
              ...r,
              listRule: JSON.stringify(r.listRule),
              bookRule: JSON.stringify(r.bookRule),
              chapterRule: JSON.stringify(r.chapterRule),
            },
          })
          n++
        }
        return n
      })
      return NextResponse.json({ added })
    } catch (e) {
      // 并发 seed 撞 name 唯一约束等失败：整体回滚，幂等重试即可
      const msg = e instanceof Error ? e.message : 'unknown'
      return NextResponse.json({ error: '内置模板入库失败', detail: msg.slice(0, 200) }, { status: 500 })
    }
  }
  return handleSave(body)
}
