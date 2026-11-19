package main

// jscontent.go —— chapterRule.chapterContentApi：章节正文 JSON API 提取（R141）。
//
// 背景（书海阁 book.washai.net 实测）：现代 CMS 的正文不放 HTML 章节页，改由同源 AJAX
// 端点下发（POST/GET 返回 JSON，contentHtml 字段携带正文 HTML 片段）。此类站点的 HTML
// 章节页根本没有正文（select .con 命中空壳），chapterRule 的 contentSelector 形同虚设。
// 本文件把「正文来自 JSON API」从 Legado 书源的能力域补齐到引擎规则域：
//
//      "chapterContentApi": {
//        "url": "/book/queryReadPage?bookId={bookId}&bookIndexId={chapterId}&contentFormat=html",
//        "method": "GET",                       // 缺省 GET；POST 时 body 支持 {bookId}/{chapterId} 槽
//        "bookIdRE": "/book/(\\d+)/",           // 从章节页 URL 提取 {bookId}（第一捕获组）
//        "chapterIdRE": "(\\d+)\\.html",        // 从章节页 URL 提取 {chapterId}（第一捕获组）
//        "contentFields": ["data.contentHtml", "data.content"], // 点路径备选（首个非空命中）
//        "titleFields": ["data.bookIndex.name"],                // 可选：标题点路径备选
//        "tokenHeaders": [{"header": "X-Browser-Token", "cookie": "novel_browser_token"}]
//      }                                        // cookie→header 桥：会话 jar 里的 cookie 值进请求头
//
// 请求形态与 chapterListApi（jsontoc.go）同源同姿态：SSRF 同源校验（仅同协议同主机）、
// 引擎 cookie 会话回放（书页种下的 novel_browser_token 是放行条件）、curl-impersonate
// JA3 伪装传输优先（CF 系对 Go TLS 指纹 AJAX 恒 403，washai 实测：普通 curl 403 无
// token，curl_chrome116 任意页 200 且 Set-Cookie 种 token）+ Go 原生回退。
// 命中时 handler 直接返回 ChapterData（章节页 HTML 不再请求——此类站点章节页无正文，
// 请求它只是浪费一次域限速额度）；API 失败回退既有 HTML 路径（降级语义不变）。

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// contentApiMaxBytes 正文 JSON 响应上限：与 maxTocBytes 同量级（正文 HTML 片段 +
// bookIndex 元数据；真实章节正文极少超过 1MB，8MB 上界防异常站点拖爆内存）。
const contentApiMaxBytes = 8 * 1024 * 1024

// contentApiSlotBudget 正文 API 请求预算（ms）：与 tocSlotDefaultMS 同档。
// washai 实测热缓存 ~3s / 冷请求 8-20s，预算内排队+请求；不足由调用方 shed。
const contentApiSlotBudget = 20_000

// tokenBridge cookie→header 桥（washai 的 X-Browser-Token 来自会话 jar 的 novel_browser_token）。
type tokenBridge struct {
	header string
	cookie string
}

// chapterContentApiConfig chapterRule.chapterContentApi 配置（规则 JSON 字符串解析产物）。
type chapterContentApiConfig struct {
	url           string
	method        string
	body          string
	bookIdRE      string
	chapterIdRE   string
	contentFields []string
	titleFields   []string
	tokenHeaders  []tokenBridge
}

