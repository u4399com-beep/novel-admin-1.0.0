/**
 * 定向复核（首次全量探测的 3 个负样本甄别）：
 * 1. 101kks：list 走 curl-impersonate（CF BFM 站，二进制刚恢复）
 * 2. aijjxs：book 页无全量目录属预期，验证 catalogUrl → 目录页 → chapterLinkSelector 链路
 * 3. ggd66：siteUrl=首页无列表（Task 3 已证列表在 /sort/{cid}/{page}/），探测 /sort/1/1/
 * 结果用于决定是否修正规则 siteUrl。
 */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const ENGINE = 'http://127.0.0.1:3030'
const TIMEOUT = 45_000

async function call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${ENGINE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!json || !res.ok || json.ok === false) {
      console.log(`  ! ${path} HTTP ${res.status}:`, String(json?.error ?? json?.detail ?? '').slice(0, 150))
      return null
    }
    console.log(`  strategy=${json.strategy} warnings=${JSON.stringify(json.warnings ?? []).slice(0, 300)}`)
    return (json.data ?? null) as Record<string, unknown> | null
  } catch (e) {
    console.log(`  ! ${path} 异常:`, e instanceof Error ? e.message.slice(0, 120) : String(e))
    return null
  }
}

async function main() {
  // ---- 1. 101kks ----
  console.log('=== 101kks list（curl-impersonate 链路验证）===')
  const r101 = await db.scrapeRule.findUnique({ where: { name: '101kks' } })
  if (r101) {
    const d = await call('/api/test', { url: 'https://101kks.com/novels/class/0_1.html', rule: { listRule: JSON.parse(r101.listRule) }, charset: r101.charset })
    const items = ((d?.list as { items?: unknown[] })?.items ?? []) as Array<{ title?: string; url?: string }>
    console.log(`  items=${items.length} 首条=${JSON.stringify(items[0] ?? null)?.slice(0, 120)}`)
  }

  // ---- 2. aijjxs catalog 链 ----
  console.log('=== aijjxs catalog 链验证 ===')
  const raj = await db.scrapeRule.findUnique({ where: { name: 'aijjxs' } })
  if (raj) {
    const bookData = await call('/api/test', { url: 'https://www.aijjxs.com/plus/book.php?aid=1', rule: { bookRule: JSON.parse(raj.bookRule) }, charset: raj.charset })
    const book = (bookData?.book ?? {}) as { title?: string; catalogUrl?: string | null; chapters?: unknown[] }
    console.log(`  book=《${String(book.title ?? '')}》 章节链接=${(book.chapters ?? []).length} catalogUrl=${String(book.catalogUrl ?? 'null')}`)
    if (book.catalogUrl) {
      const catData = await call('/api/test', { url: book.catalogUrl, rule: { bookRule: { chapterLinkSelector: 'ul.chapter-list a' } }, charset: raj.charset, referer: 'https://www.aijjxs.com/' })
      const cat = (catData?.book ?? {}) as { chapters?: Array<{ title?: string; url?: string }> }
      const chs = cat.chapters ?? []
      console.log(`  catalog 章节链接=${chs.length} 首条=${JSON.stringify(chs[0] ?? null)?.slice(0, 120)}`)
    } else {
      console.log('  ⚠ catalogUrl 未提取到：用真实任务书目验证（下方从 DB 取一本）')
    }
  }

  // ---- 3. ggd66 /sort/ ----
  console.log('=== ggd66 /sort/1/1/ 列表验证（本次会话 ggd66 第 2 次请求）===')
  const rgg = await db.scrapeRule.findUnique({ where: { name: 'ggd66' } })
  if (rgg) {
    const d = await call('/api/test', { url: 'https://www.ggd66.com/sort/1/1/', rule: { listRule: JSON.parse(rgg.listRule) }, charset: rgg.charset })
    const items = ((d?.list as { items?: unknown[] })?.items ?? []) as Array<{ title?: string; url?: string }>
    console.log(`  items=${items.length} 首3条=${JSON.stringify(items.slice(0, 3))?.slice(0, 260)}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
