/**
 * 请求头画像（逐行移植自 strategies/profiles.ts）：UA 派生 + 各浏览器/爬虫画像构造。
 *
 * UA 与 Sec-CH-UA 版本严格一致（同一常量派生），Chrome 主版本进程启动时随机化避免固定指纹；
 * Referer 链以目标站自身首页为来源模拟站内导航。
 *
 * 已知 Go 运行时差异：net/http 按字典序发送请求头，TS 版 humanizeHeaderOrder 的
 * 「非核心头顺序随机抖动」在 Go 版退化为固定序（UA 仍按进程随机版本派生）；curl-impersonate
 * 策略不受影响（其头序由二进制精确复刻）。
 */
package main

import (
	"math/rand"
	"net/url"
)

// headerProfile 单个请求头画像：id 用于 attempts 明细展示，withReferer 决定是否覆盖 Referer 变体
type headerProfile struct {
	id          string
	label       string
	withReferer bool
	headers     func(targetURL string, withReferer bool, explicitReferer string) map[string]string
}

// chromeMajor 进程启动时从近期版本集随机挑选一次，UA 与 Sec-CH-UA 全部由它派生
var chromeMajor = func() int {
	candidates := []int{124, 125, 126, 127, 128, 129, 130, 131, 132, 133}
	return candidates[rand.Intn(len(candidates))]
}()

var (
	chromeUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
		itoa(chromeMajor) + ".0.0.0 Safari/537.36"
	chromeSecCHUA = `"Chromium";v="` + itoa(chromeMajor) + `", "Google Chrome";v="` + itoa(chromeMajor) + `", "Not-A.Brand";v="99"`
	edgeUA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
		itoa(chromeMajor) + ".0.0.0 Safari/537.36 Edg/" + itoa(chromeMajor) + ".0.0.0"
	edgeSecCHUA = `"Chromium";v="` + itoa(chromeMajor) + `", "Microsoft Edge";v="` + itoa(chromeMajor) + `", "Not-A.Brand";v="99"`
)

const acceptHTML = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7"
const acceptLangZH = "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7"

// baseHeaders 公共头构造；withReferer 时优先显式来路，缺省以目标站自身首页为来源
func baseHeaders(targetURL string, withReferer bool, ua string, extra map[string]string, explicitReferer string) map[string]string {
	h := map[string]string{
		"user-agent":               ua,
		"accept":                   acceptHTML,
		"accept-language":          acceptLangZH,
		"upgrade-insecure-requests": "1",
	}
	for k, v := range extra {
		h[k] = v
	}
	if withReferer {
		// Referer 链：优先使用调用方显式提供的来路（如书页 URL），
		// 未提供时以目标站自身首页为来源，模拟从站内导航进入
		ref := explicitReferer
		if ref == "" {
			if u, err := url.Parse(targetURL); err == nil && u.Host != "" {
				ref = u.Scheme + "://" + u.Host + "/"
			}
		}
		if ref != "" {
			h["referer"] = ref
		}
	}
	return h
}

// a) Chrome 桌面：全套 Sec-Fetch-* + 客户端提示
var chromeDesktopProfile = headerProfile{
	id:          "chrome-desktop",
	label:       "Chrome 桌面（完整 Sec-Fetch/客户端提示 + Referer）",
	withReferer: true,
	headers: func(u string, withReferer bool, explicitReferer string) map[string]string {
		return baseHeaders(u, withReferer, chromeUA, map[string]string{
			"cache-control":         "no-cache",
			"pragma":                "no-cache",
			"sec-ch-ua":             chromeSecCHUA,
			"sec-ch-ua-mobile":      "?0",
			"sec-ch-ua-platform":    `"Linux"`,
			"sec-fetch-dest":        "document",
			"sec-fetch-mode":        "navigate",
			"sec-fetch-site":        "same-origin",
			"sec-fetch-user":        "?1",
		}, explicitReferer)
	},
}

// b) Firefox 桌面：不发客户端提示，保留 Sec-Fetch
var firefoxDesktopProfile = headerProfile{
	id:          "firefox-desktop",
	label:       "Firefox 桌面（无客户端提示 + Referer）",
	withReferer: true,
	headers: func(u string, withReferer bool, explicitReferer string) map[string]string {
		return baseHeaders(u, withReferer,
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
			map[string]string{
				"sec-fetch-dest":  "document",
				"sec-fetch-mode":  "navigate",
				"sec-fetch-site":  "same-origin",
				"sec-fetch-user":  "?1",
				"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
			}, explicitReferer)
	},
}

