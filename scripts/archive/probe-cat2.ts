/**
 * Task 12-c 分页探测（轮 5，末轮）：① ddyueshu 分类页翻页格式 ② aijjxs/huangjinwu/ddyueshu
 * 列表页 itemSelector 命中复验（同一次请求带 listRule）。结果写 /tmp/probe-cat2.json。
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

async function fetchPage(url: string, opts: { charset?: string; listRule?: Record<string, string> }) {
  const res = await fetch(ENGINE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, charset: opts.charset, includeHtml: true, timeoutMs: 22000, ...(opts.listRule ? { rule: { listRule: opts.listRule } } : {}) }),
    signal: AbortSignal.timeout(45_000),
  })
  return (await res.json()) as {
    ok?: boolean; error?: string; status?: number; strategy?: string; encoding?: string; html?: string
    data?: { list?: { count?: number; itemSelector?: string; items?: { title: string; url: string | null; author: string }[] } }
    warnings?: string[]
  }
}

const out: Record<string, unknown> = {}
const save = () => writeFileSync('/tmp/probe-cat2.json', JSON.stringify(out, null, 1))

// ① ddyueshu 分类页（玄幻）翻页 + itemSelector 复验
await sleep(2300)
try {
  const j = await fetchPage('https://www.ddyueshu.cc/xuanhuanxiaoshuo/', {
    charset: 'gbk',
    listRule: { itemSelector: '#hotcontent .item', titleSelector: 'dl dt a', linkSelector: 'dl dt a', authorSelector: 'dl dt span' },
  })
  if (!j.ok || !j.html) {
    out.ddyueshu_cat = { ok: false, error: j.error ?? null }
  } else {
    const anchors = extractAnchors(j.html)
    out.ddyueshu_cat = {
      ok: true, status: j.status, encoding: j.encoding,
      next: anchors.filter((a) => /下一页|下一頁|下页|»|›|尾页|末页/.test(a.text)).slice(0, 5),
      numeric: anchors.filter((a) => /^[2-5]$/.test(a.text)).slice(0, 6),
      hrefPaged: anchors.filter((a) => /(?:_[2-5]\.html|_[2-5]\/$|\/[2-5]\/?["']?$|page=[2-5]|index[2-5])/i.test(a.href)).slice(0, 10),
      listExtract: j.data?.list ? { count: j.data.list.count, itemSelector: j.data.list.itemSelector, first: j.data.list.items?.[0] ?? null } : null,
      warnings: (j.warnings ?? []).filter((w) => !/robots/i.test(w)).slice(0, 3),
    }
    console.log(`ddyueshu cat: ok anchors=${anchors.length} next=${(out.ddyueshu_cat as { next: unknown[] }).next.length} listCount=${j.data?.list?.count}`)
  }
} catch (e) {
  out.ddyueshu_cat = { ok: false, error: e instanceof Error ? e.message : String(e) }
  console.log('ddyueshu cat: EXCEPTION')
}
save()

// ② aijjxs 分类页 itemSelector 复验
await sleep(2300)
try {
  const j = await fetchPage('https://www.aijjxs.com/txt/chongshengxiaoshuo/', {
    listRule: { itemSelector: 'ul.lines-books li', titleSelector: 'a', linkSelector: '.line-main a', authorSelector: '.author' },
  })
  out.aijjxs_cat_list = j.ok
    ? { ok: true, listExtract: j.data?.list ? { count: j.data.list.count, itemSelector: j.data.list.itemSelector, first: j.data.list.items?.[0] ?? null } : null, warnings: (j.warnings ?? []).filter((w) => !/robots/i.test(w)).slice(0, 3) }
    : { ok: false, error: j.error ?? null }
  console.log(`aijjxs cat list: ok=${j.ok} count=${j.data?.list?.count}`)
} catch (e) {
  out.aijjxs_cat_list = { ok: false, error: e instanceof Error ? e.message : String(e) }
  console.log('aijjxs cat list: EXCEPTION')
}
save()

// ③ huangjinwu /list itemSelector 复验
await sleep(2300)
try {
  const j = await fetchPage('https://www.huangjinwu.org/list', {
    listRule: { itemSelector: 'a.book-card', titleSelector: '.book-title', authorSelector: '.book-author' },
  })
  out.huangjinwu_list_list = j.ok
    ? { ok: true, listExtract: j.data?.list ? { count: j.data.list.count, itemSelector: j.data.list.itemSelector, first: j.data.list.items?.[0] ?? null } : null, warnings: (j.warnings ?? []).filter((w) => !/robots/i.test(w)).slice(0, 3) }
    : { ok: false, error: j.error ?? null }
  console.log(`huangjinwu /list list: ok=${j.ok} count=${j.data?.list?.count}`)
} catch (e) {
  out.huangjinwu_list_list = { ok: false, error: e instanceof Error ? e.message : String(e) }
  console.log('huangjinwu /list list: EXCEPTION')
}
save()
console.log('done')