// parseChapterContentApi 解析并校验 chapterContentApi 配置。
// 必填：url / bookIdRE / chapterIdRE / contentFields（≥1）。
func parseChapterContentApi(raw string) (chapterContentApiConfig, string) {
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return chapterContentApiConfig{}, "chapterContentApi JSON 解析失败：" + err.Error()
	}
	s := func(k string) string { v, _ := m[k].(string); return strings.TrimSpace(v) }

	urlT := s("url")
	if urlT == "" {
		return chapterContentApiConfig{}, "chapterContentApi 缺少必填字段（url）"
	}
	if !strings.Contains(urlT, "{bookId}") && !strings.Contains(urlT, "{chapterId}") {
		return chapterContentApiConfig{}, "chapterContentApi.url 缺少 {bookId}/{chapterId} 占位符"
	}
	bookRE := s("bookIdRE")
	chapRE := s("chapterIdRE")
	if bookRE == "" || chapRE == "" {
		return chapterContentApiConfig{}, "chapterContentApi 缺少必填字段（bookIdRE/chapterIdRE——{bookId}/{chapterId} 的 URL 提取来源）"
	}
	// 正则先行编译校验（规则加载即暴露坏 pattern，不等到逐章提取时静默失败）
	if _, err := regexp.Compile(bookRE); err != nil {
		return chapterContentApiConfig{}, "chapterContentApi.bookIdRE 编译失败：" + err.Error()
	}
	if _, err := regexp.Compile(chapRE); err != nil {
		return chapterContentApiConfig{}, "chapterContentApi.chapterIdRE 编译失败：" + err.Error()
	}

	// contentFields：["a","b"] 数组形态（主）；兼容 "a" 单字符串形态（省心）
	var contentFields []string
	switch cv := m["contentFields"].(type) {
	case []any:
		for _, x := range cv {
			if sv, ok := x.(string); ok && strings.TrimSpace(sv) != "" {
				contentFields = append(contentFields, strings.TrimSpace(sv))
			}
		}
	case string:
		if strings.TrimSpace(cv) != "" {
			contentFields = []string{strings.TrimSpace(cv)}
		}
	}
	if len(contentFields) == 0 {
		return chapterContentApiConfig{}, "chapterContentApi 缺少必填字段（contentFields≥1——正文点路径）"
	}

	var titleFields []string
	switch tv := m["titleFields"].(type) {
	case []any:
		for _, x := range tv {
			if sv, ok := x.(string); ok && strings.TrimSpace(sv) != "" {
				titleFields = append(titleFields, strings.TrimSpace(sv))
			}
		}
	case string:
		if strings.TrimSpace(tv) != "" {
			titleFields = []string{strings.TrimSpace(tv)}
		}
	}

	var bridges []tokenBridge
	if arr, ok := m["tokenHeaders"].([]any); ok {
		for _, x := range arr {
			bm, ok := x.(map[string]any)
			if !ok {
				continue
			}
			h, _ := bm["header"].(string)
			c, _ := bm["cookie"].(string)
			if strings.TrimSpace(h) != "" && strings.TrimSpace(c) != "" {
				bridges = append(bridges, tokenBridge{header: strings.TrimSpace(h), cookie: strings.TrimSpace(c)})
			}
		}
	}

	method := strings.ToUpper(s("method"))
	if method != "POST" {
		method = "GET"
	}
	return chapterContentApiConfig{
		url: urlT, method: method, body: s("body"),
		bookIdRE: bookRE, chapterIdRE: chapRE,
		contentFields: contentFields, titleFields: titleFields,
		tokenHeaders: bridges,
	}, ""
}

// firstGroup 按 pattern 第一捕获组从章节 URL 提取 ID（复用 bookIdFromURL 语义，命名区分意图）。
func firstGroupFromURL(u, pattern string) string { return bookIdFromURL(u, pattern) }

