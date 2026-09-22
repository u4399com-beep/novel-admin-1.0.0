/**
 * Task 12-c 逐站探测编排器（低频：每站 ≤2-3 个请求，间隔 ≥2.2s，ggd66 ≥5.5s 且不重试）。
 * 优先经引擎 mini-services/scraper-service /api/test 走限速与策略链；结果 JSON 存 /tmp/probe/。
 * 用法：bun run scripts/probe-sites.ts <batch1|batch2|batch3>
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const ENGINE = 'http://127.0.0.1:3030'
const OUT = '/tmp/probe'

interface Job {
  tag: string
  url: string
  charset?: string
  proxy?: string
  bookRule?: boolean // true = 带 DB 规则的 bookRule 提取（验证封面选择器）
  includeHtml?: boolean
  gapAfterMs: number
}

function buildJobs(name: string): Job[] {
  switch (name) {
    case 'batch1': // aijjxs / ddyueshu / 23qb
      return [
        { tag: 'aijjxs-list', url: 'https://www.aijjxs.com/', charset: 'utf-8', includeHtml: true, gapAfterMs: 2300 },
        { tag: 'ddyueshu-list', url: 'https://www.ddyueshu.cc/', charset: 'gbk', includeHtml: true, gapAfterMs: 2300 },
        { tag: '23qb-list', url: 'https://www.23qb.net/book/lastupdate_0_0_0_0_0_0_0_1_0.html', charset: 'utf-8', includeHtml: true, gapAfterMs: 2300 },
      ]
    case 'batch2': // huangjinwu / ggd66(严格：间隔5.5s 共2请求) / xinjianpan / huangjinwu 书页封面
      return [
        { tag: 'huangjinwu-list', url: 'https://www.huangjinwu.org/', charset: 'utf-8', includeHtml: true, gapAfterMs: 2300 },
        { tag: 'huangjinwu-book', url: 'https://www.huangjinwu.org/novel/49740', charset: 'utf-8', bookRule: true, gapAfterMs: 2300 },
        { tag: 'ggd66-list', url: 'https://www.ggd66.com/sort/1/1/', charset: 'utf-8', includeHtml: true, gapAfterMs: 5600 },
        { tag: 'ggd66-book', url: 'https://www.ggd66.com/qu/385560/', charset: 'utf-8', bookRule: true, gapAfterMs: 5600 },
        { tag: 'xinjianpan-book', url: 'https://www.xinjianpan.com/txt/3w2j/', charset: 'utf-8', bookRule: true, gapAfterMs: 2300 },
      ]
    case 'batch3': // 101kks / x2552 / trxsw / pilishuwu / 77shuku
      return [
        { tag: '101kks-list', url: 'https://101kks.com/novels/class/0_1.html', charset: 'utf-8', proxy: 'http://103.237.102.191:11111', includeHtml: true, gapAfterMs: 2300 },
        { tag: 'x2552-list2', url: 'http://www.x2552.com/list/1_2.html', charset: 'gbk', includeHtml: true, gapAfterMs: 2300 },
        { tag: 'x2552-book', url: 'http://www.x2552.com/book/13336.html', charset: 'gbk', bookRule: true, gapAfterMs: 2300 },
        { tag: 'trxsw-list', url: 'http://www.trxsw.com/lastupdate/', charset: 'utf-8', proxy: 'http://67.203.23.79:8081,http://23.228.86.236:8081,http://67.203.23.88:8081', includeHtml: true, gapAfterMs: 2300 },
        { tag: 'pilishuwu-list', url: 'https://www.pilishuwu.com/', charset: 'gbk', includeHtml: true, gapAfterMs: 2300 },
        { tag: '77shuku-book', url: 'http://www.77shuku.info/novel/79377/', charset: 'utf-8', proxy: 'http://113.204.79.230:9091,http://61.158.175.38:9002', bookRule: true, gapAfterMs: 2300 },
      ]
    case 'batch4': // aijjxs 书页封面验证 + ddyueshu 全部小说页翻页格式与书页封面验证
      return [
        { tag: 'aijjxs-book', url: 'https://www.aijjxs.com/txt/53458.html', charset: 'utf-8', bookRule: true, gapAfterMs: 2300 },
        { tag: 'ddyueshu-all', url: 'https://www.ddyueshu.cc/xiaoshuodaquan/', charset: 'gbk', includeHtml: true, gapAfterMs: 2300 },
        { tag: 'ddyueshu-book', url: 'https://www.ddyueshu.cc/0_776/', charset: 'gbk', bookRule: true, gapAfterMs: 2300 },
      ]
    default:
      throw new Error(`unknown batch ${name}`)
  }
}

/** 从原始 HTML 中提取分页相关锚点（下一页/下页/尾页/next 与翻页形态 href 样本） */
function paginationHints(html: string, baseUrl: string): { nextish: string[]; pagedHrefs: string[] } {
  const nextish: string[] = []
  const paged = new Set<string>()
  const aRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,80}?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = aRe.exec(html))) {
    const href = m[1]
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim()
    if (/下一页|下页|下一頁|尾页|末页|next/i.test(text) && nextish.length < 8) {
      nextish.push(`text="${text}" href="${href}"`)
    }
    if (
      /(?:[?&]page=\d+|\/page\/\d+|_\d+\.s?html?|\/\d+\/?(?:["']|$))/i.test(href) &&
      !/\.(css|js|ico|jpe?g|png|gif|webp|svg)/i.test(href) &&
      paged.size < 24
    ) {
      paged.add(href.slice(0, 120))
    }
  }
  void baseUrl
  return { nextish, pagedHrefs: [...paged] }
}

/** 从原始 HTML 提取候选书籍条目链接（供下一步书页探测） */
function bookLinkHints(html: string, host: string): string[] {
  const out = new Set<string>()
  const aRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = aRe.exec(html))) {
    const h = m[1]
    if (!h.startsWith('http') && !h.startsWith('/')) continue
    if (
      new RegExp(`${host.replace(/\W/g, '\\$&')}`).test(h) ||
      h.startsWith('/')
    ) {
      if (/\/(book|novel|txt|qu|files\/article)\/[^"']+/i.test(h)) {
        try {
          out.add(new URL(h, 'http://x').toString().replace('http://x', '').slice(0, 120))
        } catch {
          /* skip */
        }
      }
    }
    if (out.size >= 12) break
  }
  return [...out]
}

const batch = process.argv[2] ?? 'batch1'
const jobs = buildJobs(batch)
for (const job of jobs) {
  const body: Record<string, unknown> = { url: job.url, timeoutMs: 45000 }
  if (job.charset) body.charset = job.charset
  if (job.proxy) body.proxy = job.proxy
  if (job.includeHtml) body.includeHtml = true
  if (job.bookRule) {
    const ruleId = ({ 'ggd66-book': 14, 'xinjianpan-book': 15, 'x2552-book': 17, '77shuku-book': 20, 'aijjxs-book': 10, 'ddyueshu-book': 11, '23qb-book': 12, 'huangjinwu-book': 13, 'trxsw-book': 18 } as Record<string, number>)[job.tag] ?? 0
    const r = await db.scrapeRule.findUnique({ where: { id: ruleId } })
    if (!r) {
      console.log(`[${job.tag}] rule ${ruleId} not found, skip`)
      continue
    }
    body.rule = { bookRule: JSON.parse(r.bookRule) }
  }
  const t0 = Date.now()
  let payload: Record<string, unknown> | null = null
  try {
    const res = await fetch(`${ENGINE}/api/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    payload = (await res.json().catch(() => null)) as Record<string, unknown> | null
  } catch (e) {
    payload = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  const elapsed = Date.now() - t0
  const ok = payload?.ok === true
  const summary: Record<string, unknown> = {
    tag: job.tag,
    url: job.url,
    ok,
    httpStatus: payload?.status ?? null,
    strategy: payload?.strategy ?? null,
    encoding: payload?.encoding ?? null,
    htmlLength: payload?.htmlLength ?? null,
    elapsedMs: elapsed,
    error: ok ? null : String(payload?.error ?? '?').slice(0, 200),
    challengeSuspected: payload?.challengeSuspected ?? undefined,
  }
  if (ok && job.bookRule) {
    const book = (payload?.data as Record<string, unknown> | undefined)?.book as Record<string, unknown> | undefined
    summary.book = {
      title: book?.title ?? null,
      author: book?.author ?? null,
      cover: book?.cover ?? null,
      status: book?.status ?? null,
      category: book?.category ?? null,
      chapterCount: book?.chapterCount ?? null,
    }
  }
  if (ok && job.includeHtml && typeof payload?.html === 'string') {
    const hints = paginationHints(payload.html, job.url)
    summary.nextish = hints.nextish
    summary.pagedHrefs = hints.pagedHrefs
    summary.bookLinks = bookLinkHints(payload.html, new URL(job.url).host)
    // 保存原始 HTML 片段供离线核对（仅前 400KB）
    await Bun.write(`${OUT}/${job.tag}.html`, payload.html.slice(0, 400_000))
  }
  await Bun.write(`${OUT}/${job.tag}.json`, JSON.stringify({ summary, ...(job.bookRule ? { payload } : {}) }, null, 2))
  console.log(JSON.stringify(summary, null, 1))
  await new Promise((r) => setTimeout(r, job.gapAfterMs))
}
await db.$disconnect()
console.log('BATCH DONE')
