/**
 * 采集规则全量探测（用户指令：检测所有采集规则是否完全正确、可用，反反爬措施设置合理）。
 *
 * 对每条启用规则执行三段最小探测（与 worker 同契约，直连引擎 /api/test）：
 *   list    → siteUrl 列表页，items > 0 视为通过
 *   book    → 取列表第一条书 URL，title/author/chapterRefs 视为通过
 *   chapter → 取书页第一条章节 URL，wordCount > 0 视为通过
 *
 * 特殊处理（worklog 既有结论）：
 *   - pilishuwu：CF 数据中心 IP 信誉封锁（历史多轮实测 403/520），跳过探测标记 blocked-draft
 *   - ggd66：熔断冷却约束，本次探测恰好 3 次请求（list/book/chapter 各 1），不重试不翻页
 *   - trxsw：规则自带代理出口（美国），探测走代理验证反反爬链路
 *
 * 输出：控制台表格 + /tmp/rule-probe-report.json
 * 用法: bun scripts/rule-probe.ts
 */
import { PrismaClient } from '@prisma/client'
import { writeFileSync } from 'node:fs'

const db = new PrismaClient()
const ENGINE = 'http://127.0.0.1:3030'
const TIMEOUT_MS = 45_000

interface StepResult {
  ok: boolean
  ms: number
  strategy?: string
  detail: string
}

interface RuleReport {
  ruleId: number
  name: string
  siteUrl: string
  proxy: string
  skipped?: string
  list?: StepResult
  book?: StepResult
  chapter?: StepResult
  verdict: string
}