// extractChapterViaAPI 章节正文 JSON API 提取主入口。
// chapterURL 是任务编排层给出的章节页 URL（此类站点仅作 ID 载体，不再请求其 HTML）。
// 返回 ok=false 时调用方回退 HTML 路径（warnings 已携带失败原因）。
func extractChapterViaAPI(chapterURL string, cfg chapterContentApiConfig, warnings *[]string) (ChapterData, bool) {
	data := ChapterData{}

	// 1) ID 提取
	bookId := firstGroupFromURL(chapterURL, cfg.bookIdRE)
	chapterId := firstGroupFromURL(chapterURL, cfg.chapterIdRE)
	if bookId == "" || chapterId == "" {
		*warnings = append(*warnings, "chapterContentApi：章节 URL 未命中 bookIdRE/chapterIdRE（"+truncateStr(chapterURL, 120)+"）")
		return data, false
	}

	// 2) API URL 组装（相对端点以章节 URL 为基）+ 同源 SSRF 校验
	apiRef := strings.ReplaceAll(strings.ReplaceAll(cfg.url, "{bookId}", encodeURIComp(bookId)), "{chapterId}", encodeURIComp(chapterId))
	u, uerr := urlParse(urlJoinPath(apiRef, chapterURL))
	if uerr != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") {
		*warnings = append(*warnings, "chapterContentApi：API URL 无法解析或非 http(s)")
		return data, false
	}
	base, berr := url.Parse(chapterURL)
	if berr != nil || !jsonTocSameOrigin(u, base) {
		*warnings = append(*warnings, "chapterContentApi：接口 "+u.Host+" 与章节页 "+hostOf(chapterURL)+" 非同源，已拒绝（SSRF 防护）")
		return data, false
	}

	// 3) 域限速取槽（JSON 目录同口径：额外请求不豁免礼貌间隔）
	slotDeadline := nowMs() + contentApiSlotBudget
	if _, granted := acquireDomainSlotBudgeted(strings.ToLower(u.Host), slotDeadline, 0); !granted {
		*warnings = append(*warnings, "chapterContentApi：域限速排队超预算，已跳过 JSON 正文提取（引擎准入拒绝）")
		return data, false
	}

	// 4) 请求构造（头族对齐 jsontoc：chromeUA + 同源 XHR 形态 + 会话 cookie 回放 + token 桥）
	https := u.Scheme == "https"
	req, rerr := http.NewRequest(cfg.method, u.String(), nil)
	if rerr != nil {
		*warnings = append(*warnings, "chapterContentApi：请求构造失败 "+rerr.Error())
		return data, false
	}
	if cfg.method == "POST" {
		form := strings.ReplaceAll(strings.ReplaceAll(cfg.body, "{bookId}", encodeURIComp(bookId)), "{chapterId}", encodeURIComp(chapterId))
		// 与 jsontoc 同姿态：strings.NewReader 保 ContentLength（chunked POST 被 PHP/宝塔系拒收）
		req, rerr = http.NewRequest(cfg.method, u.String(), strings.NewReader(form))
		if rerr != nil {
			*warnings = append(*warnings, "chapterContentApi：请求构造失败 "+rerr.Error())
			return data, false
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	}
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	req.Header.Set("User-Agent", chromeUA)
	req.Header.Set("Accept-Language", acceptLangZH)
	req.Header.Set("Referer", chapterURL)
	req.Header.Set("Sec-Fetch-Dest", "empty")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if cfg.method == "POST" {
		req.Header.Set("Origin", base.Scheme+"://"+base.Host)
	}
	if ck := cookieHeaderFor(hostOf(u.String()), https); ck != "" {
		req.Header.Set("Cookie", ck)
		// token 桥：会话 jar cookie → 显式请求头（washai X-Browser-Token 实测必需；
		// 服务端校验的是 header 而非 cookie 本体——cookie 只作存储载体）
		for _, b := range cfg.tokenHeaders {
			if v := cookieValueFromHeader(ck, b.cookie); v != "" {
				req.Header.Set(b.header, v)
			}
		}
	}

	// 5) 发送：curl-impersonate JA3 伪装优先，Go 原生回退（jsontoc 同款双通道：
	// 二进制缺失 errNoTransport 与执行失败（超时 exit 28 等）都落原生通道重试）
	if ib, istatus, isc, ierr := tocFetchImpersonate(req, contentApiSlotBudget); ierr == errNoTransport {
		// 无伪装传输：落 Go 原生
		_ = ib
	} else if ierr == nil {
		if len(isc) > 0 {
			recordSetCookieLines(hostOf(u.String()), isc, https)
		}
		if istatus < 200 || istatus >= 300 {
			*warnings = append(*warnings, "chapterContentApi：接口返回 HTTP "+itoa(istatus))
			return data, false
		}
		return parseChapterContentBody(ib, cfg, warnings)
	} else {
		// 伪装传输执行失败（超时/断连）：告警后落 Go 原生回退（jsontoc 同口径）
		*warnings = append(*warnings, "chapterContentApi：伪装传输失败，回退原生（"+truncateStr(ierr.Error(), 120)+"）")
	}
	res, err := tocHTTPClient.Do(req)
	if err != nil {
		*warnings = append(*warnings, "chapterContentApi：接口请求失败 "+err.Error())
		return data, false
	}
	defer func() { _ = res.Body.Close() }()
	if isRedirectStatus(res.StatusCode) {
		*warnings = append(*warnings, "chapterContentApi：接口返回重定向 HTTP "+itoa(res.StatusCode)+"，已拒绝跟随（SSRF 防护）")
		return data, false
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		*warnings = append(*warnings, "chapterContentApi：接口返回 HTTP "+itoa(res.StatusCode))
		return data, false
	}
	if lines := res.Header.Values("Set-Cookie"); len(lines) > 0 {
		recordSetCookieLines(hostOf(u.String()), lines, https)
	}
	src, decodeClose, derr := contentDecodedReader(res)
	if derr != nil {
		if derr == io.EOF {
			*warnings = append(*warnings, "chapterContentApi：响应体为空")
			return data, false
		}
		*warnings = append(*warnings, "chapterContentApi：响应体解包失败 "+derr.Error())
		return data, false
	}
	body, tooLarge := readAllCapped(src, contentApiMaxBytes)
	decodeClose()
	if tooLarge || len(body) == 0 {
		*warnings = append(*warnings, "chapterContentApi：响应体为空或超限")
		return data, false
	}
	return parseChapterContentBody(body, cfg, warnings)
}

