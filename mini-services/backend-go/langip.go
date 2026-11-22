/**
 * langip.go —— R160 前台访客语种判定（用户指令：加入根据 ip 判断前台显示什么语种）。
 *
 * 判定链（优先级降序，全部收敛于 webLangOfRequest 单入口）：
 *   1. ?lang= 白名单参数（测试/预览通道，不落 cookie——临时覆盖不清除访客既有偏好）
 *   2. cookie jxzw-lang（访客首次 geo 判定成功后写回；后续请求零查询零判定）
 *   3. IP 地理判定（公网 IP → ip-api.com countryCode → 语种映射；结果终身缓存 +
 *      磁盘持久 db/ip-lang.json——重启不丢，访客一生一次上游查询）
 *   4. Accept-Language 头（IP 不可用时的浏览器语言偏好兜底；私网/回环访问天然落此）
 *   5. 默认 zh-CN
 *
 * 语种映射（geoip countryCode → 渲染语种）：
 *   TW/HK/MO → zh-Hant（OpenCC 即时语种，translatewarm 全量预热缓存命中秒回）
 *   CN/SG/MY → zh-CN（简体原文，零转换）
 *   JP → ja；KR/KP → ko；其余 → en（LLM 语种按需+优雅降级，见 webi18n.go）
 * zh-HK 参数/cookie 输入统一归并 zh-Hant 渲染（OpenCC s2t/s2hk 差异「裏/里」级，
 * 渲染单语种避免 LRU 分裂；缓存键与预热 zh-Hant 对齐）。
 *
 * 成本与安全边界：
 *   - geo 上游查询互斥串行化（天然限速，契合 ip-api 免费档 45 req/min 语义；
 *     终身缓存保证每 IP 一生最多一次上游查询）
 *   - 失败负缓存 5min（上游抖动不逐 IP 重试打；沙箱实测 ip-api 间歇超时，
 *     负缓存期内回落 Accept-Language 兜底，5min 后自动重判）；私网/回环 IP 不出网查询
 *   - 上游超时 2.5s（geo 判定在渲染路径同步执行——首访新 IP 最多付 2.5s，
 *     不得为 geo 阻塞页面更久；成功结果终身缓存后零成本）
 *   - ip-api 免费档为 HTTP 端点（非 HTTPS），查询内容仅为 IP 与国家码（无隐私字段）
 *   - 磁盘持久 db/ip-lang.json（与 lane-highwater.json 同域持久哲学：/tmp 沙箱周期清空，
 *     db/ 与数据库同域）；条目上限 8000，超限删最旧
 *   - 开关：SiteSetting.geoLang（admin 可关，幂等加列）+ env GEO_LANG_OFF=1 强制关停；
 *     关停时判定链整体旁路恒 zh-CN（param/cookie 亦不生效——诚实单一语义）
 *   - R163 起 geoLang 布尔总闸由 SiteSetting.langMode 三态模式取代（唯一权威，geoLang
 *     列保留作数据考古）：auto=判定链全开【默认】/ off=恒 zh-CN（原 geoLang=0 语义）/
 *     force:zh-CN|zh-Hant|en|ja|ko=强制语种（判定链整体旁路，?lang=/cookie 亦不覆盖——
 *     admin 指定该站恒定语种的「强制」单一诚实语义，IP 查询零成本跳过）；
 *     SiteSite.langMode 站群站点级同名列（''=跟随默认站点，resolveSite 继承解析）
 *
 * cookie 写回（webLangOfRequest 内 geo 命中路径）：Set-Cookie jxzw-lang，Max-Age 180 天、
 * SameSite=Lax、Path=/——仅 http.ResponseWriter 可用时写入（httptest 无 w 的单测路径安全）。
 */
package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// webLangCookie 访客语种 cookie 名（geo 判定成功后写回）
const webLangCookie = "jxzw-lang"

// webLangSupported 判定链白名单（与 translateTargets 对齐；zh-HK 输入归并 zh-Hant）
var webLangSupported = map[string]bool{"zh-CN": true, "zh-Hant": true, "zh-HK": true, "en": true, "ja": true, "ko": true}

// webLangHTMLAttr 渲染语种 → <html lang> BCP47 值
var webLangHTMLAttr = map[string]string{
	"zh-CN": "zh-CN", "zh-Hant": "zh-Hant", "en": "en", "ja": "ja", "ko": "ko",
}

// webLangCountry 映射表：国家码 → 渲染语种
var webLangCountry = map[string]string{
	"TW": "zh-Hant", "HK": "zh-Hant", "MO": "zh-Hant",
	"CN": "zh-CN", "SG": "zh-CN", "MY": "zh-CN",
	"JP": "ja",
	"KR": "ko", "KP": "ko",
}

