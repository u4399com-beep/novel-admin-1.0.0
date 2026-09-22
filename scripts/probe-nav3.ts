/**
 * Task 12-c 分页探测（轮 3）：aijjxs/ddyueshu/huangjinwu 首页导航列表页入口 + pilishuwu 重试。
 * 每步 try/catch + 增量写盘，单站失败不拖垮整轮。结果写 /tmp/probe-nav3.json。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const ENGINE = 'http://localhost:3030/api/test'
const NAV_RE = /(?:sort|list|top|class|rank|fenlei|category|lastupdate|book\/|novels|xiaoshuo|\/\d+\/list|modules|e\/[a-z])/i

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
    body: JSON.stringify({ url, charset: opts.charset, proxy: opts.proxy, includeHtml: true, timeoutMs: 22000 }),
    signal: AbortSignal.timeout(45_000),
  })
  return (await res.json()) as {
    ok?: boolean; error?: string; status?: number; strategy?: string; encoding?: string; html?: string
  }
}

const out: Record<string, unknown> = {}
const save = () => writeFileSync('/tmp/probe-nav3.json', JSON.stringify(out, null, 1))

const NAV_SITES = [
  { id: 10, name: 'aijjxs', url: 'https://www.aijjxs.com/' },
  { id: 11, name: 'ddyueshu', url: 'https://www.ddyueshu.cc/', charset: 'gbk' },
  { id: 13, name: 'huangjinwu', url: 'https://www.huangjinwu.org/' },
]
for (const s of NAV_SITES) {
  await sleep(2300)
  try {
    const j = await fetchPage(s.url, { charset: s.charset })
    const links = j.ok && j.html ? extractAnchors(j.html).filter((a) => NAV_RE.test(a.href)) : []
    out[`nav_${s.name}`] = { ok: j.ok ?? false, error: j.error ?? null, encoding: j.encoding, links: links.slice(0, 40) }
    console.log(`nav id=${s.id} ${s.name}: ok=${j.ok} links=${links.length}`)
  } catch (e) {
    out[`nav_${s.name}`] = { ok: false, error: e instanceof Error ? e.message : String(e) }
    console.log(`nav id=${s.id} ${s.name}: EXCEPTION`)
  }
  save()
}

await sleep(2500)
try {
  const j = await fetchPage('https://www.pilishuwu.com/2/list/2.html', { charset: 'utf-8' })
  const anchors = j.ok && j.html ? extractAnchors(j.html) : []
  const next = anchors.filter((a) => /下一页|下一頁|下页|»|›/.test(a.text) || a.text === '3')
  out.pilishuwu_list2 = {
    ok: j.ok ?? false, error: j.error ?? null, status: j.status, strategy: j.strategy, encoding: j.encoding,
    htmlLength: j.html?.length ?? 0, anchorCount: anchors.length,
    nextCandidates: next.slice(0, 6),
    sampleLinks: anchors.filter((a) => /info\.html|read\//.test(a.href)).slice(0, 6),
  }
  console.log(`pilishuwu /2/list/2.html: ok=${j.ok} encoding=${j.encoding} anchors=${anchors.length}`)
} catch (e) {
  out.pilishuwu_list2 = { ok: false, error: e instanceof Error ? e.message : String(e) }
  console.log('pilishuwu: EXCEPTION')
}
save()
console.log('done')
