package main

// jscookie.go —— JS 计算 cookie 型挑战的本地求解（R141）。
//
// 背景（ixdzs8.com 实测，葬神渊 20 章根因）：书页首次访问返回 571B 挑战页
//
//      <script>(function(){...var t=(882654).toString(36)+"_"+(1583867302136).toString(36);
//      document.cookie="__cn_v="+t+"; expires="+d.toUTCString()+"; path=/; SameSite=Lax";
//      if(document.cookie.indexOf("__cn_v=")!==-1){location.reload();}...})();</script>
//
// 真实浏览器执行 JS 得 __cn_v cookie 后 reload 放行；引擎 HTTP 层无 JS 执行能力，
// 挑战页被判失败跳到下一策略。更隐蔽的形态：**代理出口 IP 信誉好时书页 200 直接放行
// 但不带 Set-Cookie**（__cn_v 只在挑战页 JS 里种）——书页成功、会话桶空，紧随的同源
// AJAX 端点（POST /novel/clist/ 完整目录）被 WAF 强制校验 __cn_v → 403 → 目录退化为
// 书页内嵌前 20 条（全部 ixdzs8 书 20 章的来源）。
//
// 求解器：白名单表达式求值（**绝不 eval/执行任意 JS**）——只认
//   - 字符串字面量（'…' / "…"）
//   - (数字).toString(基数)（基数 2-36）
//   - 标识符（从 var <id>=<expr>; 赋值表取值，递归限深 3）
//   - '+' 拼接
// 遇到未知形态（成员访问/函数调用/关键字）：已有累积值则截断返回（属性段 "…; path=/"
// 正是此形态），否则失败。挑战值如服务端校验严格（IP/UA 绑定）时 cookie 无效——
// 失败语义与旧版一致（挑战页仍按失败处理），零回归风险。

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// jsCookieBodyCap 挑战页扫描上限（挑战壳远小于此；防超长页无谓扫描）。
const jsCookieBodyCap = 64 * 1024

// reDocCookie document.cookie="name"+expr 语句（expr 非贪婪到首个 ';'——属性段前必有
// 字符串边界，"+" 拼接链内不含裸分号；截断风险由求值器截断语义兜底）。
var reDocCookie = regexp.MustCompile(`document\.cookie\s*=\s*(?:"([^"]+)"|'([^']+)')\s*\+\s*(.+?);`)

// reVarAssign var <id>=<expr>; 赋值（expr 到首个 ';'；含字符串分号的赋值会被截断——
// 对挑战值表达式（纯计算形态）无影响）。
var reVarAssign = regexp.MustCompile(`(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);`)

// reNumToString (数字).toString(基数)（前导括号容忍空白）。
var reNumToString = regexp.MustCompile(`\(\s*(\d+)\s*\)\s*\.\s*toString\s*\(\s*(\d+)\s*\)`)

// solveJSCookieChallenge 从挑战页 HTML 求解 cookie。返回 "name=value" 行（可直接喂
// recordSetCookieLines）与是否求解成功。
func solveJSCookieChallenge(body []byte) (string, bool) {
	if len(body) == 0 {
		return "", false
	}
	src := string(body)
	if len(src) > jsCookieBodyCap {
		src = src[:jsCookieBodyCap]
	}
	if !strings.Contains(src, "document.cookie") {
		return "", false
	}
	m := reDocCookie.FindStringSubmatchIndex(src)
	if m == nil {
		return "", false
	}
	// 双引号/单引号两分支互斥：未参与分支的捕获组下标为 -1（直接切片会 panic [:-1]）
	name := ""
	if m[2] >= 0 && m[3] >= 0 {
		name = src[m[2]:m[3]]
	} else if m[4] >= 0 && m[5] >= 0 {
		name = src[m[4]:m[5]]
	}
	// JS 惯例 document.cookie="name="+value：等号在字符串字面量内（"__cn_v=" 形态），
	// 剥掉尾部等号还原纯 name；无等号形态（name 直接是标识符字符串）不受影响
	name = strings.TrimSuffix(name, "=")
	if name == "" {
		return "", false
	}
	expr := src[m[6]:m[7]]

	vars := collectJSVarAssignments(src)
	val, ok := evalJSExpr(expr, vars, 0)
	if !ok || val == "" {
		return "", false
	}
	return name + "=" + val, true
}

// collectJSVarAssignments 预扫 var/let/const 赋值并逐条求值（失败条目跳过——
// new Date()/函数调用等非求值形态不入表）。
func collectJSVarAssignments(src string) map[string]string {
	vars := map[string]string{}
	for _, loc := range reVarAssign.FindAllStringSubmatchIndex(src, -1) {
		id := src[loc[2]:loc[3]]
		expr := src[loc[4]:loc[5]]
		if v, ok := evalJSExpr(expr, vars, 0); ok && v != "" {
			vars[id] = v
		}
	}
	return vars
}