// webLangNormalize 白名单归一：zh-HK → zh-Hant；未知值返回空串
func webLangNormalize(lang string) string {
	if lang == "zh-HK" {
		return "zh-Hant"
	}
	if webLangSupported[lang] {
		return lang
	}
	return ""
}

// webLangGeoDisabled geo 功能总闸（env 强制关停：沙箱测试/部署级开关）
var webLangGeoDisabled = os.Getenv("GEO_LANG_OFF") == "1"

// ---------- IP 地理查询（缓存 + 持久化） ----------

// ipLangEntry 单条 IP 判定结果（lang 空串 = 负缓存：上游失败，30min 内不重查）
type ipLangEntry struct {
	Lang    string `json:"lang"`
	Country string `json:"country,omitempty"`
	TS      int64  `json:"ts"`
}

var (
	ipLangMu          sync.Mutex
	ipLangCache       map[string]ipLangEntry // map[ip]entry（含负缓存条目）
	ipLangLoaded      bool
	ipLangPersistPath = func() string {
		if p := os.Getenv("IP_LANG_CACHE_PATH"); p != "" {
			return p
		}
		return filepath.Join(repoRoot(), "db", "ip-lang.json")
	}()
	// ipLangNegTTL 负缓存有效期（上游抖动快回落——沙箱实测 ip-api 间歇 3s+ 超时，
	// 30min 会把单次抖动钉死成 30min 错误语种）；ipLangMaxIPs 条目上限（超限删最旧）
	ipLangNegTTL  = int64(5 * 60 * 1000)
	ipLangMaxIPs  = 8000
	ipGeoQueryMu  sync.Mutex                                       // 上游查询串行化（天然限速）
	ipGeoClient   = &http.Client{Timeout: 2500 * time.Millisecond} // 渲染路径同步调用：短超时优先，超时回落 AL 兜底
	ipGeoLastFail = int64(0)                                       // 上游级失败时间戳（全局 30s 冷却：连续失败不逐 IP 重试）
)

// ipLangLoad 启动恢复（首次使用时懒加载，读失败静默=空缓存重建）
func ipLangLoad() {
	ipLangLoaded = true
	raw, err := os.ReadFile(ipLangPersistPath)
	if err != nil {
		return
	}
	var m map[string]ipLangEntry
	if err := json.Unmarshal(raw, &m); err != nil || len(m) == 0 {
		return
	}
	ipLangCache = m
}

// ipLangPersist 落盘（调用方持锁；写失败仅记日志——缓存语义下次重判无害）
func ipLangPersist() {
	_ = os.MkdirAll(filepath.Dir(ipLangPersistPath), 0o755)
	raw, err := json.Marshal(ipLangCache)
	if err != nil {
		return
	}
	tmp := ipLangPersistPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		log.Printf("[langip] ip-lang.json 落盘失败: %v", err)
		return
	}
	if err := os.Rename(tmp, ipLangPersistPath); err != nil {
		log.Printf("[langip] ip-lang.json 原子替换失败: %v", err)
	}
}

// ipLangLookup IP → (渲染语种, 国家码, 判定成功)。缓存命中零上游；公网 miss 出网查。
// 负缓存条目返回 ("", "", false)——调用方继续 Accept-Language 兜底。
func ipLangLookup(ip string) (string, string, bool) {
	if ip == "" || isPrivateOrLoopbackIP(ip) {
		return "", "", false
	}
	ipLangMu.Lock()
	defer ipLangMu.Unlock()
	if !ipLangLoaded {
		ipLangLoad()
	}
	if e, ok := ipLangCache[ip]; ok {
		if e.Lang != "" {
			return e.Lang, e.Country, true
		}
		if nowMillis()-e.TS < ipLangNegTTL {
			return "", "", false // 负缓存有效期内不重查
		}
	}
	// 上游级 30s 冷却：一次失败后短窗内所有新 IP 直接负缓存（防上游抖动逐 IP 重试打爆）
	if nowMillis()-ipGeoLastFail < 30*1000 {
		ipLangRemember(ip, "", "", false)
		return "", "", false
	}
	lang, country, ok := ipGeoQuery(ip)
	ipLangRemember(ip, lang, country, ok)
	return lang, country, ok
}

