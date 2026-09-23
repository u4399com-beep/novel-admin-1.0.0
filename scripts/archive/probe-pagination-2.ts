/**
 * Task 12-c 分页探测（轮 2A）：对已确定模板的 6 站，构造第 2 页 URL 并用该站 listRule 提取验证条目数。
 * 走引擎 /api/test（同生产链路），结果写 /tmp/probe-p2.json（Read 工具读取防显示失真）。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const ENGINE = 'http://localhost:3030/api/test'

interface Case {
  id: number
  name: string
  page2Url: string
  charset?: string
  proxy?: string
  listRule: Record<string, string>
  slow?: boolean
}

const CASES: Case[] = [
  {
    id: 12, name: '23qb',
    page2Url: 'https://www.23qb.net/book/lastupdate_0_0_0_0_0_0_0_2_0.html',
    listRule: { itemSelector: '.module-item', titleSelector: 'a.module-item-title', linkSelector: 'a.module-item-title', authorSelector: '.module-item-text' },
  },
  {
    id: 14, name: 'ggd66', slow: true,
    page2Url: 'https://www.ggd66.com/sort/1/2/',
    listRule: { itemSelector: '.bookbox', titleSelector: '.bookname a', linkSelector: '.bookname a', authorSelector: '.author' },
  },
  {
    id: 15, name: 'xinjianpan',
    page2Url: 'https://www.xinjianpan.com/rank/lastupdate/?page=2',
    listRule: { itemSelector: 'dl[class*="list-item"]', titleSelector: 'dt a', linkSelector: 'dt a', authorSelector: 'dd a' },
  },
  {
    id: 16, name: '101kks', proxy: 'http://103.237.102.191:11111',
    page2Url: 'https://101kks.com/novels/class/0_2.html',
    listRule: { itemSelector: '.newnovels li', titleSelector: 'h3', linkSelector: 'a', authorSelector: 'h4' },
  },
  {
    id: 17, name: 'x2552', charset: 'gbk',
    page2Url: 'http://www.x2552.com/list/1_2.html',
    listRule: { itemSelector: '#centerm tr', titleSelector: 'td:nth-child(1) a', linkSelector: 'td:nth-child(1) a', authorSelector: 'td.C' },
  },
  {
    id: 18, name: 'trxsw', proxy: 'http://67.203.23.79:8081',
    page2Url: 'http://www.trxsw.com/lastupdate/2/',
    listRule: { itemSelector: '#alistbox', titleSelector: '.title h2 a', linkSelector: '.pic a', authorSelector: '.title span' },
  },
]

const out: unknown[] = []
for (const c of CASES) {
  await sleep(c.slow ? 5200 : 2300)
  const t0 = Date.now()
  try {
    const res = await fetch(ENGINE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: c.page2Url, charset: c.charset, proxy: c.proxy, timeoutMs: 25000, rule: { listRule: c.listRule } }),
      signal: AbortSignal.timeout(40_000),
    })
    const j = (await res.json()) as {
      ok?: boolean; error?: string; status?: number; strategy?: string; encoding?: string
      data?: { list?: { count?: number; itemSelector?: string; items?: { title: string; url: string | null; author: string }[] } }
      warnings?: string[]
    }
    const list = j.data?.list
    out.push({
      id: c.id, name: c.name, page2Url: c.page2Url, ok: j.ok ?? false, httpStatus: j.status,
      strategy: j.strategy, encoding: j.encoding, itemCount: list?.count ?? null,
      itemSelectorHit: list?.itemSelector ?? null,
      firstItem: list?.items?.[0] ?? null,
      warnings: (j.warnings ?? []).filter((w) => !/robots/i.test(w)).slice(0, 3),
      error: j.error ?? null,
      elapsedMs: Date.now() - t0,
    })
    console.log(`id=${c.id} ${c.name}: ok=${j.ok} items=${list?.count ?? 'ERR'}`)
  } catch (e) {
    out.push({ id: c.id, name: c.name, page2Url: c.page2Url, ok: false, error: e instanceof Error ? e.message : String(e) })
    console.log(`id=${c.id} ${c.name}: EXCEPTION`)
  }
}
writeFileSync('/tmp/probe-p2.json', JSON.stringify({ results: out }, null, 1))
console.log('written /tmp/probe-p2.json')
