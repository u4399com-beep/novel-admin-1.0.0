/**
 * Task 12-c 分页探测（轮 1）：逐站抓列表第 1 页，提取「下一页/页码」链接候选。
 * 走引擎 /api/test（限速 + charset + 代理链路同生产），结果写 /tmp/probe-pagination.json
 * （用 Read 工具读取，绕过 bash stdout 对 [h 的显示吞字假象）。
 * 频率控制：站间 ≥2.2s；ggd66（近期熔断站）≥5.2s 且仅 1 请求。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'

const ENGINE = 'http://localhost:3030/api/test'

interface Site {
  id: number
  name: string
  url: string
  charset?: string
  proxy?: string
  /** 熔断敏感站：站前额外等待 + 仅单请求 */
  slow?: boolean
}

const SITES: Site[] = [
  { id: 10, name: 'aijjxs', url: 'https://www.aijjxs.com/' },
  { id: 11, name: 'ddyueshu', url: 'https://www.ddyueshu.cc/', charset: 'gbk' },
  { id: 12, name: '23qb', url: 'https://www.23qb.net/book/lastupdate_0_0_0_0_0_0_0_1_0.html' },
  { id: 13, name: 'huangjinwu', url: 'https://www.huangjinwu.org/' },
  { id: 14, name: 'ggd66', url: 'https://www.ggd66.com/sort/1/1/', slow: true },
  { id: 15, name: 'xinjianpan', url: 'https://www.xinjianpan.com/rank/lastupdate/?page=1' },
  { id: 16, name: '101kks', url: 'https://101kks.com/novels/class/0_1.html', proxy: 'http://103.237.102.191:11111' },
  { id: 17, name: 'x2552', url: 'http://www.x2552.com/list/1_1.html', charset: 'gbk' },
  { id: 18, name: 'trxsw', url: 'http://www.trxsw.com/lastupdate/', proxy: 'http://67.203.23.79:8081' },
  { id: 19, name: 'pilishuwu', url: 'https://www.pilishuwu.com/', charset: 'gbk' },
  { id: 20, name: '77shuku', url: 'http://www.77shuku.info/', proxy: 'http://113.204.79.230:9091' },
]

const NEXT_TEXT_RE = /^(?:下一页|下一頁|下页|下壹頁|下一页>|next\s*page|next|»|›|下頁)$/i
const NEXT_TEXT_LOOSE_RE = /下一页|下一頁|下頁|下页|next\s*page|»|›/i

/** 从 HTML 提取全部 <a href>（href 与去标签文本） */
function extractAnchors(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = []
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = (m[2] ?? m[3] ?? m[4] ?? '').trim()
    const text = (m[5] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    if (href && !/^(javascript:|#)/i.test(href)) out.push({ href, text: text.slice(0, 40) })
  }
  return out
}

async function probeSite(site: Site) {
  const t0 = Date.now()
  try {
    const res = await fetch(ENGINE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: site.url, charset: site.charset, proxy: site.proxy, includeHtml: true, timeoutMs: 25000 }),
      signal: AbortSignal.timeout(40_000),
    })
    const j = (await res.json()) as {
      ok?: boolean
      error?: string
      status?: number
      strategy?: string
      encoding?: string
      htmlLength?: number
      html?: string
      attempts?: { strategy: string; status?: number; ok?: boolean }[]
    }
    if (!j.ok || !j.html) {
      return {
        id: site.id, name: site.name, ok: false, error: j.error ?? `HTTP ${res.status}`,
        status: j.status, strategy: j.strategy, attempts: j.attempts?.map((a) => ({ s: a.strategy, code: a.status, ok: a.ok })),
        elapsedMs: Date.now() - t0,
      }
    }
    const anchors = extractAnchors(j.html)
    const nextStrict = anchors.filter((a) => NEXT_TEXT_RE.test(a.text))
    const nextLoose = anchors.filter((a) => NEXT_TEXT_LOOSE_RE.test(a.text) && !NEXT_TEXT_RE.test(a.text))
    // 页码数字链接（文本为纯数字 2-5）与 href 带页码形态的链接各取前几个
    const numeric = anchors.filter((a) => /^[2-5]$/.test(a.text)).slice(0, 8)
    const hrefPaged = anchors.filter((a) => /(?:page|p)=?[2-5]|_[2-5]\.|\/[2-5]\/|-[2-5]\.|index[2-5]/i.test(a.href) && !a.href.includes('javascript')).slice(0, 12)
    return {
      id: site.id, name: site.name, ok: true, status: j.status, strategy: j.strategy,
      encoding: j.encoding, htmlLength: j.htmlLength, anchorCount: anchors.length,
      nextStrict: nextStrict.slice(0, 6), nextLoose: nextLoose.slice(0, 6),
      numeric, hrefPaged,
      elapsedMs: Date.now() - t0,
    }
  } catch (e) {
    return { id: site.id, name: site.name, ok: false, error: e instanceof Error ? e.message : String(e), elapsedMs: Date.now() - t0 }
  }
}

const results: unknown[] = []
for (const site of SITES) {
  await sleep(site.slow ? 5200 : 2300)
  console.log(`probing id=${site.id} ${site.name} …`)
  const r = await probeSite(site)
  results.push(r)
  console.log(`  -> ok=${'ok' in r ? r.ok : '?'} ${'elapsedMs' in r ? r.elapsedMs + 'ms' : ''}`)
}
writeFileSync('/tmp/probe-pagination.json', JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 1))
console.log('written /tmp/probe-pagination.json')