// ipLangRemember 写缓存 + 条目上限修剪 + 落盘（调用方持锁）
func ipLangRemember(ip, lang, country string, ok bool) {
	if ok && ipGeoLastFail != 0 {
		ipGeoLastFail = 0
	}
	if !ok {
		ipGeoLastFail = nowMillis()
	}
	if ipLangCache == nil {
		ipLangCache = map[string]ipLangEntry{}
	}
	ipLangCache[ip] = ipLangEntry{Lang: lang, Country: country, TS: nowMillis()}
	if len(ipLangCache) > ipLangMaxIPs {
		type kv struct {
			k  string
			ts int64
		}
		items := make([]kv, 0, len(ipLangCache))
		for k, v := range ipLangCache {
			items = append(items, kv{k, v.TS})
		}
		sort.Slice(items, func(i, j int) bool { return items[i].ts < items[j].ts })
		for i := 0; i < len(items)-ipLangMaxIPs+100; i++ { // 超限剪到 -100 余量，防逐条触顶
			delete(ipLangCache, items[i].k)
		}
	}
	ipLangPersist()
}

// ipGeoQuery ip-api.com 免费端点查询（互斥串行化；失败静默返回 ok=false）
func ipGeoQuery(ip string) (string, string, bool) {
	ipGeoQueryMu.Lock()
	defer ipGeoQueryMu.Unlock()
	url := "http://ip-api.com/json/" + ip + "?fields=status,countryCode"
	resp, err := ipGeoClient.Get(url)
	if err != nil {
		return "", "", false
	}
	defer func() { _ = resp.Body.Close() }()
	var out struct {
		Status      string `json:"status"`
		CountryCode string `json:"countryCode"`
	}
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&out); err != nil || out.Status != "success" {
		return "", "", false
	}
	lang := webLangCountry[out.CountryCode]
	if lang == "" {
		lang = "en"
	}
	return lang, out.CountryCode, true
}

// isPrivateOrLoopbackIP 私网/回环/链路本地/未解析地址判定（这些 IP 不出网做地理查询）
func isPrivateOrLoopbackIP(ip string) bool {
	p := net.ParseIP(strings.TrimSpace(ip))
	if p == nil {
		return true
	}
	if p.IsLoopback() || p.IsPrivate() || p.IsLinkLocalUnicast() || p.IsLinkLocalMulticast() || p.IsUnspecified() {
		return true
	}
	return false
}

// webClientIP 提取客户端公网 IP：X-Forwarded-For 从左到右第一个非私网地址
// （Caddy 网关链形态 client,proxy1,proxy2——左起第一个公网即真实访客；全私网回落
// X-Real-IP → RemoteAddr）。与 translateClientIP（取首段、无私网甄别）并行独立，
// 语种判定对伪造 XFF 的代价仅一次 ip-api 查询与错误语种渲染，无安全面。
func webClientIP(r *http.Request) string {
	if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
		for _, seg := range strings.Split(xf, ",") {
			s := strings.TrimSpace(seg)
			if s != "" && !isPrivateOrLoopbackIP(s) {
				return s
			}
		}
	}
	if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" && !isPrivateOrLoopbackIP(xr) {
		return xr
	}
	ip := strings.TrimSpace(r.RemoteAddr)
	if i := strings.LastIndex(ip, ":"); i > 0 && !strings.Contains(ip, "]") {
		ip = ip[:i]
	}
	return strings.Trim(ip, "[]")
}

// ---------- Accept-Language 兜底 ----------

// webLangFromAcceptHeader 解析 Accept-Language：q 值降序取首个白名单命中标签。
// 泛中文 zh（无地区）→ zh-CN；zh-TW/zh-HK/zh-Hant/zh-MO → zh-Hant；zh-SG → zh-CN。
func webLangFromAcceptHeader(header string) string {
	type seg struct {
		tag string
		q   float64
	}
	parts := strings.Split(header, ",")
	list := make([]seg, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		q := 1.0
		if i := strings.Index(p, ";q="); i >= 0 {
			tag := strings.TrimSpace(p[:i])
			if v, err := strconv.ParseFloat(strings.TrimSpace(p[i+3:]), 64); err == nil {
				q = v
			}
			p = tag
		}
		if p == "*" {
			continue
		}
		list = append(list, seg{strings.ToLower(p), q})
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].q > list[j].q })
	for _, s := range list {
		switch {
		case s.tag == "zh" || s.tag == "zh-cn" || s.tag == "zh-sg" || strings.HasPrefix(s.tag, "zh-hans"):
			return "zh-CN"
		case strings.HasPrefix(s.tag, "zh-tw") || strings.HasPrefix(s.tag, "zh-hk") ||
			strings.HasPrefix(s.tag, "zh-mo") || strings.HasPrefix(s.tag, "zh-hant"):
			return "zh-Hant"
		case strings.HasPrefix(s.tag, "ja"):
			return "ja"
		case strings.HasPrefix(s.tag, "ko"):
			return "ko"
		case strings.HasPrefix(s.tag, "en"):
			return "en"
		}
	}
	return ""
}

