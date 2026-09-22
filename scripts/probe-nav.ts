/**
 * Task 12-c 分页探测（轮 2B）：首页即列表（无翻页）的 4 站 —— 从首页导航找「带翻页的真实列表页」入口；
 * pilishuwu 直接验证 /{cid}/list/2.html 翻页格式（charset 修正为 utf-8 重试）。
 * 结果写 /tmp/probe-nav.json。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const ENGINE = 'http://localhost:3030/api/test'
const NAV_HREF_RE = /(?:sort|list|top|class|rank|fenlei|category|lastupdate|book\/|novels|xiaoshuo|\/\d+\/list|modules|e\/t)/i

function extractAnchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = []
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    const text = (m[5] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    if (href && !/^(javascript:|#)/i.test(href)) out.push({ href, text: text.slice(0, 30) })
  }
  return out
}

async function fetchPage(url: string, opts: { charset?: string; proxy?: string }) {
  const res = await fetch(ENGINE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, charset: opts.charset, proxy: opts.proxy, includeHtml: true, timeoutMs: 25000 }),
    signal: AbortSignal.timeout(45_000),
  })
  return (await res.json()) as {
    ok?: boolean; error?: string; status?: number; strategy?: string; encoding?: string; html?: string
    data?: { list?: { count?: number; itemSelector?: string; items?: unknown[] } }
    warnings?: string[]
  }
}

const out: Record<string, unknown> = {}

// ---- 4 站首页导航 ----
const NAV_SITES = [
  { id: 10, name: 'aijjxs', url: 'https://www.aijjxs.com/' },
  { id: 11, name: 'ddyueshu', url: 'https://www.ddyueshu.cc/', charset: 'gbk' },
  { id: 13, name: 'huangjinwu', url: 'https://www.huangjinwu.org/' },
  { id: 20, name: '77shuku', url: 'http://www.77shuku.info/' },
]
const navLinks: Record<string, { href: string; text: string }[]> = {}
for (const s of NAV_SITES) {
  await sleep(2300)
  const j = await fetchPage(s.url, { charset: s.charset })
  navLinks[s.name] = j.ok && j.html ? extractAnchors(j.html).filter((a) => NAV_HREF_RE.test(a.href)).slice(0, 40) : []
  out[`nav_${s.name}`] = { ok: j.ok ?? false, error: j.error ?? null, encoding: j.encoding, n: navLinks[s.name].length }
  console.log(`nav id=${s.id} ${s.name}: ok=${j.ok} links=${navLinks[s.name].length}`)
}
out.navLinks = navLinks

// ---- pilishuwu：/{cid}/list/{k}.html 验证（charset utf-8）----
await sleep(2500)
{
  const j = await fetchPage('https://www.pilishuwu.com/2/list/2.html', { charset: 'utf-8' })
  const anchors = j.ok && j.html ? extractAnchors(j.html) : []
  const next = anchors.filter((a) => /下一页|下一頁|下页|»|›/.test(a.text) || a.text === '3')
  out.pilishuwu_list2 = {
    ok: j.ok ?? false, error: j.error ?? null, status: j.status, strategy: j.strategy, encoding: j.encoding,
    htmlLength: j.html?.length ?? 0, anchorCount: anchors.length,
    nextCandidates: next.slice(0, 6),
    sampleTitles: anchors.filter((a) => /\/\d+\/\d+\/info\.html|\/book\/|info\.html/.test(a.href)).slice(0, 5),
  }
  console.log(`pilishuwu /2/list/2.html: ok=${j.ok} encoding=${j.encoding} anchors=${anchors.length}`)
}
writeFileSync('/tmp/probe-nav.json', JSON.stringify(out, null, 1))
console.log('written /tmp/probe-nav.json')