// b) Safari 桌面（无 Referer 变体）
var safariDesktopProfile = headerProfile{
	id:          "safari-desktop",
	label:       "Safari 桌面（无客户端提示、无 Referer）",
	withReferer: false,
	headers: func(u string, withReferer bool, explicitReferer string) map[string]string {
		return baseHeaders(u, withReferer,
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
			map[string]string{
				"sec-fetch-dest": "document",
				"sec-fetch-mode": "navigate",
				"sec-fetch-site": "none",
			}, explicitReferer)
	},
}

// b) Edge 桌面
var edgeDesktopProfile = headerProfile{
	id:          "edge-desktop",
	label:       "Edge 桌面（Chromium 内核 + Edge 品牌 + Referer）",
	withReferer: true,
	headers: func(u string, withReferer bool, explicitReferer string) map[string]string {
		return baseHeaders(u, withReferer, edgeUA, map[string]string{
			"sec-ch-ua":          edgeSecCHUA,
			"sec-ch-ua-mobile":   "?0",
			"sec-ch-ua-platform": `"Windows"`,
			"sec-fetch-dest":     "document",
			"sec-fetch-mode":     "navigate",
			"sec-fetch-site":     "same-origin",
			"sec-fetch-user":     "?1",
		}, explicitReferer)
	},
}

// d) Android Chrome 移动端
var androidChromeProfile = headerProfile{
	id:          "android-chrome",
	label:       "Android Chrome 移动端（sec-ch-ua-mobile=?1 + Referer）",
	withReferer: true,
	headers: func(u string, withReferer bool, explicitReferer string) map[string]string {
		return baseHeaders(u, withReferer,
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"+
				itoa(chromeMajor)+".0.0.0 Mobile Safari/537.36",
			map[string]string{
				"sec-ch-ua":          chromeSecCHUA,
				"sec-ch-ua-mobile":   "?1",
				"sec-ch-ua-platform": `"Android"`,
				"sec-fetch-dest":     "document",
				"sec-fetch-mode":     "navigate",
				"sec-fetch-site":     "same-origin",
				"sec-fetch-user":     "?1",
			}, explicitReferer)
	},
}

// d) iPhone Safari 移动端（无客户端提示、无 Referer）
var iphoneSafariProfile = headerProfile{
	id:          "iphone-safari",
	label:       "iPhone Safari 移动端（无 Referer）",
	withReferer: false,
	headers: func(u string, withReferer bool, explicitReferer string) map[string]string {
		return baseHeaders(u, withReferer,
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
			map[string]string{
				"sec-fetch-dest": "document",
				"sec-fetch-mode": "navigate",
				"sec-fetch-site": "none",
			}, explicitReferer)
	},
}

// c) Googlebot 降级：真实 Googlebot 不发送 Upgrade-Insecure-Requests / Accept-Language，
// 但会发送标识身份的 From 头（蜘蛛 UA + 浏览器专属头是可检测矛盾）
var googlebotProfile = headerProfile{
	id:          "googlebot",
	label:       "Googlebot 桌面降级（无 Referer）",
	withReferer: false,
	headers: func(u string, withReferer bool, explicitReferer string) map[string]string {
		h := baseHeaders(u, withReferer,
			"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/"+
				itoa(chromeMajor)+".0.0.0 Safari/537.36",
			map[string]string{}, explicitReferer)
		h["accept"] = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
		delete(h, "upgrade-insecure-requests")
		delete(h, "accept-language")
		h["from"] = "googlebot(at)googlebot.com"
		return h
	},
}

// c) Baiduspider 降级：真实 Baiduspider 仅发送极简头（UA/Accept/Accept-Encoding）
var baiduspiderProfile = headerProfile{
	id:          "baiduspider",
	label:       "Baiduspider 降级（无 Referer）",
	withReferer: false,
	headers: func(u string, withReferer bool, explicitReferer string) map[string]string {
		h := baseHeaders(u, withReferer,
			"Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
			map[string]string{}, explicitReferer)
		h["accept"] = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
		delete(h, "upgrade-insecure-requests")
		delete(h, "accept-language")
		return h
	},
}
