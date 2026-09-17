/**
 * 请求头画像（Header Profiles）：UA 派生 + 各浏览器/爬虫画像构造。
 *
 * UA 与 Sec-CH-UA 版本严格一致（同一常量派生），Chrome 主版本进程启动时随机化
 * 避免固定指纹；Referer 链以目标站自身首页为来源模拟站内导航。
 * （自 strategies.ts 巨石拆分而来，代码逐行原样迁移）
 */
/** 单个请求头画像：id 用于 attempts 明细展示，referer 决定是否覆盖「带 Referer」变体 */
export interface HeaderProfile {
  id: string
  label: string
  /** 是否携带 Referer（覆盖"带 Referer/无 Referer"变体） */
  referer: boolean
  headers(url: string, withReferer: boolean, explicitReferer?: string | null): Record<string, string>
}

/**
 * Chrome 主版本：进程启动时从近期版本集随机挑选一次，UA 与 Sec-CH-UA 全部由它派生，
 * 保证两者永远一致（修复「UA 与客户端提示版本不一致」这类可被站点检测的矛盾），
 * 同时避免所有部署实例共用同一固定版本号形成指纹。进程内保持稳定以保证画像自洽。
 */
export const CHROME_MAJOR = (() => {
  const candidates = [124, 125, 126, 127, 128, 129, 130, 131, 132, 133]
  return candidates[Math.floor(Math.random() * candidates.length)] ?? 124
})()

export const CHROME_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`
export const CHROME_SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not-A.Brand";v="99"`
export const EDGE_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROME_MAJOR}.0.0.0`
export const EDGE_SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Microsoft Edge";v="${CHROME_MAJOR}", "Not-A.Brand";v="99"`

const ACCEPT_HTML =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
const ACCEPT_LANG_ZH = 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'

function baseHeaders(url: string, withReferer: boolean, ua: string, extra: Record<string, string>, explicitReferer?: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': ua,
    accept: ACCEPT_HTML,
    'accept-language': ACCEPT_LANG_ZH,
    'upgrade-insecure-requests': '1',
    ...extra,
  }
  if (withReferer) {
    // Referer 链：优先使用调用方显式提供的来路（如书页 URL，书页→章节页的站内导航校验场景），
    // 未提供时以目标站自身首页为来源，模拟从站内导航进入
    h.referer = explicitReferer || `${new URL(url).origin}/`
  }
  return h
}

/** a) Chrome 桌面：全套 Sec-Fetch-* + 客户端提示 */
export const chromeDesktopProfile: HeaderProfile = {
  id: 'chrome-desktop',
  label: 'Chrome 桌面（完整 Sec-Fetch/客户端提示 + Referer）',
  referer: true,
  headers(url, withReferer, explicitReferer) {
    return baseHeaders(
      url,
      withReferer,
      CHROME_UA,
      {
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'sec-ch-ua': CHROME_SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
      },
      explicitReferer,
    )
  },
}

/** b) Firefox 桌面：不发客户端提示，保留 Sec-Fetch */
export const firefoxDesktopProfile: HeaderProfile = {
  id: 'firefox-desktop',
  label: 'Firefox 桌面（无客户端提示 + Referer）',
  referer: true,
  headers(url, withReferer, explicitReferer) {
    return baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
      {
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      explicitReferer,
    )
  },
}

/** b) Safari 桌面（无 Referer 变体） */
export const safariDesktopProfile: HeaderProfile = {
  id: 'safari-desktop',
  label: 'Safari 桌面（无客户端提示、无 Referer）',
  referer: false,
  headers(url, withReferer, explicitReferer) {
    return baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      {
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      },
      explicitReferer,
    )
  },
}

/** b) Edge 桌面 */
export const edgeDesktopProfile: HeaderProfile = {
  id: 'edge-desktop',
  label: 'Edge 桌面（Chromium 内核 + Edge 品牌 + Referer）',
  referer: true,
  headers(url, withReferer, explicitReferer) {
    return baseHeaders(
      url,
      withReferer,
      EDGE_UA,
      {
        'sec-ch-ua': EDGE_SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
      },
      explicitReferer,
    )
  },
}

/** d) Android Chrome 移动端 */
export const androidChromeProfile: HeaderProfile = {
  id: 'android-chrome',
  label: 'Android Chrome 移动端（sec-ch-ua-mobile=?1 + Referer）',
  referer: true,
  headers(url, withReferer, explicitReferer) {
    return baseHeaders(
      url,
      withReferer,
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Mobile Safari/537.36`,
      {
        'sec-ch-ua': CHROME_SEC_CH_UA,
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
      },
      explicitReferer,
    )
  },
}

/** d) iPhone Safari 移动端（无客户端提示、无 Referer） */
export const iphoneSafariProfile: HeaderProfile = {
  id: 'iphone-safari',
  label: 'iPhone Safari 移动端（无 Referer）',
  referer: false,
  headers(url, withReferer, explicitReferer) {
    return baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      {
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      },
      explicitReferer,
    )
  },
}

/** c) Googlebot 降级 */
export const googlebotProfile: HeaderProfile = {
  id: 'googlebot',
  label: 'Googlebot 桌面降级（无 Referer）',
  referer: false,
  headers(url, withReferer, explicitReferer) {
    const h = baseHeaders(
      url,
      withReferer,
      `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
      {},
      explicitReferer,
    )
    h.accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    // 指纹一致性修正：真实 Googlebot 不发送 Upgrade-Insecure-Requests / Accept-Language
    // （蜘蛛 UA + 浏览器专属头是可检测矛盾），但会发送标识身份的 From 头
    delete h['upgrade-insecure-requests']
    delete h['accept-language']
    h.from = 'googlebot(at)googlebot.com'
    return h
  },
}

/** c) Baiduspider 降级 */
export const baiduspiderProfile: HeaderProfile = {
  id: 'baiduspider',
  label: 'Baiduspider 降级（无 Referer）',
  referer: false,
  headers(url, withReferer, explicitReferer) {
    const h = baseHeaders(
      url,
      withReferer,
      'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
      {},
      explicitReferer,
    )
    h.accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
    // 指纹一致性修正：真实 Baiduspider 仅发送极简头（UA/Accept/Accept-Encoding），
    // 去掉浏览器专属的 Upgrade-Insecure-Requests 与 Accept-Language，避免矛盾指纹
    delete h['upgrade-insecure-requests']
    delete h['accept-language']
    return h
  },
}
