/**
 * Task 12-c 封面选择器验证（轮 6）：每站抓 1 个真实书页，用 DB bookRule.coverSelector 走引擎提取验证命中。
 * aijjxs / 77shuku 无历史书页 URL：先经列表页提取拿 1 个书页 URL（计每站总请求 ≤6 预算内）。
 * pilishuwu（CF 拦截）跳过；ddyueshu 以 DB 4/4 封面落盘历史证据闭环，不再发请求。
 * 结果写 /tmp/probe-covers.json。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const ENGINE = 'http://localhost:3030/api/test'

const rules = await db.scrapeRule.findMany({ orderBy: { id: 'asc' } })
await db.$disconnect()
const ruleById = new Map(rules.map((r) => [r.id, r]))

const parseRule = (s: string | null): Record<string, string> => {
  try {
    return JSON.parse(s || '{}') as Record<string, string>
  } catch {
    return {}
  }
}

interface Case {
  id: number
  name: string
  bookUrl?: string
  /** 需先从该列表页提取书页 URL（占预算 2 请求） */
  listUrl?: string
  charset?: string
  proxy?: string
}

const CASES: Case[] = [
  { id: 10, name: 'aijjxs', listUrl: 'https://www.aijjxs.com/' },
  { id: 12, name: '23qb', bookUrl: 'https://www.23qb.net/book/12449/' },
  { id: 13, name: 'huangjinwu', bookUrl: 'https://www.huangjinwu.org/novel/48387' },
  { id: 14, name: 'ggd66', bookUrl: 'https://www.ggd66.com/qu/367574/' },
  { id: 15, name: 'xinjianpan', bookUrl: 'https://www.xinjianpan.com/txt/wz2j/' },
  { id: 16, name: '101kks', bookUrl: 'https://101kks.com/book/184.html', proxy: 'http://103.237.102.191:11111' },
  { id: 17, name: 'x2552', bookUrl: 'http://www.x2552.com/book/11764.html', charset: 'gbk' },
  { id: 18, name: 'trxsw', bookUrl: 'https://www.trxsw.com/tangren_120718.html', proxy: 'http://67.203.23.79:8081' },
  { id: 20, name: '77shuku', listUrl: 'http://www.77shuku.info/' },
]

async function engineFetch(url: string, opts: { charset?: string; proxy?: string; listRule?: Record<string, string>; bookRule?: Record<string, string> }) {
  const res = await fetch(ENGINE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url, charset: opts.charset, proxy: opts.proxy, timeoutMs: 22000,
      ...(opts.listRule || opts.bookRule ? { rule: { ...(opts.listRule ? { listRule: opts.listRule } : {}), ...(opts.bookRule ? { bookRule: opts.bookRule } : {}) } } : {}),
    }),
    signal: AbortSignal.timeout(45_000),
  })
  return (await res.json()) as {
    ok?: boolean; error?: string; status?: number
    data?: { list?: { items?: { title: string; url: string | null }[] }; book?: { title: string; author: string; cover: string | null } }
    warnings?: string[]
  }
}

const out: Record<string, unknown> = {}
const save = () => writeFileSync('/tmp/probe-covers.json', JSON.stringify(out, null, 1))

for (const c of CASES) {
  await sleep(2400)
  const r = ruleById.get(c.id)
  if (!r) continue
  const bookRule = parseRule(r.bookRule)
  const entry: Record<string, unknown> = {}
  try {
    let bookUrl = c.bookUrl
    if (!bookUrl && c.listUrl) {
      const lj = await engineFetch(c.listUrl, { charset: c.charset, proxy: c.proxy, listRule: parseRule(r.listRule) })
      const first = lj.data?.list?.items?.find((it) => it.url)
      entry.listFirstItem = first ?? null
      entry.listOk = lj.ok ?? false
      bookUrl = first?.url ?? undefined
      await sleep(2400)
    }
    if (!bookUrl) {
      entry.ok = false
      entry.error = 'no book url available'
    } else {
      entry.bookUrl = bookUrl
      const bj = await engineFetch(bookUrl, { charset: c.charset, proxy: c.proxy, bookRule })
      const book = bj.data?.book
      entry.ok = bj.ok ?? false
      entry.httpStatus = bj.status
      entry.error = bj.error ?? null
      entry.title = book?.title ?? null
      entry.author = book?.author ?? null
      const cover = book?.cover ?? null
      entry.cover = cover
      entry.coverHit = typeof cover === 'string' && cover.length > 0
      entry.coverAbs = typeof cover === 'string' && /^https?:\/\//.test(cover)
      entry.coverShape = typeof cover === 'string'
        ? { ext: /\.(\w{3,4})(?:[?#]|$)/.exec(cover)?.[1] ?? 'none', isDataUri: cover.startsWith('data:'), len: cover.length }
        : null
      entry.coverWarnings = (bj.warnings ?? []).filter((w) => /cover|封面/i.test(w))
    }
  } catch (e) {
    entry.ok = false
    entry.error = e instanceof Error ? e.message : String(e)
  }
  out[c.name] = entry
  save()
  console.log(`cover id=${c.id} ${c.name}: ok=${entry.ok} coverHit=${entry.coverHit}`)
}
console.log('done')
