/**
 * Task 12-c 分页探测（轮 2B 补跑）：77shuku 导航（上轮代理超时）+ pilishuwu /{cid}/list/2.html 验证。
 * 结果写 /tmp/probe-nav2.json。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const ENGINE = 'http://localhost:3030/api/test'

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
    signal: AbortSignal.timeout(50_000),
  })
  return (await res.json()) as {
    ok?: boolean; error?: string; status?: number; strategy?: string; encoding?: string; html?: string
    warnings?: string[]
  }
}

const out: Record<string, unknown> = {}
writeFileSync('/tmp/probe-nav2.json', JSON.stringify(out, null, 1))

// ---- 77shuku 首页导航（重试 1 次；代理可能抖动）----
const NAV_RE = /(?:sort|list|top|class|rank|fenlei|category|lastupdate|book\/|novels|xiaoshuo|\/\d+\/list|modules)/i
for (const attempt of [1, 2]) {
  await sleep(attempt === 1 ? 2000 : 6000)
  try {
    const j = await fetchPage('http://www.77shuku.info/', {})
    if (j.ok && j.html) {
      out.nav_77shuku = { ok: true, encoding: j.encoding, links: extractAnchors(j.html).filter((a) => NAV_RE.test(a.href)).slice(0, 40) }
      console.log(`77shuku nav ok, links=${(out.nav_77shuku as { links: unknown[] }).links.length}`)
      break
    }
    out.nav_77shuku = { ok: false, error: j.error ?? null }
    console.log(`77shuku nav attempt ${attempt}: fail ${j.error ?? ''}`)
  } catch (e) {
    out.nav_77shuku = { ok: false, error: e instanceof Error ? e.message : String(e) }
    console.log(`77shuku nav attempt ${attempt}: EXCEPTION`)
  }
}
writeFileSync('/tmp/probe-nav2.json', JSON.stringify(out, null, 1))

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
    sampleLinks: anchors.filter((a) => /info\.html|read\//.test(a.href)).slice(0, 6),
  }
  console.log(`pilishuwu /2/list/2.html: ok=${j.ok} encoding=${j.encoding} anchors=${anchors.length}`)
}
writeFileSync('/tmp/probe-nav2.json', JSON.stringify(out, null, 1))
console.log('written /tmp/probe-nav2.json')
