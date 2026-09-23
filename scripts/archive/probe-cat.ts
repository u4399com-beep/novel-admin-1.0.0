/**
 * Task 12-c 分页探测（轮 4）：aijjxs/ddyueshu/huangjinwu 分类页第 1 页 → 找「下一页」真实格式。
 * 结果写 /tmp/probe-cat.json。
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

async function fetchPage(url: string, opts: { charset?: string }) {
  const res = await fetch(ENGINE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, charset: opts.charset, includeHtml: true, timeoutMs: 22000 }),
    signal: AbortSignal.timeout(45_000),
  })
  return (await res.json()) as {
    ok?: boolean; error?: string; status?: number; strategy?: string; encoding?: string; html?: string
  }
}

const out: Record<string, unknown> = {}
const save = () => writeFileSync('/tmp/probe-cat.json', JSON.stringify(out, null, 1))

const CAT_SITES = [
  { id: 10, name: 'aijjxs', url: 'https://www.aijjxs.com/txt/chongshengxiaoshuo/' },
  { id: 11, name: 'ddyueshu', url: 'https://www.ddyueshu.cc/xiaoshuodaquan/', charset: 'gbk' },
  { id: 13, name: 'huangjinwu', url: 'https://www.huangjinwu.org/list' },
]
for (const s of CAT_SITES) {
  await sleep(2300)
  try {
    const j = await fetchPage(s.url, { charset: s.charset })
    if (!j.ok || !j.html) {
      out[s.name] = { ok: false, error: j.error ?? null, status: j.status }
    } else {
      const anchors = extractAnchors(j.html)
      const next = anchors.filter((a) => /下一页|下一頁|下页|»|›|尾页|末页/.test(a.text))
      const numeric = anchors.filter((a) => /^[2-5]$/.test(a.text)).slice(0, 8)
      const hrefPaged = anchors
        .filter((a) => /(?:page|p|index|list)=[2-5]|_[2-5]\.html|\/[2-5]\/?["']?$|\/list\/[2-5]\.|_[2-5]\/$|index_[2-5]/i.test(a.href))
        .slice(0, 12)
      out[s.name] = {
        ok: true, url: s.url, status: j.status, strategy: j.strategy, encoding: j.encoding,
        htmlLength: j.html.length, anchorCount: anchors.length,
        next: next.slice(0, 6), numeric, hrefPaged,
      }
      console.log(`cat id=${s.id} ${s.name}: ok anchors=${anchors.length} next=${next.length}`)
    }
  } catch (e) {
    out[s.name] = { ok: false, error: e instanceof Error ? e.message : String(e) }
    console.log(`cat id=${s.id} ${s.name}: EXCEPTION`)
  }
  save()
}
console.log('done')