// ---------- 判定主入口 ----------

// webLangModeForce 强制语种模式表（R163：langMode 值 → 渲染语种；键存在即合法模式）
var webLangModeForce = map[string]string{
	"force:zh-CN":   "zh-CN",
	"force:zh-Hant": "zh-Hant",
	"force:en":      "en",
	"force:ja":      "ja",
	"force:ko":      "ko",
}

// webLangModeNorm langMode 白名单归一：auto/off/force:* 原样返回，非法值返回空串
// （API 清洗与渲染判定共用同一白名单——写入侧宽松忽略、读取侧兜底 auto，双端一致）
func webLangModeNorm(m string) string {
	m = strings.TrimSpace(m)
	if m == "auto" || m == "off" {
		return m
	}
	if _, ok := webLangModeForce[m]; ok {
		return m
	}
	return ""
}

// webLangModeOf 站点生效语种模式（R163）：langMode 白名单归一，空/非法值兜底 auto
// （R160 geoLang=1 语义延续——列加列失败/历史脏值/降级路径一律回落自动判定，
// 绝不因存储层故障把全站锁死在错误语种）。SiteSite ” 继承已由 resolveSite 完成。
func webLangModeOf(s *webSettings) string {
	if s != nil {
		if m := webLangModeNorm(s.LangMode); m != "" {
			return m
		}
	}
	return "auto"
}

// webLangModeEcho langMode 回显归一（R163）：空/非法值 → auto（admin GET /api/settings
// 与 <option> selected 落空防线；与 webLangModeOf 区别：不承载 nil 语义，纯字符串归一）
func webLangModeEcho(m string) string {
	if v := webLangModeNorm(m); v != "" {
		return v
	}
	return "auto"
}

// webLangOfRequest 前台渲染语种判定（handler 装配层与 renderPage 共用；幂等低成本：
// geo 命中走终身缓存，cookie 命中零查询）。cookieWriter 非 nil 且 geo 判定成功时写回
// 偏好 cookie（param/AL/默认来源不写——只有 geo 是「访客地区事实」，值得持久化）。
//
// R163 模式分流（resolveSite 已完成站群 Host 匹配与 ” 继承，此处理解为「生效模式」）：
//
//	off          → 判定链整体旁路恒 zh-CN（原 R160 geoLang=0 语义，param/cookie 亦不生效）
//	force:<lang> → 强制语种，判定链整体旁路（?lang=/cookie 亦不覆盖——「强制」单一诚实
//	               语义；cookieWriter 不写 cookie，IP 查询零成本跳过）
//	auto         → 下方五级判定链（R160 原样）
func webLangOfRequest(r *http.Request, cookieWriter http.ResponseWriter) string {
	if webLangGeoDisabled {
		return "zh-CN"
	}
	// R163: 语种模式（SiteSetting.langMode 默认站点 / SiteSite.langMode 站群站点）
	switch mode := webLangModeOf(resolveSite(r)); {
	case mode == "off":
		return "zh-CN"
	case webLangModeForce[mode] != "":
		return webLangModeForce[mode]
	}
	// 1. ?lang= 参数（测试/预览通道；白名单外静默忽略）
	if q := r.URL.Query().Get("lang"); q != "" {
		if lang := webLangNormalize(strings.TrimSpace(q)); lang != "" {
			return lang
		}
	}
	// 2. cookie 偏好（geo 首判后持久化）
	if c, err := r.Cookie(webLangCookie); err == nil {
		if lang := webLangNormalize(strings.TrimSpace(c.Value)); lang != "" {
			return lang
		}
	}
	// 3. IP 地理判定（公网 IP；成功写回 cookie）
	ip := webClientIP(r)
	if lang, _, ok := ipLangLookup(ip); ok {
		if cookieWriter != nil {
			http.SetCookie(cookieWriter, &http.Cookie{
				Name: webLangCookie, Value: lang, Path: "/",
				MaxAge: 180 * 24 * 3600, SameSite: http.SameSiteLaxMode,
			})
		}
		return lang
	}
	// 4. Accept-Language 浏览器偏好兜底（私网/负缓存/上游失败路径）
	if lang := webLangFromAcceptHeader(r.Header.Get("Accept-Language")); lang != "" {
		return lang
	}
	// 5. 默认简体中文原文
	return "zh-CN"
}

// webLangAttrOf 渲染语种 → <html lang> 值（未知语种回落 zh-CN）
func webLangAttrOf(lang string) string {
	if v, ok := webLangHTMLAttr[lang]; ok {
		return v
	}
	return "zh-CN"
}
