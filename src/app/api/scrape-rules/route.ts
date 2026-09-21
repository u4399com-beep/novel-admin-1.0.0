import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { firstLine } from '@/lib/errors'
import { parseHttpUrl, parsePositiveInt } from '@/lib/scrape/api-utils'
import { safeParseRule, sanitizeRuleMap } from '@/lib/scrape/store'

export const dynamic = 'force-dynamic'

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
      proxy: r.proxy,
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
  proxy?: string
  listRule?: Record<string, string>
  bookRule?: Record<string, string>
  chapterRule?: Record<string, string>
  notes?: string
}

/** 站点级出口代理解析：空串/null/undefined → ''（直连）；支持逗号分隔多个（故障轮换）；非法形态 → error */
function parseProxyField(raw: unknown): { value: string } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { value: '' }
  if (typeof raw !== 'string') return { error: 'proxy 必须是字符串' }
  const s = raw.trim()
  if (!s) return { value: '' }
  if (s.length > 1024) return { error: 'proxy 过长（上限 1024 字符）' }
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean)
  for (const p of parts) {
    try {
      const u = new URL(p)
      if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:'].includes(u.protocol)) {
        return { error: 'proxy 仅支持 http/https/socks5/socks5h/socks4 形态（如 socks5h://127.0.0.1:1080）' }
      }
      if (!u.host) return { error: 'proxy 缺少主机地址' }
    } catch {
      return { error: `proxy 形态非法（${p.slice(0, 40)}；示例：socks5h://user:pass@host:port，多个用英文逗号分隔）` }
    }
  }
  return { value: parts.join(',') }
}