// evalJSExpr 白名单求值：字符串/toString(radix)/标识符查表/'+' 拼接。
// 截断语义：未知 token 时若 acc 非空返回 acc（cookie 值段已完整，后续是属性串），
// 否则失败。depth 限递归防环（当前实现非递归求值，参数留作演进位）。
func evalJSExpr(expr string, vars map[string]string, depth int) (string, bool) {
	_ = depth
	var acc strings.Builder
	i := 0
	for i < len(expr) {
		ch := expr[i]
		switch {
		case ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n':
			i++
		case ch == '+':
			i++
		case ch == '"' || ch == '\'':
			end := strings.IndexByte(expr[i+1:], ch)
			if end < 0 {
				return acc.String(), acc.Len() > 0
			}
			seg := expr[i+1 : i+1+end]
			// 属性段（"; expires=" / '; path=/'）以分号开头：cookie 值到此为止
			if strings.HasPrefix(seg, ";") {
				return acc.String(), acc.Len() > 0
			}
			acc.WriteString(seg)
			i += end + 2
		case ch == '(':
			m := reNumToString.FindStringSubmatch(expr[i:])
			if m == nil {
				return acc.String(), acc.Len() > 0
			}
			n, nerr := strconv.ParseInt(m[1], 10, 64)
			radix, rerr := strconv.Atoi(m[2])
			if nerr != nil || rerr != nil || radix < 2 || radix > 36 {
				return "", false
			}
			acc.WriteString(itoaRadix(n, radix))
			i += len(m[0])
		case isJSIdentStart(ch):
			j := i + 1
			for j < len(expr) && isJSIdentChar(expr[j]) {
				j++
			}
			id := expr[i:j]
			i = j
			if i < len(expr) && (expr[i] == '.' || expr[i] == '(') {
				// 标识符后跟成员访问/调用（d.toUTCString 等）：非纯值形态，截断
				return acc.String(), acc.Len() > 0
			}
			v, ok := vars[id]
			if !ok {
				return acc.String(), acc.Len() > 0
			}
			acc.WriteString(v)
		default:
			// 数字字面量（无括号形态 882654.toString? 罕见）与其余：截断或失败
			return acc.String(), acc.Len() > 0
		}
	}
	return acc.String(), acc.Len() > 0
}

// itoaRadix 进制转字符串（2-36，负数取绝对值——挑战值均为非负）。
func itoaRadix(n int64, radix int) string {
	if n < 0 {
		n = -n
	}
	if n == 0 {
		return "0"
	}
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	var b [70]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = digits[n%int64(radix)]
		n /= int64(radix)
	}
	return string(b[i:])
}

func isJSIdentStart(ch byte) bool {
	return ch == '_' || ch == '$' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
}

func isJSIdentChar(ch byte) bool {
	return isJSIdentStart(ch) || (ch >= '0' && ch <= '9')
}

// cookieProbeOnce 每 host 一次的探测闸（进程级）：clist 403 兜底探测成本高（额外
// 书页请求+域槽），同一 host 挑战形态固定，一次不成后续任务也不必再试。
var cookieProbeOnce sync.Map

// cookieChallengeProbe R141：JSON 目录端点 403 兜底——GET 书页两路收益：
//  1. 书页响应的 Set-Cookie 直接入 jar（部分站点会话 cookie 由任意页种下）；
//  2. 响应体若为 JS 计算 cookie 型挑战页，solveJSCookieChallenge 本地求解种 jar。
//
// 返回 jar 是否发生变化（true 时调用方可安全重放被 403 的请求）。
// 请求经 tocFetchImpersonate（JA3 伪装）——书页在策略链可能由 got/curlimp 车道胜出，
// 其响应 Set-Cookie 已回存；本探测补「书页 200 但 jar 无挑战 cookie」的残留场景。
func cookieChallengeProbe(baseURL string, warnings *[]string) bool {
	h := hostOf(baseURL)
	if _, loaded := cookieProbeOnce.LoadOrStore(h, struct{}{}); loaded {
		return false
	}
	tu, perr := urlParse(baseURL)
	if perr != nil || tu == nil || (tu.Scheme != "http" && tu.Scheme != "https") {
		return false
	}
	https := tu.Scheme == "https"
	req, rerr := http.NewRequest("GET", baseURL, nil)
	if rerr != nil {
		return false
	}
	req.Header.Set("User-Agent", chromeUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", acceptLangZH)
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	if ck := cookieHeaderFor(h, https); ck != "" {
		req.Header.Set("Cookie", ck)
	}
	var body []byte
	var status int
	var setCookies []string
	if ib, istatus, isc, ierr := tocFetchImpersonate(req, 15_000); ierr == nil {
		body, status, setCookies = ib, istatus, isc
	} else if ierr != errNoTransport {
		*warnings = append(*warnings, "cookie-challenge 探测：伪装传输失败（"+truncateStr(ierr.Error(), 100)+"）")
		return false
	} else {
		// errNoTransport：Go 原生回退（与 jsontoc/jscontent 双通道同口径）
		res, derr := tocHTTPClient.Do(req)
		if derr != nil {
			return false
		}
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != 200 {
			return false
		}
		setCookies = res.Header.Values("Set-Cookie")
		src, decodeClose, derr2 := contentDecodedReader(res)
		if derr2 != nil {
			return false
		}
		body, _ = readAllCapped(src, jsCookieBodyCap)
		decodeClose()
		status = res.StatusCode
	}
	if status != 200 || len(body) == 0 {
		return false
	}
	if len(setCookies) > 0 {
		recordSetCookieLines(h, setCookies, https)
	}
	if ckline, solved := solveJSCookieChallenge(body); solved {
		recordSetCookieLines(h, []string{ckline}, https)
		preview := ckline
		if len(preview) > 30 {
			preview = preview[:30] + "..."
		}
		*warnings = append(*warnings, "cookie-challenge 探测：书页挑战已求解（"+preview+"），重放原请求")
		return true
	}
	// 无挑战页：Set-Cookie 是否新种了放行 cookie 未知——探测后重放一次无害（幂等 GET），
	// 有 Set-Cookie 时值得重放；无 Set-Cookie 时重放大概率仍 403，但每 host 仅一次成本。
	return len(setCookies) > 0
}
