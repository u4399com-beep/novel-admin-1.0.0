/**
 * fetch 系策略工厂（a/b/c/d/e 组能力）：同一执行骨架 × 不同请求头画像梯子。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移）
 */
import { acquireDomainSlot } from '../rate-limit'
import { assess, fetchWithRedirectGuard, hostOf } from './http'
import {
  androidChromeProfile,
  baiduspiderProfile,
  chromeDesktopProfile,
  edgeDesktopProfile,
  firefoxDesktopProfile,
  googlebotProfile,
  iphoneSafariProfile,
  safariDesktopProfile,
} from './profiles'
import type { HeaderProfile } from './profiles'
import type { AttemptResult, StrategyDef, SubAttempt } from './types'

function makeFetchStrategy(cfg: { name: string; description: string; profiles: HeaderProfile[] }): StrategyDef {
  return {
    name: cfg.name,
    description: cfg.description,
    probe: async () => typeof fetch === 'function',
    selfRetrying: true, // 内部画像梯子即是重试路径，外层不再重复重试
    async run(url, timeoutMs, warnings) {
      const subAttempts: SubAttempt[] = []
      const deadline = Date.now() + timeoutMs
      let last: AttemptResult | null = null

      for (const profile of cfg.profiles) {
        await acquireDomainSlot(hostOf(url)) // 每个画像的请求同样受域名限速约束
        // 限速等待可能耗时 >1s：剩余预算必须在等待之后计算，否则超时会穿透策略 deadline（旧实现先算后等）
        const remaining = deadline - Date.now()
        if (remaining < 1000) {
          subAttempts.push({ profile: profile.id, ok: false, status: 0, ms: 0, blocked: false, bytes: 0, note: 'timeout-budget' })
          break
        }
        const s0 = Date.now()
        const r = await fetchWithRedirectGuard(url, profile.headers(url, profile.referer), remaining, warnings)
        const a = assess(r.status, r.bytes, r.contentType)
        const ms = Date.now() - s0
        subAttempts.push({ profile: profile.id, ok: a.ok, status: r.status, ms, blocked: a.blocked, bytes: a.size, note: r.note ?? a.note })
        if (r.warning || a.warning) warnings.push(`[${profile.id}] ${r.warning ?? a.warning}`)

        if (a.ok) {
          return { ok: true, status: r.status, bytes: r.bytes, contentType: r.contentType, warnings, subAttempts, retryAfterMs: r.retryAfterMs ?? null }
        }
        last = { ok: false, status: r.status, bytes: r.bytes, contentType: r.contentType, warnings, note: r.note ?? a.note, subAttempts, retryAfterMs: r.retryAfterMs ?? null }
      }
      return (
        last ?? {
          ok: false,
          status: 0,
          bytes: new Uint8Array(0),
          contentType: '',
          warnings,
          note: 'no-profile-attempted',
          subAttempts,
        }
      )
    },
  }
}

export const fetchBrowserStrategy = makeFetchStrategy({
  name: 'fetch-browser',
  description: '原生 fetch + 完整 Chrome 桌面请求头（UA/Accept/Accept-Language/Referer 链/Sec-Fetch 族/客户端提示），最快最稳的默认策略',
  profiles: [chromeDesktopProfile],
})

export const fetchUaRotateStrategy = makeFetchStrategy({
  name: 'fetch-ua-rotate',
  description: 'UA 轮换：Firefox → Safari（无 Referer 变体）→ Edge 桌面画像，对抗 UA 白名单类拦截',
  profiles: [firefoxDesktopProfile, safariDesktopProfile, edgeDesktopProfile],
})

export const fetchMobileStrategy = makeFetchStrategy({
  name: 'fetch-mobile',
  description: '移动端画像：Android Chrome（带 Referer）→ iPhone Safari（无 Referer），部分站点仅放行移动端 UA',
  profiles: [androidChromeProfile, iphoneSafariProfile],
})

export const fetchSpiderStrategy = makeFetchStrategy({
  name: 'fetch-spider',
  description: '搜索引擎 spider UA 降级：Googlebot → Baiduspider（仅采集公开内容，不伪造登录态/不破解验证码）',
  profiles: [googlebotProfile, baiduspiderProfile],
})