// parseChapterContentBody JSON 正文体 → ChapterData（伪装/原生两传输路径共用）。
// contentFields 首个非空命中；titleFields 同姿态（未配置/全空时 Title 留空，
// 调用方 HTML 回退路径补齐）。content 预期是 HTML 片段（washai contentHtml），
// 也接受纯文本（清洗管线按原样入库，渲染层 <p> 语义由模板统一处理）。
func parseChapterContentBody(body []byte, cfg chapterContentApiConfig, warnings *[]string) (ChapterData, bool) {
	var jsonVal any
	if jerr := json.Unmarshal(body, &jsonVal); jerr != nil {
		*warnings = append(*warnings, "chapterContentApi：JSON 解析失败 "+truncateStr(jerr.Error(), 120))
		return ChapterData{}, false
	}
	content := ""
	for _, p := range cfg.contentFields {
		if v := pickPath(jsonVal, p); v != nil {
			if sv, ok := v.(string); ok && strings.TrimSpace(sv) != "" {
				content = sv
				break
			}
		}
	}
	if strings.TrimSpace(content) == "" {
		*warnings = append(*warnings, "chapterContentApi：contentFields 全部未命中非空正文（"+strings.Join(cfg.contentFields, ", ")+"）")
		return ChapterData{}, false
	}
	title := ""
	for _, p := range cfg.titleFields {
		if v := pickPath(jsonVal, p); v != nil {
			if sv, ok := v.(string); ok && strings.TrimSpace(sv) != "" {
				title = trimJSSpace(sv)
				break
			}
		}
	}
	return ChapterData{Title: truncateStr(title, maxTitleChars), Content: content}, true
}

// cookieValueFromHeader 从 "a=b; c=d" 形态的 Cookie 头串提取指定 cookie 值。
// 引擎会话桶以字符串形式存取（cookieHeaderFor），桥接时解析该串而非另开 jar API。
func cookieValueFromHeader(header, name string) string {
	for _, part := range strings.Split(header, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		eq := strings.Index(part, "=")
		if eq <= 0 {
			continue
		}
		if strings.TrimSpace(part[:eq]) == name {
			v, _ := url.QueryUnescape(strings.TrimSpace(part[eq+1:]))
			if v == "" {
				v = strings.TrimSpace(part[eq+1:])
			}
			return v
		}
	}
	return ""
}

// urlJoinPath 相对 API 端点拼接到章节页 URL 的 origin（/book/queryReadPage →
// https://host/book/queryReadPage）；绝对端点原样返回。
func urlJoinPath(ref, baseURL string) string {
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		return ref
	}
	if u := urlJoin(ref, baseURL); u != nil {
		return u.String()
	}
	return ref
}