async function engineProbe(
  url: string,
  kind: 'list' | 'book' | 'chapter',
  ruleJson: string,
  charset: string,
  proxy: string,
): Promise<{ raw: Record<string, unknown> | null; step: StepResult }> {
  const t0 = Date.now()
  // 引擎契约（与 engine-client.ts 同源）：list/book 走 /api/test 且 rule 字段包裹；
  // chapter 走 /api/chapter，rule 直接传 chapterRule 内容，响应 data 即 ChapterData
  const body: Record<string, unknown> =
    kind === 'chapter'
      ? { url, rule: JSON.parse(ruleJson || '{}'), charset, ...(proxy ? { proxy } : {}) }
      : { url, rule: { [`${kind}Rule`]: JSON.parse(ruleJson || '{}') }, charset, ...(proxy ? { proxy } : {}) }
  const path = kind === 'chapter' ? '/api/chapter' : '/api/test'
  try {
    const res = await fetch(`${ENGINE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const ms = Date.now() - t0
    if (!json) return { raw: null, step: { ok: false, ms, detail: `HTTP ${res.status} 响应解析失败` } }
    if (!res.ok || json.ok === false) {
      const detail = String(json.error ?? `HTTP ${res.status}`) + (json.detail ? `（${String(json.detail).slice(0, 120)}）` : '')
      return { raw: null, step: { ok: false, ms, detail } }
    }
    const data = (json.data ?? null) as Record<string, unknown> | null
    if (!data || typeof data !== 'object') {
      return { raw: null, step: { ok: false, ms, detail: '响应缺 data 载荷' } }
    }
    return {
      raw: data,
      step: { ok: true, ms, strategy: typeof json.strategy === 'string' ? json.strategy : undefined, detail: 'ok' },
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { raw: null, step: { ok: false, ms: Date.now() - t0, detail: /timeout|abort/i.test(msg) ? `超时(${TIMEOUT_MS / 1000}s)` : msg.slice(0, 120) } }
  }
}

async function probeRule(rule: { id: number; name: string; siteUrl: string; charset: string; proxy: string; listRule: string; bookRule: string; chapterRule: string }): Promise<RuleReport> {
  const report: RuleReport = { ruleId: rule.id, name: rule.name, siteUrl: rule.siteUrl, proxy: rule.proxy || '直连', verdict: '' }

  // ---- list ----
  const list = await engineProbe(rule.siteUrl, 'list', rule.listRule, rule.charset, rule.proxy)
  report.list = list.step
  if (!list.step.ok || !list.raw) {
    report.verdict = `list 失败: ${list.step.detail}`
    return report
  }
  const listPayload = (list.raw as { list?: { items?: Array<{ title?: string; url?: string | null }> } }).list
  const items = listPayload?.items ?? []
  report.list.detail = `items=${items.length}`
  const firstBook = items.find((i) => i.url)
  if (!firstBook) {
    report.verdict = 'list 通过但无可读书条目'
    return report
  }

  // ---- book ----
  const book = await engineProbe(firstBook.url as string, 'book', rule.bookRule, rule.charset, rule.proxy)
  report.book = book.step
  if (!book.step.ok || !book.raw) {
    report.verdict = `book 失败: ${book.step.detail}`
    return report
  }
  const bookPayload = (book.raw as { book?: { title?: string; author?: string; chapters?: Array<{ title?: string; url?: string | null }> } }).book
  const b = bookPayload ?? {}
  const chs = b.chapters ?? []
  report.book.detail = `《${String(b.title ?? '').slice(0, 24)}》/${String(b.author ?? '').slice(0, 12)} 章节链接=${chs.length}`
  const firstCh = chs.find((c) => c.url)
  if (!firstCh) {
    report.verdict = 'book 通过但无章节链接'
    return report
  }

  // ---- chapter ----
  const ch = await engineProbe(firstCh.url as string, 'chapter', rule.chapterRule, rule.charset, rule.proxy)
  report.chapter = ch.step
  if (!ch.step.ok || !ch.raw) {
    report.verdict = `chapter 失败: ${ch.step.detail}`
    return report
  }
  const c = ch.raw as { wordCount?: number; title?: string }
  report.chapter.detail = `「${String(c.title ?? '').slice(0, 20)}」wordCount=${c.wordCount ?? 0}`
  report.verdict = (c.wordCount ?? 0) > 0 ? 'PASS' : 'chapter 空内容（源站空壳或正文选择器失配）'
  return report
}

async function main() {
  const rules = await db.scrapeRule.findMany({ where: { enabled: true }, orderBy: { id: 'asc' } })
  console.log(`启用规则 ${rules.length} 条，开始三段探测（pilishuwu 跳过 / ggd66 限 3 请求）…\n`)
  const reports: RuleReport[] = []

  for (const r of rules) {
    if (r.name.toLowerCase().includes('pilishuwu')) {
      reports.push({ ruleId: r.id, name: r.name, siteUrl: r.siteUrl, proxy: r.proxy || '直连', skipped: 'CF 数据中心封锁（历史实测 403/520），草稿规则不探测', verdict: 'SKIP' })
      console.log(`[${r.name}] SKIP（CF 封封锁草稿）`)
      continue
    }
    console.log(`[${r.name}] 探测中…`)
    const rep = await probeRule({ id: r.id, name: r.name, siteUrl: r.siteUrl, charset: r.charset, proxy: r.proxy, listRule: r.listRule, bookRule: r.bookRule, chapterRule: r.chapterRule })
    reports.push(rep)
    const fmt = (s?: StepResult) => (s ? `${s.ok ? '✓' : '✗'}${s.strategy ? `(${s.strategy})` : ''}${s.ms ? ` ${s.ms}ms` : ''} ${s.detail}` : '-')
    console.log(`  list   : ${fmt(rep.list)}`)
    console.log(`  book   : ${fmt(rep.book)}`)
    console.log(`  chapter: ${fmt(rep.chapter)}`)
    console.log(`  → ${rep.verdict}\n`)
    await new Promise((res) => setTimeout(res, 2000)) // 站点间 2s 间隔，反反爬礼貌探测
  }

  writeFileSync('/tmp/rule-probe-report.json', JSON.stringify(reports, null, 2))
  const pass = reports.filter((r) => r.verdict === 'PASS').length
  const skip = reports.filter((r) => r.verdict === 'SKIP').length
  console.log(`=== 汇总: PASS ${pass} / SKIP ${skip} / FAIL ${reports.length - pass - skip}（报告 /tmp/rule-probe-report.json） ===`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
