/**
 * 可插拔抓取策略层（反反爬增强版）—— 策略注册表与策略链编排。
 *
 * 策略链顺序（依次尝试直到成功）：
 *   1) fetch-browser     —— 原生 fetch + 完整 Chrome 桌面请求头（UA/Accept/Accept-Language/Sec-Fetch 族/客户端提示 + Referer 链）
 *   2) fetch-ua-rotate   —— UA 轮换：Firefox → Safari → Edge 桌面画像（其中 Safari 不带 Referer，覆盖"无 Referer"变体）
 *   3) fetch-mobile      —— 移动端画像：Android Chrome（带 Referer）→ iPhone Safari（无 Referer）
 *   4) fetch-spider      —— 搜索引擎 spider UA 降级：Googlebot → Baiduspider（仅用于公开内容，不伪造登录态）
 *   5) curl-impersonate  —— 系统 curl_chrome* 二进制（TLS/JA3 指纹级伪装），HTTP/2 失败自动降级 --http1.1
 *   6) got-scraping      —— header-generator 随机真实头 + HTTP/2，失败自动降级 HTTP/1.1（覆盖协议指纹差异）
 *   7) browser           —— Playwright + Chromium 真实渲染（优先 Node 包，缺失时经 Python Playwright 桥接），不可用时优雅跳过
 *
 * 通用能力：
 * - 所有 fetch 走 redirect:'manual' 逐跳 SSRF 校验（内网/重定向后内网跳转一律拒绝，运行时不支持 manual 时降级为 follow+最终 URL 校验）；
 * - 挑战页检测：已知反爬平台强特征（任意体积）+ 极小页启发式（<3KB 且含 verify/challenge/captcha 关键词）
 *   + 0 秒 meta-refresh 跳板（近空正文）→ 标记 blocked，视为失败并继续下一策略；
 * - 请求头画像内 UA 与 Sec-CH-UA 版本严格一致（同一常量派生），Chrome 主版本进程启动时随机化避免固定指纹；
 * - 429/5xx/网络错误在策略间显式指数退避+jitter（受整体预算约束，硬上限 55s 不可突破）；
 *   HTTP 429 附带 Retry-After 头时优先按站点要求的时长退避（同样受预算约束）；
 *   且按主机健康度记忆（host-health.ts）：429/503 后的下一次抓取先主动退避、
 *   连续整链失败达阈值的主机熔断快速失败（半开自动恢复）；
 * - 每次网络尝试（含策略内部子尝试）都经过域名限速，并结构化记录到 attempts 明细；
 * - 整体时间预算（默认上限 55s），超预算后停止尝试并给出 budget-exhausted 备注；
 * - 按主机策略亲和：某主机最近一次成功的策略会被提到链首优先尝试（失败照旧回退全链，见 affinity.ts）。
 *
 * 合规边界：本层只做"请求头/指纹/渲染"层面的通用反反爬增强，
 * 不包含也不预留任何验证码破解、账号伪装、登录态伪造、付费内容绕过逻辑。
 */
import { acquireDomainSlot, assertHostPublic, backoffDelay, checkRobots, isRetryableStatus, MAX_ATTEMPTS, sleep } from '../rate-limit'
import type { AttemptSummary } from '../types'
import { charsetFromContentType, decodeHtml } from '../charset'
import { browserStrategy } from './browser'
import { curlImpersonateStrategy } from './curl-impersonate'
import { fetchBrowserStrategy, fetchMobileStrategy, fetchSpiderStrategy, fetchUaRotateStrategy } from './fetch-strategies'
import { gotScrapingStrategy } from './got-scraping'
import { getPreferredStrategy, recordStrategySuccess } from './affinity'
import { hostCircuitOpenMs, hostPenaltyMs, noteChainFailure, noteChainSuccess, noteRateLimited } from './host-health'
import type { AttemptResult, FetchPageOptions, FetchPageResult, StrategyDef } from './types'
import type { StrategyInfo } from '../types'

export type { FetchPageOptions, FetchPageResult } from './types'
export { affinityStats } from './affinity'

const CHAIN_BUDGET_MS = 55_000

/** 站点级代理池轮换游标（模块级：跨请求轮换出口） */
let proxyCursor = 0

// ==================== 策略编排 ====================

const STRATEGIES: StrategyDef[] = [
  fetchBrowserStrategy,
  fetchUaRotateStrategy,
  fetchMobileStrategy,
  fetchSpiderStrategy,
  curlImpersonateStrategy,
  gotScrapingStrategy,
  browserStrategy,
]

export const STRATEGY_NAMES = STRATEGIES.map((s) => s.name)

