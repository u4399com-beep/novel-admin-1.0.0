/**
 * got-scraping 策略：header-generator 生成真实浏览器头 + HTTP/2，失败自动降级 HTTP/1.1；
 * followRedirect:false 重定向逐跳 SSRF 校验；依赖未安装则 probe 失败优雅跳过。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移）
 */
import { acquireDomainSlot, assertHostPublic, parseRetryAfterMs } from '../rate-limit'
import { cookieHeaderFor, recordHeaderCookies } from './cookies'
import { assess, hostOf, MAX_BYTES, MAX_REDIRECT_HOPS } from './http'
import type { StrategyDef, SubAttempt } from './types'

/**
 * 站点级出口代理（规则配置）→ got 的 agent 选项：
 * http(s) 代理用 hpagent，socks5(h) 用 socks-proxy-agent；依赖缺失时返回 undefined（直连）。
 */
async function proxyAgentFor(proxy: string | null | undefined): Promise<Record<string, unknown> | undefined> {
  if (!proxy) return undefined
  const targetHttpsAgentKey = 'https'
  try {
    if (proxy.startsWith('socks5h://') || proxy.startsWith('socks5://') || proxy.startsWith('socks4://')) {
      const { SocksProxyAgent } = await import('socks-proxy-agent' as string)
      const agent = new SocksProxyAgent(proxy)
      return { http: agent, https: agent }
    }
    const { HttpsProxyAgent, HttpProxyAgent } = await import('hpagent' as string)
    const httpsAgent = new HttpsProxyAgent({ proxy })
    const httpAgent = new HttpProxyAgent({ proxy })
    return { http: httpAgent, [targetHttpsAgentKey]: httpsAgent }
  } catch {
    return undefined
  }
}

type GotScrapingFn = (options: Record<string, unknown>) => Promise<{
  statusCode: number
  body: Uint8Array
  url?: string
  headers: Record<string, string | string[] | undefined>
}>

let gotFnPromise: Promise<GotScrapingFn | null> | null = null

function loadGotScraping(): Promise<GotScrapingFn | null> {
  if (!gotFnPromise) {
    gotFnPromise = (async () => {
      const mod: unknown = await import('got-scraping' as string)
      const m = mod as { gotScraping?: GotScrapingFn; default?: { gotScraping?: GotScrapingFn } }
      const fn = m?.gotScraping ?? m?.default?.gotScraping
      return typeof fn === 'function' ? fn : null
    })().catch(() => null)
  }
  return gotFnPromise
}