async function handleSave(body: SaveBody | null): Promise<NextResponse> {
  if (!body) return NextResponse.json({ error: '请求体必须是 JSON 对象' }, { status: 400 })

  // 字段类型守卫：非字符串 name/charset/notes 会在此前触发 TypeError（500），应显式 400
  if (typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name 必填' }, { status: 400 })
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled 必须是布尔值' }, { status: 400 })
  }
  if (body.charset !== undefined && body.charset !== null && typeof body.charset !== 'string') {
    return NextResponse.json({ error: 'charset 必须是字符串' }, { status: 400 })
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    return NextResponse.json({ error: 'notes 必须是字符串' }, { status: 400 })
  }
  const site = parseHttpUrl(body.siteUrl, 'siteUrl', 200)
  if (!site.ok) return NextResponse.json({ error: site.message }, { status: 400 })
  const proxy = parseProxyField(body.proxy)
  if ('error' in proxy) return NextResponse.json({ error: proxy.error }, { status: 400 })

  if (body.id !== undefined && (typeof body.id !== 'number' || !Number.isInteger(body.id) || body.id <= 0)) {
    return NextResponse.json({ error: '无效 id' }, { status: 400 })
  }

  const data = {
    name: body.name.trim().slice(0, 80),
    siteUrl: site.value,
    enabled: body.enabled ?? true,
    charset: (typeof body.charset === 'string' && body.charset.trim() ? body.charset : 'utf-8')
      .toLowerCase()
      .slice(0, 32),
    proxy: proxy.value,
    listRule: JSON.stringify(sanitizeRuleMap(body.listRule)),
    bookRule: JSON.stringify(sanitizeRuleMap(body.bookRule)),
    chapterRule: JSON.stringify(sanitizeRuleMap(body.chapterRule)),
    notes: (typeof body.notes === 'string' ? body.notes : '').slice(0, 1000),
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
    const msg = firstLine(e)
    const conflict = /unique|constraint/i.test(msg)
    return NextResponse.json(
      { error: conflict ? '规则名称已存在' : '保存失败', detail: conflict ? undefined : msg },
      { status: conflict ? 409 : 500 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  const id = parsePositiveInt(req.nextUrl.searchParams.get('id'))
  if (id === null) return NextResponse.json({ error: '无效 id' }, { status: 400 })
  try {
    await db.scrapeRule.delete({ where: { id } })
  } catch (e) {
    // 规则不存在视为删除成功（幂等）；其他真实 DB 错误如实 500 而非虚报成功
    if ((e as { code?: string })?.code !== 'P2025') {
      return NextResponse.json(
        { error: '删除规则失败', detail: firstLine(e) },
        { status: 500 },
      )
    }
  }
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
    listRule: {
      itemSelector: '.module-item',
      titleSelector: '.module-item-title',
      linkSelector: '.module-item-title',
      authorSelector: '.module-item-text',
    },
    bookRule: {
      titleSelector: 'h1.page-title',
      authorSelector: 'a[href*="/author/"]@title',
      descriptionSelector: '.novel-info-content',
      coverSelector: '.novel-cover img@data-src, .novel-cover img@src',
      chapterLinkSelector: '.module-row-text',
      catalogLinkSelector: 'a.catalog-more',
    },
    chapterRule: { titleSelector: 'h1', contentSelector: '.article-content' },
    notes:
      '2026-09 实测对齐「铅笔小说」（原 23qb）module 系新模板：书页仅含最新 9 章，' +
      'catalogLinkSelector=a.catalog-more 指向完整目录 /book/{id}/catalog 由 worker 整目提取；章节单页无分页。',
  },
  {
    name: '顶点系通用模板',
    siteUrl: 'https://www.ddyueshu.cc/',
    charset: 'gbk',
    listRule: {
      itemSelector: '#hotcontent .item, #newscontent .l ul li',
      titleSelector: 'dt a, .s2 a',
      authorSelector: 'dt span, .s4',
    },
    bookRule: {
      titleSelector: '#info h1',
      authorSelector: '#info p:first-of-type',
      descriptionSelector: '#intro',
      coverSelector: '#fmimg img@src',
      chapterLinkSelector: '#list dl dd a',
    },
    chapterRule: { titleSelector: 'h1', contentSelector: '#content' },
    notes:
      '2026-09 实测对齐顶点（杰奇结构）：书页 #info/#intro/#list dl dd 全目录（注意该站 href="…" 等号前带空格的反爬写法，cheerio 可正常解析）；' +
      '作者「作 者：」前缀由引擎自动剥离；章节单页无 link_next。charset=gbk（直连会被重置，需引擎 fetch-browser 策略）。',
  },
  {
    name: 'ShipSay CMS 模板',
    siteUrl: 'http://demo.shipsay.com/',
    charset: 'utf-8',
    listRule: { itemSelector: '.book-list .book', titleSelector: '.title a', authorSelector: '.author' },
    bookRule: { titleSelector: 'h1.book-title', authorSelector: '.book-author', descriptionSelector: '.book-intro', chapterLinkSelector: '.chapter-list a' },
    chapterRule: { titleSelector: 'h1.chapter-title', contentSelector: '.chapter-content', nextSelector: 'a.next-chapter' },
    notes: 'ShipSay CMS 模板（原演示站 demo.shipsay.com 已下线 502，规则保留供同结构站点复用）。',
  },
  {
    name: '爱尚系现代模板',
    siteUrl: 'https://www.aijjxs.com/',
    charset: 'utf-8',
    listRule: {
      itemSelector: '.catalog .listbg, .listbg',
      titleSelector: '.title a',
      linkSelector: '.title a',
      authorSelector: '.mainGreen a',
    },
    bookRule: {
      titleSelector: 'h3',
      authorSelector: '.kv a, .author-name',
      descriptionSelector: '.intro-panel .desc, .novel-desc',
      coverSelector: '.pic img@src',
      statusSelector: '.kv .sfwj',
      chapterLinkSelector: 'none',
      excludeSelector: 'h1.logo, .top, .search',
    },
    chapterRule: {
      titleSelector: 'h1.chapter-heading',
      contentSelector: '.chapter-body',
      nextSelector: 'a[rel="next"]',
      excludeSelector: 'h1.logo, .top, .search',
    },
    notes:
      '帝国CMS TXT下载站（久久小说下载网）实测对齐：全站 h1.logo 为站标「站内搜索…」需排除；' +
      '书页 h3 书名/.kv 作者/.desc 简介；chapterLinkSelector=none 表示仅采书籍信息（下载站无章节列表，' +
      '避免启发式把其他书籍链接误判为章节）。',
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
      return NextResponse.json({ error: '内置模板入库失败', detail: firstLine(e) }, { status: 500 })
    }
  }
  return handleSave(body)
}