export async function listStrategies(): Promise<StrategyInfo[]> {
  return Promise.all(
    STRATEGIES.map(async (s) => ({
      name: s.name,
      description: s.description,
      available: await s.probe().catch(() => false),
    })),
  )
}

async function pickOrder(requested: string | null | undefined, warnings: string[]): Promise<StrategyDef[]> {
  if (requested) {
    const found = STRATEGIES.find((s) => s.name === requested)
    if (!found) {
      warnings.push(`指定策略 "${requested}" 不存在（可选: ${STRATEGY_NAMES.join(', ')}），回退默认顺序`)
    } else if (await found.probe().catch(() => false)) {
      return [found]
    } else {
      warnings.push(`指定策略 "${requested}" 当前不可用，回退默认顺序`)
    }
  }
  return STRATEGIES
}

export function clampTimeout(ms: unknown): number {
  const n = Number(ms)
  if (!Number.isFinite(n)) return 20_000
  return Math.min(60_000, Math.max(2_000, Math.floor(n)))
}

/**
 * 抓取主入口：SSRF 校验 → robots 检查 → 按序尝试策略链（域名限速 + 指数退避重试 + 整体时间预算
 * + 按主机策略亲和提位）→ 字符集解码。永不 throw，全部失败时返回结构化错误。
 */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  const t0 = Date.now()
  const warnings: string[] = []
  const attempts: AttemptSummary[] = []
  const timeoutMs = clampTimeout(opts.timeoutMs)
  // 整体预算：单策略超时再多给余量，硬上限 55s（主站代理 60s 超时之内）
  const budgetMs = Math.min(CHAIN_BUDGET_MS, Math.max(timeoutMs + 8_000, Math.floor(timeoutMs * 2.5)))
  const deadline = t0 + budgetMs

  let host = ''
  try {
    const u = new URL(url)
    host = u.host
  } catch {
    return {
      ok: false, html: '', encoding: '', strategy: '', status: 0, warnings: ['URL 无法解析'],
      attempts: [], robots: { checked: false, disallowed: false, crawlDelayMs: null },
      elapsedMs: Date.now() - t0, error: 'URL 无法解析', detail: url,
    }
  }

  // 入口 SSRF 校验（文本层 + DNS 尽力）——重定向逐跳校验在各策略的 fetchWithRedirectGuard 中
  const entryCheck = await assertHostPublic(new URL(url).hostname)
  if (!entryCheck.ok) {
    return {
      ok: false, html: '', encoding: '', strategy: '', status: 0, warnings,
      attempts, robots: { checked: false, disallowed: false, crawlDelayMs: null },
      elapsedMs: Date.now() - t0, error: 'SSRF 防护拦截', detail: entryCheck.reason ?? '目标主机被拒绝',
    }
  }
  if (entryCheck.warning) warnings.push(`[ssrf] ${entryCheck.warning}`)

  // 主机熔断（Task 24-a host-health）：连败达阈值的主机快速结构化失败，不空烧 55s 预算；
  // 冷却结束自动半开恢复，成功一次即复位。显式指定策略时视为人工调试，跳过熔断。
  const circuitMs = opts.requestedStrategy ? 0 : hostCircuitOpenMs(host)
  if (circuitMs > 0) {
    return {
      ok: false, html: '', encoding: '', strategy: opts.requestedStrategy ?? '', status: 0, warnings,
      attempts, robots: { checked: false, disallowed: false, crawlDelayMs: null },
      elapsedMs: Date.now() - t0,
      error: '目标主机熔断中（近期连续整链失败，暂停请求以防刺激反爬/空耗预算）',
      detail: `主机 ${host} 连续整链失败已达熔断阈值，剩余冷却 ${Math.ceil(circuitMs / 1000)}s 后自动恢复尝试（一次成功即复位）`,
    }
  }

  const robots = await checkRobots(url)
  warnings.push(...robots.warnings)

  // 主机限流记忆（Task 24-a host-health）：最近被 429/503 的主机先主动退避一拍再进链
  // （Retry-After 优先，见 noteRateLimited），避免以固定限速节奏持续刺激限流中的站点。
  // 退避时长受剩余预算约束（至少留 3s 给真实尝试），预算不够时跳过退避。
  const penalty = hostPenaltyMs(host)
  if (penalty > 0) {
    const wait = Math.min(penalty, Math.max(0, deadline - Date.now() - 3000))
    if (wait > 500) {
      warnings.push(`[host-health] 主机 ${host} 最近被限流（429/503），先主动退避 ${(wait / 1000).toFixed(1)}s 再尝试（健康度记忆，成功后清零）`)
      await sleep(wait)
    }
  }

  let order = await pickOrder(opts.requestedStrategy, warnings)

  // 按主机策略亲和：未显式指定策略时，把该主机最近一次成功的策略提到链首
  // （亲和命中失败时后续照旧全链回退，attempts 顺序照实记录）
  if (!opts.requestedStrategy && order.length > 1) {
    const preferred = getPreferredStrategy(host)
    if (preferred) {
      const preferredIdx = order.findIndex((s) => s.name === preferred)
      if (preferredIdx > 0) {
        const preferredDef = order[preferredIdx]
        order = [preferredDef, ...order.slice(0, preferredIdx), ...order.slice(preferredIdx + 1)]
        warnings.push(`[affinity] 主机 ${host} 上次由策略 ${preferred} 成功抓取，本次已将其提至链首优先尝试`)
      }
    }
  }

  let lastStatus = 0
  let lastNote = ''
  let lastRetryAfterMs: number | null = null
  let sawChallenge = false

  // 站点级代理池（规则可配多个逗号分隔）：每次 fetchPage 调用轮换一个出口，
  // 失效代理由后续请求自然绕过（免费公共代理单点易失效的多出口容错）
  const proxyPool = opts.proxy ? opts.proxy.split(',').map((p) => p.trim()).filter(Boolean) : []
  const pickProxy = (): string | null =>
    proxyPool.length === 0 ? null : (proxyPool[proxyCursor++ % proxyPool.length] ?? null)

  for (let si = 0; si < order.length; si++) {
    const strat = order[si]
    if (Date.now() > deadline - 1500) {
      attempts.push({ strategy: strat.name, ok: false, status: 0, ms: 0, note: 'budget-exhausted（整体时间预算耗尽，停止尝试后续策略）' })
      break
    }
    const available = await strat.probe().catch(() => false)
    if (!available) {
      attempts.push({ strategy: strat.name, ok: false, status: 0, ms: 0, note: 'unavailable（探测失败，跳过）' })
      continue
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (deadline - Date.now() < 1500) {
        attempts.push({ strategy: strat.name, ok: false, status: 0, ms: 0, note: 'budget-exhausted（整体时间预算耗尽）' })
        break
      }
      // 限速排队可能耗时较长（同主机并发任务时可达数秒）：剩余预算必须在排队之后
      // 重新计算，否则 effTimeout/硬闸会按排队前的旧值放行，55s 链预算被穿透
      //（Task 24-a 修复：旧实现在 acquireDomainSlot 之前取 remaining）
      await acquireDomainSlot(host)
      const remaining = deadline - Date.now()
      if (remaining < 1500) {
        attempts.push({ strategy: strat.name, ok: false, status: 0, ms: 0, note: 'budget-exhausted（限速排队后预算耗尽）' })
        break
      }
      const effTimeout = Math.min(timeoutMs, Math.max(1000, remaining - 500))
      const s0 = Date.now()
      let res: AttemptResult
      try {
        // 硬闸（Task 23-a 深审）：任何策略都不得挂死整条链。底层库自身超时可能失效
        // （实测 got-scraping http2 + TLS 握手停滞时 timeout 选项不触发），此处以
        // 「链剩余预算 + 2.5s 余量」为硬上限强制放行，超时按普通失败继续后续策略。
        let hardTimer: ReturnType<typeof setTimeout> | undefined
        // 硬闸余量 2.5s（Task 24-a 由 5s 收紧）：保证链尾最坏结束时刻 ≤ 预算+2.5s ≤ 57.5s，
        // 始终早于消费方 engine-client 的 60s 中断（旧值 5s 在预算 55s 时正好与 60s 相撞）
        res = await Promise.race([
          strat.run(url, effTimeout, [], { referer: opts.referer ?? null, proxy: pickProxy(), insecureTLS: opts.insecureTLS === true }),
          new Promise<AttemptResult>((resolve) => {
            hardTimer = setTimeout(
              () =>
                resolve({
                  ok: false, status: 0, bytes: new Uint8Array(0), contentType: '',
                  warnings: [`策略超过硬性时间闸（${Math.round((remaining + 2500) / 1000)}s），已强制跳过（底层库超时失效保护）`],
                  note: 'hard-timeout',
                }),
              remaining + 2500,
            )
          }),
        ]).finally(() => clearTimeout(hardTimer))
      } catch (e) {
        res = {
          ok: false, status: 0, bytes: new Uint8Array(0), contentType: '',
          warnings: [`策略内部异常: ${e instanceof Error ? e.message : String(e)}`],
          note: 'internal-error',
        }
      }
      const ms = Date.now() - s0

      // 子尝试摊平进 attempts（每次真实网络请求一条记录），无子尝试时记录策略级条目
      if (res.subAttempts && res.subAttempts.length > 0) {
        for (const sub of res.subAttempts) {
          attempts.push({
            strategy: strat.name, profile: sub.profile, ok: sub.ok, status: sub.status,
            ms: sub.ms, note: sub.note, blocked: sub.blocked, bytes: sub.bytes,
          })
          if (sub.blocked) sawChallenge = true
        }
      } else {
        attempts.push({ strategy: strat.name, ok: res.ok, status: res.status, ms, note: res.note })
      }
      for (const w of res.warnings) if (!warnings.includes(w)) warnings.push(`[${strat.name}] ${w}`)

      // 主机健康度记忆：本链内被 429/503 → 记一次限流退避（Retry-After 优先）
      if (res.status === 429 || res.status === 503) noteRateLimited(host, res.retryAfterMs ?? null)

      if (res.ok) {
        recordStrategySuccess(host, strat.name)
        noteChainSuccess(host)
        const dec = decodeHtml(res.bytes, {
          headerCharset: charsetFromContentType(res.contentType),
          forcedCharset: opts.forcedCharset ?? null,
        })
        warnings.push(...dec.warnings.map((w) => `[charset] ${w}`))
        return {
          ok: true,
          html: dec.text,
          encoding: dec.encoding,
          strategy: strat.name,
          status: res.status,
          warnings,
          attempts,
          robots: { checked: robots.checked, disallowed: robots.disallowed, crawlDelayMs: robots.crawlDelayMs },
          elapsedMs: Date.now() - t0,
        }
      }

      lastStatus = res.status
      lastNote = res.note ?? ''
      lastRetryAfterMs = res.retryAfterMs ?? null
      if (lastNote === 'challenge-page') sawChallenge = true
      // selfRetrying 策略内部已有多画像/多协议重试梯子，外层不再重复重试
      if (!strat.selfRetrying && isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
        const delay = backoffDelay(attempt)
        warnings.push(`[${strat.name}] 第 ${attempt} 次尝试失败（${res.status === 0 ? '网络错误' : `HTTP ${res.status}`}），${delay}ms 后重试`)
        await sleep(delay)
        continue
      }
      break
    }

    // 策略间退避：429/5xx/网络错误 → 进入下一策略前显式指数退避+jitter。
    // 站点通过 Retry-After 头明确要求退避时长时优先采用（同样受预算约束）。
    // 剩余预算 <3s 时不再退避（宁可靠限速器自身 1.2s 间隔，也不突破 55s 硬上限）；
    // 最后一个策略后无需退避。
    if (si < order.length - 1 && isRetryableStatus(lastStatus)) {
      const remaining = deadline - Date.now()
      if (remaining > 3000) {
        const cap = remaining - 2500
        let delay = Math.min(backoffDelay(lastStatus === 429 ? 2 : 1), cap)
        if (lastStatus === 429 && lastRetryAfterMs !== null && lastRetryAfterMs > 0) {
          delay = Math.min(Math.max(delay, lastRetryAfterMs), cap)
          const w = `HTTP 429 已按站点 Retry-After=${(lastRetryAfterMs / 1000).toFixed(1)}s 退避（受整体预算约束，实际上限 ${(cap / 1000).toFixed(1)}s）`
          if (!warnings.includes(w)) warnings.push(`[chain] ${w}`)
        } else if (lastStatus === 429) {
          const w = 'HTTP 429 目标站限流，已按指数退避+jitter 等待后继续后续策略'
          if (!warnings.includes(w)) warnings.push(`[chain] ${w}`)
        } else if (lastStatus >= 500) {
          const w = `HTTP ${lastStatus} 目标站服务器错误，已按指数退避+jitter 等待后继续后续策略`
          if (!warnings.includes(w)) warnings.push(`[chain] ${w}`)
        }
        await sleep(Math.max(0, delay))
      }
    }
  }

  // 整链失败 → 记一次连败（达熔断阈值后后续请求快速失败，见 host-health.ts）
  noteChainFailure(host)

  return {
    ok: false,
    html: '',
    encoding: '',
    strategy: opts.requestedStrategy ?? '',
    status: lastStatus,
    warnings,
    attempts,
    robots: { checked: robots.checked, disallowed: robots.disallowed, crawlDelayMs: robots.crawlDelayMs },
    elapsedMs: Date.now() - t0,
    error: '全部可用策略均抓取失败',
    detail:
      (attempts.map((a) => `${a.strategy}${a.profile ? `/${a.profile}` : ''}: ${a.note ?? (a.blocked ? 'challenge-page' : `HTTP ${a.status}`)}`).join('; ') ||
        '无可用策略（所有策略探测失败）') + (lastNote ? `，最后备注: ${lastNote}` : '') + (sawChallenge ? '；检测到疑似挑战页，目标站可能有反爬防护' : ''),
  }
}