export const gotScrapingStrategy: StrategyDef = {
  name: 'got-scraping',
  description:
    'got-scraping（header-generator 生成真实浏览器头）HTTP/2 失败自动降级 HTTP/1.1，对抗请求头/协议指纹拦截；依赖未安装则不可用',
  probe: () => loadGotScraping().then((f) => f !== null),
  selfRetrying: true,
  async run(url, timeoutMs, warnings, ctx) {
    const gotScraping = await loadGotScraping()
    if (!gotScraping) {
      return { ok: false, status: 0, bytes: new Uint8Array(0), contentType: '', warnings: ['got-scraping 模块不可用'], note: 'module-missing' }
    }
    const explicitReferer = ctx?.referer ?? null
    const proxyAgent = await proxyAgentFor(ctx?.proxy)
    if (ctx?.proxy && !proxyAgent) {
      warnings.push('[got-scraping] 代理 agent 依赖缺失（hpagent/socks-proxy-agent），本策略降级直连')
    }
    // 自签/裸 IP 站点（规则 insecureTLS）：got 的 https.tls.rejectUnauthorized 选项跳过证书校验
    const tlsOpts = ctx?.insecureTLS ? { https: { rejectUnauthorized: false } } : {}
    const subAttempts: SubAttempt[] = []
    const deadline = Date.now() + timeoutMs
    let lastRetryAfterMs: number | null = null
    // 最后一次真实 HTTP 状态码（Task 24-a 修复：旧实现聚合结果恒返 status:0，
    // 导致策略链的 429/5xx 退避与 Retry-After 尊重逻辑对 got-scraping 永远不生效）
    let lastHttpStatus = 0

    // 子尝试梯子：HTTP/2 → HTTP/1.1（协议指纹差异）
    const variants: Array<{ profile: string; http2: boolean }> = [
      { profile: 'h2', http2: true },
      { profile: 'http1.1', http2: false },
    ]

    /** 单跳请求：followRedirect:false —— 重定向在本策略内逐跳处理，每一跳都做 SSRF 校验
     *  （旧实现 followRedirect:true 由 got 内部跟随，仅事后校验最终 URL，中间跳可被诱导对内网发起 GET）。
     *  每跳按目标 host 回放引擎 cookie 会话；Referer 优先用调用方显式来路，缺省用目标站首页 */
    const requestOnce = (target: string, http2: boolean, leftMs: number) => {
      const https = target.startsWith('https:')
      const cookie = cookieHeaderFor(hostOf(target), https)
      return gotScraping({
        url: target,
        method: 'GET',
        responseType: 'buffer',
        http2,
        followRedirect: false,
        retry: { limit: 0 }, // 重试由本服务统一编排，避免双重重试
        timeout: { request: leftMs },
        ...(proxyAgent ? { agent: proxyAgent } : {}),
        ...tlsOpts,
        // 硬闸（Task 23-a 深审实测）：got 的 timeout 选项在 http2 + TLS 握手停滞时不触发
        // （/books.toscrape 复现：h2 请求无限挂起、无 http2 时 0.5s 即抛 ERR_SSL_NO_CIPHER_MATCH）。
        // AbortSignal 真正中断底层 socket，杜绝策略被单个请求永久卡死。
        signal: AbortSignal.timeout(Math.max(1000, leftMs)),
        headers: {
          referer: explicitReferer ?? `${new URL(url).origin}/`,
          ...(cookie ? { cookie } : {}),
        },
        context: {
          headerGeneratorOptions: {
            browsers: [{ name: 'chrome' }, { name: 'edge' }],
            devices: ['desktop'],
            locale: 'zh-CN',
          },
        },
      })
    }

    const headerValue = (headers: Record<string, string | string[] | undefined> | undefined, key: string): string | null => {
      const v = headers?.[key]
      if (v === undefined) return null
      return Array.isArray(v) ? v[0] ?? null : v
    }

    const noteAttempt = (profile: string, ok: boolean, status: number, ms: number, blocked: boolean, size: number, note?: string) => {
      subAttempts.push({ profile, ok, status, ms, blocked, bytes: size, note })
    }

    for (const variant of variants) {
      let current = url
      let hops = 0
      let stopVariants = false
      for (;;) {
        await acquireDomainSlot(hostOf(current)) // 每一跳（跨域后是不同域名）都受限速约束
        const s0 = Date.now()
        const remaining = deadline - Date.now()
        if (remaining < 1000) {
          noteAttempt(variant.profile, false, 0, 0, false, 0, 'timeout-budget')
          break
        }
        try {
          const res = await requestOnce(current, variant.http2, remaining)
          const status = res.statusCode
          const hopHttps = current.startsWith('https:')

          // 3xx：解析 Location → 协议白名单 + 逐跳 SSRF 校验 → 限速后请求下一跳
          if ([301, 302, 303, 307, 308].includes(status)) {
            recordHeaderCookies(hostOf(current), res.headers, hopHttps) // 中间跳下发的 Set-Cookie 也要入会话
            const loc = headerValue(res.headers, 'location')
            if (!loc) {
              noteAttempt(variant.profile, false, status, Date.now() - s0, false, 0, 'redirect-no-location')
              break
            }
            let next: URL
            try {
              next = new URL(loc, current)
            } catch {
              noteAttempt(variant.profile, false, status, Date.now() - s0, false, 0, 'redirect-bad-location')
              warnings.push(`got-scraping 非法 Location 头: ${loc.slice(0, 200)}`)
              break
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
              noteAttempt(variant.profile, false, status, Date.now() - s0, false, 0, 'ssrf-blocked')
              warnings.push(`SSRF 防护: 重定向到非 http/https 协议已拒绝: ${next.protocol}`)
              break
            }
            const check = await assertHostPublic(next.hostname)
            if (!check.ok) {
              noteAttempt(variant.profile, false, status, Date.now() - s0, false, 0, 'ssrf-blocked')
              warnings.push(`SSRF 防护: 重定向终点 ${check.reason}`)
              break
            }
            hops++
            if (hops > MAX_REDIRECT_HOPS) {
              noteAttempt(variant.profile, false, status, Date.now() - s0, false, 0, 'too-many-redirects')
              warnings.push(`got-scraping 重定向超过 ${MAX_REDIRECT_HOPS} 跳，已停止`)
              break
            }
            current = next.toString()
            continue
          }

          const bytes = new Uint8Array(res.body ?? new Uint8Array(0))
          const contentType = String(Array.isArray(res.headers['content-type']) ? res.headers['content-type'][0] : res.headers['content-type'] ?? '')
          recordHeaderCookies(hostOf(current), res.headers, hopHttps)
          if (bytes.byteLength > MAX_BYTES) {
            lastHttpStatus = status
            noteAttempt(variant.profile, false, status, Date.now() - s0, false, bytes.byteLength, 'too-large')
            warnings.push(`got-scraping 响应超过 ${MAX_BYTES}B 上限，已放弃`)
            stopVariants = true
            break
          }
          const a = assess(status, bytes, contentType)
          noteAttempt(variant.profile, a.ok, status, Date.now() - s0, a.blocked, a.size, a.note)
          if (a.warning) warnings.push(`[${variant.profile}] ${a.warning}`)
          if (status >= 400) warnings.push(`got-scraping 收到 HTTP ${status}`)
          // got-scraping 默认 throwHttpErrors:false（429/5xx 不抛错、走本正常路径）：
          // Retry-After 尊重与状态传播都必须在这里处理（Task 24-a 实测修正）
          if (status === 429 || status === 503) {
            const ra = parseRetryAfterMs(headerValue(res.headers, 'retry-after'))
            if (ra !== null) lastRetryAfterMs = ra
          }
          if (a.ok) {
            return { ok: true, status, bytes, contentType, warnings, subAttempts, retryAfterMs: null }
          }
          lastHttpStatus = status
          // HTTP 状态码失败（含 429/5xx）直接结束梯子：换协议不会改变服务端决策，
          // 对限流中的站点立刻追加降级请求只会加重刺激；退避由策略链统一编排
          //（Task 24-a 修复：旧实现对 429/5xx 继续降级 http1.1 多打一发）
          if (status >= 400) stopVariants = true
          break
        } catch (rawErr) {
          const e = rawErr as (Error & { response?: { statusCode: number; body?: Uint8Array; headers?: Record<string, string | string[] | undefined> }; code?: string }) | null
          if (e?.response) {
            const status = e.response.statusCode
            const hopHttps = current.startsWith('https:')
            lastHttpStatus = status
            recordHeaderCookies(hostOf(current), e.response.headers, hopHttps) // 429/5xx 错误页也可能种 cookie
            if (status === 429 || status === 503) {
              const ra = parseRetryAfterMs(headerValue(e.response.headers, 'retry-after'))
              if (ra !== null) lastRetryAfterMs = ra
            }
            const bytes = new Uint8Array(e.response.body ?? new Uint8Array(0))
            if (bytes.byteLength > MAX_BYTES) {
              noteAttempt(variant.profile, false, status, Date.now() - s0, false, bytes.byteLength, 'too-large')
              warnings.push(`got-scraping 响应超过 ${MAX_BYTES}B 上限，已放弃`)
              break
            }
            const contentType = headerValue(e.response.headers, 'content-type') ?? ''
            const a = assess(status, bytes, contentType)
            noteAttempt(variant.profile, false, status, Date.now() - s0, a.blocked, a.size, a.note ?? `http-${status}`)
            warnings.push(`got-scraping 收到 HTTP ${status}（got 对非 2xx 抛错，已转为结构化失败）`)
            if (a.warning) warnings.push(`[${variant.profile}] ${a.warning}`)
            // HTTP 状态码失败（含 429/5xx）直接结束梯子：换协议不会改变服务端决策，
            // 对限流中的站点立刻追加降级请求只会加重刺激；退避由策略链统一编排
            //（Task 24-a 修复：旧实现仅对非可重试状态停梯子，429/5xx 反而多打一发 http1.1）
            stopVariants = true
          } else {
            noteAttempt(variant.profile, false, 0, Date.now() - s0, false, 0, e?.code ?? 'network-error')
            warnings.push(`got-scraping 网络错误（${variant.profile}）: ${e?.code ?? e?.message ?? 'unknown'}`)
          }
          break
        }
      }
      if (stopVariants) break
    }
    return { ok: false, status: lastHttpStatus, bytes: new Uint8Array(0), contentType: '', warnings, note: 'all-variants-failed', subAttempts, retryAfterMs: lastRetryAfterMs }
  },
}
