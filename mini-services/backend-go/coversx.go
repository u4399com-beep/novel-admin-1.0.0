/**
 * backend-go —— 采集封面落盘：下载远程封面 → 解码规范化 → 转存 public/covers/。
 *
 * TS 源：src/lib/covers-store.ts（SSRF 校验/代理/幂等/渐变 token 逐行移植）
 *
 * 存储契约（与渲染层 novel-cover 组件约定）：
 * - Novel.cover = 渐变 token（g1-g12，无图时的确定性渐变封面）或
 *   本地封面路径（`/covers/{novelId}.jpg`，采集到远程封面后落盘）
 *
 * 【允许的图像处理降级】Go 无 sharp/webp 编码器：
 * - 解码用 image.Decode（jpeg/png/gif 注册）+ golang.org/x/image/webp（webp 仅解码）
 * - 最长边 >512 时缩小（x/image/draw CatmullRom），输出 JPEG quality 80 →
 *   存 public/covers/{id}.jpg（扩展名 .jpg 非 TS 版 .webp；前端 img 标签不敏感）
 * - 不做 EXIF 方向归正（封面图极少携带旋转元数据）
 * - 解码失败返回 ""（调用方保留渐变 token）
 *
 * 安全与健壮性（与 TS 对齐）：仅 http/https；拒绝内网/环回/链路本机地址（文本层 + DNS
 * 尽力解析，DNS 失败即拒绝）；Content-Type 校验；5MB 上限；12s 超时；幂等（目标文件
 * 已存在直接复用）；tmp+rename 原子落盘；失败一律返回 ""，绝不阻塞采集主流程。
 *
 * Task 51：fetchAndStoreCover 之上另有 fetchCoverWithFallback 多出口回退包装（本文件末）；
 * Task 51-b：tmp 创建改 os.CreateTemp（O_EXCL 绝对唯一，强化 Task 27-c 的纳秒时间戳方案）
 * + 失败路径遗留 tmp 清理（defer Remove 兜底）。
 */
package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/tls"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	LOCAL_PREFIX     = "/covers/"
	MAX_COVER_BYTES  = 5 * 1024 * 1024
	COVER_DL_TIMEOUT = 12 * time.Second
	coverUA          = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
	coverMaxSide     = 512
	// 解压炸弹防线（Task 26-d）：声明尺寸超限的图在 Decode 前直接拒绝
	// （40M 像素 ≈ RGBA 全量展开 160MB，远小于原 5MB 压缩输入的潜在放大上限）
	coverMaxPixels     = 40_000_000
	coverMaxPixelsSide = 20_000
)

var (
	coversDirOnce sync.Once
	coversDirPath string
	ipv4TextRE    = regexp.MustCompile(`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$`)
)

// coversDir 封面落盘目录：COVERS_DIR env > cwd 向上查找 public/covers > 项目根兜底。
// TS 版用 process.cwd()/public；Go 进程 cwd 不定（runner 可能从任意目录启动），故向上查找。
func coversDir() string {
	coversDirOnce.Do(func() {
		if d := os.Getenv("COVERS_DIR"); d != "" {
			coversDirPath = d
			return
		}
		var candidates []string
		if wd, err := os.Getwd(); err == nil {
			p := wd
			for i := 0; i < 5; i++ {
				candidates = append(candidates, filepath.Join(p, "public", "covers"))
				parent := filepath.Dir(p)
				if parent == p {
					break
				}
				p = parent
			}
		}
		candidates = append(candidates, "/home/z/my-project/public/covers")
		for _, d := range candidates {
			if st, err := os.Stat(d); err == nil && st.IsDir() {
				coversDirPath = d
				return
			}
		}
		coversDirPath = "/home/z/my-project/public/covers"
	})
	return coversDirPath
}

// isLocalCoverPath 判断 cover 值是否为本地封面路径（渲染层与入库层共用）
func isLocalCoverPath(cover string) bool {
	return strings.HasPrefix(cover, LOCAL_PREFIX)
}

// isPrivateIp 私有/环回/链路本机地址校验（文本层 + IP 语义双轨）。
// v4 保留文本正则判定（含十进制/八进制变体粗防）；IPv6 按真实网段语义判定
// （Task 50 修复：旧版「含冒号一律拒绝」catch-all 对 DNS 逐址校验是灾难——
// 公网站点普遍双栈（如 101kks.com 返回 v4+AAAA），LookupHost 结果含任一 v6
// 地址即整体误判私网 → 封面下载全站静默失败。现按段放行公网全球单播，
// SSRF 防线不弱化：私网段（回环/ULA/链路本地/文档段）仍全部拦截，
// coverDialControl 拨号前最后一道校验共用本函数（真实拨号 IP 逐次把关）。
func isPrivateIp(host string) bool {
	if host == "" {
		return true
	}
	h := strings.ToLower(host)
	h = strings.TrimPrefix(h, "[")
	h = strings.TrimSuffix(h, "]")
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return isPrivateIPAddr(ip)
	}
	return isPrivateIPv4Text(h)
}

// isPrivateIPv4Text 点分四段文本层判定（含越界八位组拒绝；仅接受 v4 文本形态）。
// Task 76 加固：补 224/4 组播、240/4 保留（含 255.255.255.255）、TEST-NET-2
// （198.51.100/24）、6to4 relay（192.88.99/24，2014 年已弃用）——这些段永不承载
// 公网 Web/图床，早期确定性拒绝可避免「dial 必败 → 代理回退链空烧」（与 Task 69-b
// x509 修复同理由：确定性失败不消耗回退预算）。
// ⚠ 例外契约：TEST-NET-3（203.0.113/24）**有意保留公网判定**——测试夹具依赖
// （audit51/51b/60/69 系列用它做免 DNS 短路的 URL 字面量，见 audit51_test.go 文件头），
// 不得加入本判定。
func isPrivateIPv4Text(h string) bool {
	if v4m := ipv4TextRE.FindStringSubmatch(h); v4m != nil {
		nums := [4]int{}
		for i := 0; i < 4; i++ {
			n, err := strconv.Atoi(v4m[i+1])
			if err != nil {
				return true
			}
			nums[i] = n
			if n > 255 {
				return true
			}
		}
		a, b, c, d := nums[0], nums[1], nums[2], nums[3]
		if a == 0 || a == 10 || a == 127 {
			return true
		}
		if a == 169 && b == 254 {
			return true
		}
		if a == 172 && b >= 16 && b <= 31 {
			return true
		}
		if a == 192 && b == 168 {
			return true
		}
		if a == 100 && b >= 64 && b <= 127 { // CGNAT
			return true
		}
		if a == 192 && b == 0 && (c == 0 || c == 2) {
			return true
		}
		if a == 192 && b == 88 && c == 99 { // 6to4 relay anycast（已弃用）
			return true
		}
		if a == 198 && b == 51 && c == 100 { // TEST-NET-2
			return true
		}
		if a == 198 && (b == 18 || b == 19) {
			return true
		}
		if a >= 224 { // 224/4 组播 + 240/4 保留（含 255.255.255.255）
			return true
		}
		_ = d
		return false
	}
	return false
}

// isPrivateIPAddr net.IP 语义的私网/保留段判定（无递归：v4 与 v4-mapped 直接
// 落到点分文本判定；公网全球单播如 2606:4700::（Cloudflare）放行）。
func isPrivateIPAddr(ip net.IP) bool {
	if ip4 := ip.To4(); ip4 != nil {
		// v4 字面量与 ::ffff:a.b.c.d（v4-mapped）统一按点分段语义
		return isPrivateIPv4Text(ip4.String())
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() || ip.IsPrivate() {
		return true
	}
	// 2001:db8::/32 文档保留段（不可路由，真实图床不会出现；保守拒绝）
	if len(ip) == 16 && ip[0] == 0x20 && ip[1] == 0x01 && ip[2] == 0x0d && ip[3] == 0xb8 {
		return true
	}
	return false
}

// assertPublicHttpURL SSRF 校验：文本层 + DNS 尽力解析（解析失败视为不可达拒绝）。
// TS dnsLookup 无显式超时；Go 加 5s 超时防解析卡死（更严格，方向一致）。
// Task 50: DNS 逐址校验改用 isPrivateIPAddr（v6 真实网段语义）——双栈站点（v4+AAAA）
// 不再因 AAAA 地址被 catch-all 误判私网而全站丢封面。
func assertPublicHttpURL(rawURL string) *url.URL {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil
	}
	if isPrivateIp(u.Hostname()) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupHost(ctx, u.Hostname())
	if err != nil || len(addrs) == 0 {
		return nil
	}
	for _, a := range addrs {
		if ip := net.ParseIP(a); ip != nil {
			if isPrivateIPAddr(ip) {
				return nil
			}
			continue
		}
		if isPrivateIp(a) {
			return nil
		}
	}
	return u
}

// pickCoverProxy 站点级代理池（与引擎同语义：逗号分隔多代理，取首个 http(s) 代理；
// socks 形态由封面下载通道不支持而忽略）
func pickCoverProxy(proxy string) string {
	if proxy == "" {
		return ""
	}
	for _, p := range strings.Split(proxy, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if strings.HasPrefix(p, "http://") || strings.HasPrefix(p, "https://") {
			return p
		}
	}
	return ""
}

// coverDialControl 连接前最后一道 SSRF 校验（Task 26-d 增强，封堵 DNS rebinding TOCTOU）：
// Control 回调收到的 address 是已解析的 IP 字面量，此处再查一次私网段——DNS 解析后、
// connect 前的切换窗口被关闭。仅直连路径启用（走代理时 address 是代理地址，
// 本地代理 127.0.0.1:7890 属合法形态，不能拦）。
func coverDialControl(network, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("cover dial: 非 IP 字面量地址被拒绝: %s", host)
	}
	if isPrivateIPAddr(ip) {
		return fmt.Errorf("cover dial: 内网地址被拒绝（DNS rebinding 防护）: %s", ip.String())
	}
	return nil
}

// coverTransport 每次下载构建 Transport（代理按规则可变）。
// Go http.Transport 代理语义与 TS undici ProxyAgent{proxyTunnel:false} 对齐：
// http 目标以绝对 URI 形式直发代理（非 CONNECT），https 目标走 CONNECT 隧道。
func coverTransport(proxyURL string) *http.Transport {
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if proxyURL == "" && os.Getenv("SCRAPER_ALLOW_PRIVATE") != "1" {
		d.Control = coverDialControl
	}
	t := &http.Transport{
		DialContext:         d.DialContext,
		TLSHandshakeTimeout: 10 * time.Second,
		MaxIdleConns:        2,
		IdleConnTimeout:     30 * time.Second,
	}
	if proxyURL != "" {
		if pu, err := url.Parse(proxyURL); err == nil {
			t.Proxy = http.ProxyURL(pu)
		}
	}
	return t
}

// fetchAndStoreCover 下载远程封面并落盘为 JPEG。
// 返回本地路径（`/covers/{novelId}.jpg`）与失败原因（成功时 reason 为空；
// Task 50：旧版静默返回 "" 导致封面缺失无迹可排查，原因现透出给调用方日志）。
// 已存在本地文件时幂等复用（不重复下载）。
// proxy：站点级出口代理（规则配置，http(s) 形态）——被封锁站点的图床也需经同一出口访问。
// Task 50-b：响应消费段（状态/类型/读体/解码/编码）抽为 consumeCoverResponse，
// 本函数保留 SSRF 校验/下载/落盘骨架与 panic 兜底。
func fetchAndStoreCover(novelID int, remoteURL, proxy string) (localPath, failReason string) {
	return fetchAndStoreCoverOpt(novelID, remoteURL, proxy, false)
}

// fetchAndStoreCoverOpt 下载远程封面并落盘为 JPEG（Task 69 全量重取核心）。
// force=false 与 fetchAndStoreCover 完全同语义；force=true 跳过幂等复用：重下后
// tmp+rename 原子覆盖旧图——下载失败时旧文件原样保留（不降级、不留空窗），成功时
// 新图原子替换（错位/模糊/站方更新封面一并修正）。供全量封面重取通道
// （backfill-covers?force=1）使用；采集内联与常规补抓仍走幂等复用。
func fetchAndStoreCoverOpt(novelID int, remoteURL, proxy string, force bool) (localPath, failReason string) {
	defer func() {
		if r := recover(); r != nil {
			localPath, failReason = "", fmt.Sprintf("panic: %v", r)
		}
	}()
	dir := coversDir()
	localAbs := filepath.Join(dir, itoa(novelID)+".jpg")
	localPath = LOCAL_PREFIX + itoa(novelID) + ".jpg"
	if !force {
		if st, err := os.Stat(localAbs); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
			return localPath, ""
		}
	}

	// 下载+消费（SSRF/重定向守卫/x509 insecure 重试/解码编码，Task 69-b 拆分）
	ob, reason := downloadCoverBytes(remoteURL, proxy)
	if reason != "" {
		return "", reason
	}
	return storeCoverJPEG(dir, novelID, ob)
}

// isCertVerifyErr 判定是否 TLS 证书链验证类失败（x509）。裸 IP 图床（
// https://38.34.172.127/... 实证）证书 CN/ SAN 不含该 IP、或自签/过期证书，
// 标准验证恒败——源站页面用浏览器也是带警告访问的（图床为站点自有资源）。
func isCertVerifyErr(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "x509:") ||
		strings.Contains(s, "tls: failed to verify") ||
		strings.Contains(s, "certificate is not trusted") ||
		strings.Contains(s, "certificate has expired") ||
		strings.Contains(s, "certificate is valid for")
}

// coverHTTPClient 封面下载客户端（Task 69-b 自 fetchAndStoreCover 抽出复用）。
// insecure=true 时放宽证书链验证（x509 失败后的单次重试语义）：SSRF 全链守卫
// （文本层+DNS+逐跳重定向+拨号 Control）与内容校验（状态/类型/限量/解码/解压炸弹）
// 全部不变，仅证书链验证放宽——封面为无凭据公开资源，无 Cookie/会话泄露面，
// MITM 最坏结果是拿到被篡改的图片字节，消费端解码+尺寸+JPEG 重编码已收敛风险。
func coverHTTPClient(proxy string, insecure bool) *http.Client {
	t := coverTransport(pickCoverProxy(proxy))
	if insecure {
		if t.TLSClientConfig == nil {
			t.TLSClientConfig = &tls.Config{}
		}
		t.TLSClientConfig.InsecureSkipVerify = true //nolint:gosec // 封面通道 x509 兑底，威胁模型见函数头注释
	}
	return &http.Client{
		Timeout:   COVER_DL_TIMEOUT,
		Transport: t,
		// 逐跳 SSRF 校验：默认客户端自动跟随重定向，图床 302 到内网地址会绕过
		// 对首跳 URL 的校验（SSRF 重定向变体）。每一跳终点重新过 assertPublicHttpURL。
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("cover redirect too many hops")
			}
			if assertPublicHttpURL(req.URL.String()) == nil {
				return errors.New("cover redirect blocked by SSRF guard: " + req.URL.String())
			}
			return nil
		},
	}
}

// downloadCoverBytes 下载远程封面并消费为可落盘的 JPEG 字节（Task 69-b 自
// fetchAndStoreCover 抽出网络段，与磁盘段 storeCoverJPEG 解耦；fetchCoverWithFallback
// 的多出口回退语义不变——本函数单出口，回退在包装层）。
// Task 69-b 新增：TLS 证书验证失败时单次 insecure 重试（实战：#240/#243 封面源
// https://38.34.172.127/uploads/cover/... 裸 IP 证书不可验证 → x509 恒败，且
// 「请求失败」分类触发 12 代理回退全链空烧）。重试后仍失败返回「TLS 证书校验失败
// （insecure 重试未过）」——不带「请求失败」前缀 = 确定性失败，不再触发代理回退空转。
func downloadCoverBytes(remoteURL, proxy string) (ob []byte, reason string) {
	u := assertPublicHttpURL(remoteURL)
	if u == nil {
		return nil, "SSRF 校验未过（非 http(s)/解析失败/私网地址）"
	}
	buildReq := func() (*http.Request, error) {
		req, err := http.NewRequest("GET", remoteURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", coverUA)
		req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
		req.Header.Set("Referer", u.Scheme+"://"+u.Host+"/")
		return req, nil
	}
	req, err := buildReq()
	if err != nil {
		return nil, "请求构造失败: " + err.Error()
	}
	client := coverHTTPClient(proxy, false)
	// Task 27-c（重新应用 25-a 修复⑤收尾，合并时丢失）：每次下载新建 Transport，用完
	// CloseIdleConnections 释放空闲连接，防长跑任务连接池驻留累积
	defer client.CloseIdleConnections()
	res, err := client.Do(req)
	if err != nil {
		if isCertVerifyErr(err) {
			// Task 69-b：x509 单次 insecure 重试（守卫/内容校验不变，仅放宽证书链）
			iclient := coverHTTPClient(proxy, true)
			defer iclient.CloseIdleConnections()
			if ireq, berr := buildReq(); berr == nil {
				if ires, ierr := iclient.Do(ireq); ierr == nil {
					defer func() {
						_ = ires.Body.Close()
						iclient.CloseIdleConnections()
					}()
					return consumeCoverResponse(ires)
				} else if isCertVerifyErr(ierr) {
					// 两跳均证书失败：确定性失败（同证书恒败），不触发代理回退空转
					return nil, "TLS 证书校验失败（insecure 重试未过）: " + truncateRunes(ierr.Error(), 100)
				} else {
					// insecure 跳换成网络类失败（dial/timeout）：保留网络类语义允许回退
					return nil, "请求失败: " + truncateRunes(ierr.Error(), 120)
				}
			}
		}
		return nil, "请求失败: " + truncateRunes(err.Error(), 120)
	}
	defer func() {
		_ = res.Body.Close()
		// body 关闭后再释放空闲连接（CloseIdleConnections 只关已归还池的连接）
		client.CloseIdleConnections()
	}()
	return consumeCoverResponse(res)
}

// storeCoverJPEG 封面字节落盘（Task 69-b 自 fetchAndStoreCover 抽出磁盘段）。
// CreateTemp(O_EXCL)+chmod+rename 原子覆盖，失败路径遗留 tmp 由 defer Remove 兑底。
func storeCoverJPEG(dir string, novelID int, ob []byte) (localPath, failReason string) {
	localPath = LOCAL_PREFIX + itoa(novelID) + ".jpg"
	localAbs := filepath.Join(dir, itoa(novelID)+".jpg")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "落盘目录创建失败: " + err.Error()
	}
	sum := md5.Sum([]byte(itoa(novelID)))

	// Task 27-c：tmp 名含 novelID 去重——并发同书封面下载（同名书多任务各自触发）
	// 共用同名 .tmp 会交错写坏后 rename 成坏图。Task 51-b 强化：os.CreateTemp 以
	// O_EXCL 原子创建，唯一性从「novelID+纳秒时间戳大概率唯一」（粗粒度时钟/同 tick
	// 双 goroutine 仍可撞名）升级为「绝对唯一」；旧版 WriteFile 半途失败/rename 失败
	// 兜底写失败等错误路径会遗留 .tmp 垃圾文件累积，defer Remove 兜底清理
	//（rename 成功后目标已不存在，Remove 为无害 ENOENT）。
	tf, terr := os.CreateTemp(dir, "."+hex.EncodeToString(sum[:])[:8]+"-"+itoa(novelID)+"-*.tmp")
	if terr != nil {
		return "", "临时文件创建失败: " + terr.Error()
	}
	tmpAbs := tf.Name()
	_, werr := tf.Write(ob)
	if werr == nil {
		werr = tf.Chmod(0o644) // CreateTemp 恒 0600，对齐旧 WriteFile 0o644 语义
	}
	if cerr := tf.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(tmpAbs)
		return "", "临时文件写入失败: " + werr.Error()
	}
	defer func() { _ = os.Remove(tmpAbs) }()
	// rename 覆盖：避免并发采集写一半被读到坏图
	if err := os.Rename(tmpAbs, localAbs); err != nil {
		if err2 := os.WriteFile(localAbs, ob, 0o644); err2 != nil {
			return "", "落盘失败: " + err2.Error()
		}
	}
	return localPath, ""
}

// consumeCoverResponse 消费封面下载响应（Task 50-b 自 fetchAndStoreCover 抽出：
// 状态/Content-Type/限量读/解码/缩放/JPEG 编码链独立成函数，畸形响应可表驱动单测）。
// 返回可直接落盘的 JPEG 字节；reason 非空 = 失败（Task 50 失败原因透出契约）。
// Task 50-b 修复：旧版 `err != nil || len(buf) == 0` 合并分支在「HTTP 200 + 空响应体」
// 时对 nil err 调 err.Error() → nil 指针 panic（外层 recover 吞成 "panic: runtime
// error:..." 假原因入失败明细）；拆分独立分支给出真实原因「响应体为空」。
func consumeCoverResponse(res *http.Response) (ob []byte, reason string) {
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, "HTTP " + itoa(res.StatusCode)
	}
	ctype := strings.ToLower(res.Header.Get("Content-Type"))
	if ctype != "" && !strings.HasPrefix(ctype, "image/") && !strings.Contains(ctype, "octet-stream") {
		return nil, "非图像响应: " + ctype
	}
	buf, err := coverReadBody(res.Body, MAX_COVER_BYTES)
	if err != nil {
		return nil, "响应体读取失败: " + truncateRunes(err.Error(), 80)
	}
	if len(buf) == 0 {
		return nil, "响应体为空"
	}

	// 解码 + 规范化：解码失败（伪装成图片的 HTML/攻击载荷）在此拒绝。
	// 先 DecodeConfig 读头部校验像素规模（Task 26-d 防解压炸弹：5MB 恶意 PNG 可声明
	// 数亿像素，直接 image.Decode 会在缩放前分配数 GB RGBA → OOM）
	cfgImg, _, err := image.DecodeConfig(bytes.NewReader(buf))
	if err != nil || cfgImg.Width <= 0 || cfgImg.Height <= 0 ||
		cfgImg.Width > coverMaxPixelsSide || cfgImg.Height > coverMaxPixelsSide ||
		int64(cfgImg.Width)*int64(cfgImg.Height) > coverMaxPixels {
		return nil, "图像头校验未过（非图/越界像素）"
	}
	img, _, err := image.Decode(bytes.NewReader(buf))
	if err != nil || img == nil {
		return nil, "图像解码失败: " + truncateRunes(err.Error(), 80)
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, "图像尺寸异常"
	}
	out := img
	if w > coverMaxSide || h > coverMaxSide {
		scale := float64(coverMaxSide) / float64(w)
		if h > w {
			scale = float64(coverMaxSide) / float64(h)
		}
		nw := int(float64(w)*scale + 0.5)
		nh := int(float64(h)*scale + 0.5)
		if nw < 1 {
			nw = 1
		}
		if nh < 1 {
			nh = 1
		}
		dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, xdraw.Over, nil)
		out = dst
	}
	var obuf bytes.Buffer
	if err := jpeg.Encode(&obuf, out, &jpeg.Options{Quality: 80}); err != nil {
		return nil, "JPEG 编码失败: " + err.Error()
	}
	if obuf.Len() < 64 {
		return nil, "编码输出过小"
	}
	return obuf.Bytes(), ""
}

// coverReadBody 限量读响应体：超过 maxBytes 即拒绝（防异常超大文件）
func coverReadBody(r io.Reader, maxBytes int) ([]byte, error) {
	buf, err := readAllLimited(r, maxBytes+1)
	if err != nil {
		return buf, err
	}
	if len(buf) > maxBytes {
		return buf, errors.New("cover too large")
	}
	return buf, nil
}

// ==================== 封面下载多出口回退（Task 51「杜绝后患」） ====================
//
// 实证（Task 51）：huangjinwu 图床（156.225.85.90）被沙箱网络封锁、规则 proxy=''（直连）
// → 该站全部书籍封面下载 dial timeout 静默丢失（ggd66 同为直连但图床可达故无恙）——
// 「封面出口 = 规则 proxy 单一决策」对图床封锁零容错。修复：网络类失败后自动遍历
// 回退出口（与封面同站的规则代理优先，其次其余规则代理池），主出口的确定性失败
// （404/非图像/空体/解码失败——直连观察可信，换出口结果相同）不回退。采集与补抓
// 两通道共用本机制。Task 51-b 语义修正：候选出口的确定性失败不再放弃整条回退链
//（见 fetchCoverWithFallback 注释）。

// regDomainApprox 近似注册域：host 的最后两段（img.huangjinwu.org / www.huangjinwu.org /
// huangjinwu.org → huangjinwu.org）。IP 字面量与单段 host 原样返回。多段公共后缀
// （com.cn 类）会得到宽松匹配——仅用于回退候选的排序优先级（尽力而为），不用于安全判定。
func regDomainApprox(host string) string {
	if ip := net.ParseIP(host); ip != nil {
		return host
	}
	parts := strings.Split(host, ".")
	if len(parts) >= 2 {
		return parts[len(parts)-2] + "." + parts[len(parts)-1]
	}
	return host
}

// ruleProxiesForHost 从 ScrapeRule 收集封面回退代理候选：
//  1. 与 srcURL 同站（近似注册域相等，img.x ↔ www.x ↔ x）规则的 proxy 优先——
//     站点语义精确匹配；
//  2. 其余规则的 proxy 兜底——规则池里任何可达代理都是合法回退出口。
//
// proxy 字段逗号分隔展开（与 pickCoverProxy 同语义：仅 http(s)，socks 封面通道不支持）、
// trim、去重保序。库错误/无候选返回 nil（调用方行为退化为单出口，不劣于修复前）。
func ruleProxiesForHost(srcURL string) []string {
	u, err := url.Parse(srcURL)
	if err != nil || u.Hostname() == "" {
		return nil
	}
	srcHost := strings.ToLower(u.Hostname())
	srcReg := regDomainApprox(srcHost)
	sameSite := []string{}
	others := []string{}
	seen := map[string]bool{}
	appendPool := func(pool string, same bool) {
		for _, p := range strings.Split(pool, ",") {
			p = strings.TrimSpace(p)
			if p == "" || seen[p] ||
				(!strings.HasPrefix(p, "http://") && !strings.HasPrefix(p, "https://")) {
				continue
			}
			seen[p] = true
			if same {
				sameSite = append(sameSite, p)
			} else {
				others = append(others, p)
			}
		}
	}
	err = queryList(
		`SELECT "siteUrl","proxy" FROM "ScrapeRule" WHERE "proxy" != '' ORDER BY "id" ASC`,
		func(rows *sql.Rows) error {
			var siteURL, proxy string
			if err := rows.Scan(&siteURL, &proxy); err != nil {
				return err
			}
			su, err := url.Parse(siteURL)
			if err != nil || su.Hostname() == "" {
				return nil
			}
			same := regDomainApprox(strings.ToLower(su.Hostname())) == srcReg
			appendPool(proxy, same)
			return nil
		})
	if err != nil {
		return nil
	}
	return append(sameSite, others...)
}

// coverFallbackProxies 回退候选来源（var：测试注入用，audit51_test.go；生产路径恒
// ruleProxiesForHost）。nil 返回=无回退出口。
var coverFallbackProxies = ruleProxiesForHost

// isNetworkLikeCoverReason 判定封面下载失败是否网络类（换出口可能改善）：
// ① 「请求失败」（dial/connect/timeout/TLS 等传输层，client.Do 返回 err）与
// 「响应体读取失败」（传输中断）两类前缀；② 网关类瞬态 5xx（500-599，Go Transport
// 对 http 目标的代理非 2xx 是响应透传而非 err，实测 503 落在此形态）——出口侧瞬时
// 故障，换出口可能改善。4xx（403 防盗链/404 不存在）与 2xx 消费类失败（非图像/空体/
// 解码）是确定性失败，换出口结果相同，不回退。
func isNetworkLikeCoverReason(reason string) bool {
	if strings.HasPrefix(reason, "请求失败") || strings.HasPrefix(reason, "响应体读取失败") {
		return true
	}
	return strings.HasPrefix(reason, "HTTP 5")
}

// maxCoverFallbackCandidates 单本书回退候选的防御性上限：候选来自运营配置的规则代理池
// （病态超长池可让采集车道单件阻塞数十分钟——每候选最坏 ≈17s DNS+HTTP）。截断保序取
// 前 N——同站优先序在前，截断只丢最末优先级候选，正常配置（规则数 ≤15）永不受影响。
const maxCoverFallbackCandidates = 12

// fetchCoverWithFallback 带出口回退的封面下载（fetchAndStoreCover 的多出口包装）：
// 先用 primaryProxy（规则 proxy 或空=直连）尝试；网络类失败时遍历 coverFallbackProxies
// 候选（跳过与 primary 相同者）逐个重试。hardDeadline 非零时每次候选尝试前检查剩余
// 预算，耗尽即停止回退、以首次失败原因返回（backfill 通道传 start.Add(coverBackfillBudget)
// 保证响应必在 WriteTimeout=65s 窗口内写回：单次尝试最坏 ≈17s（DNS 5s + 下载 12s，
// 解码/编码 CPU 再计 ~2s）×至多 1 次在途、检查点在每次发起前——预算内最后一次发起
// 最坏把总时长推到 budget+19s = 59s < 65s；候选耗尽语义=「这本书已按既定预算处理完」，
// attempted 计数不失真）。采集通道传零值=不限额（候选数受 maxCoverFallbackCandidates 封顶）。
//
// 回退语义（Task 51-b 修正）：主出口的确定性失败零回退——直连是对目标的真实观察，
// 404/非图像即目标真态；但候选出口的确定性失败不可信——被封锁/劫持的出口对任何请求
// 都可能回 200 text/html 拦截页（→「非图像响应」）或伪造 4xx，与目标真态无法区分，
// 旧版拿到首个候选确定性失败即放弃整条链，「坏出口排在好出口前面」时回退机制被单点
// 瓦解（与修复目标相反）。现记录首个候选确定性原因后继续尝试其余候选，全部失败时
// 优先透出该原因（比传输层错误更能定位真因）。
func fetchCoverWithFallback(novelID int, remoteURL, primaryProxy string, hardDeadline time.Time) (localPath, failReason string) {
	return fetchCoverWithFallbackOpt(novelID, remoteURL, primaryProxy, hardDeadline, false)
}

// fetchCoverWithFallbackOpt fetchCoverWithFallback 的 force 全量重取变体（Task 69）：
// force 透传 fetchAndStoreCoverOpt——force=true 时每次候选尝试都跳过幂等复用，首个
// 成功候选即落盘返回，同书同轮不会重复下载。
func fetchCoverWithFallbackOpt(novelID int, remoteURL, primaryProxy string, hardDeadline time.Time, force bool) (localPath, failReason string) {
	localPath, failReason = fetchAndStoreCoverOpt(novelID, remoteURL, primaryProxy, force)
	if localPath != "" || !isNetworkLikeCoverReason(failReason) {
		return localPath, failReason
	}
	firstReason := failReason
	firstDeterministic := ""
	tried := 0
	for i, p := range coverFallbackProxies(remoteURL) {
		if i >= maxCoverFallbackCandidates {
			break // 病态超长代理池防御性截断（保序，只丢最末优先级）
		}
		if p == pickCoverProxy(primaryProxy) {
			continue // primary 本身是代理时跳过同值重复尝试
		}
		if !hardDeadline.IsZero() && !time.Now().Before(hardDeadline) {
			break // 回退预算耗尽：停止候选，保留首因
		}
		tried++
		stored, r := fetchAndStoreCoverOpt(novelID, remoteURL, p, force)
		if stored != "" {
			return stored, ""
		}
		if !isNetworkLikeCoverReason(r) && firstDeterministic == "" {
			// 候选出口的确定性失败：可能是出口伪造（拦截页/防盗链页/假 404），
			// 记录后继续尝试其余候选（语义修正见函数头注释）
			firstDeterministic = r
		}
	}
	if tried > 0 {
		if firstDeterministic != "" {
			return "", firstDeterministic
		}
		return "", firstReason + "（代理回退×" + itoa(tried) + " 亦失败）"
	}
	return "", firstReason
}

// gradientTokenFor 派生渐变 token（无封面时的确定性回退）：以书名+作者 hash 均匀分布到 g1-g12。
// 与 TS createHash('md5').update(`${title}\u0000${author}`) 完全同算法——同名书必同 token
// （md5 输出一致，token 与 TS 侧历史数据也一致）。
func gradientTokenFor(title, author string) string {
	h := md5.Sum([]byte(title + "\x00" + author))
	return "g" + itoa(int(h[0])%12+1)
}

// backfillBrokenCoverLocal 存量本地封面文件缺失自愈（Task 60-R20）。
//
// 背景：沙箱整机回收清空 public/covers/ 运行时产物（不入 git/repo.tar），DB 中 286 本
// cover 仍指向 /covers/{id}.jpg → 站点大面积裂图。本回填在 boot 扫描 cover 为本地
// 形态的书，逐本 stat 文件；缺失 → 重置为 gradientTokenFor(title,author) 渐变 token
// （渲染层立即恢复确定性占位封面，视觉零裂图）。
//
// 衔接：重置后的书若 coverSrc ≠ ”，自动落入 coverBackfillCandidates 的既有候选面
// （token 形态 + 源 URL 非空）→ 补抓通道按预算重下真实封面，双层闭环。
//
// 幂等：文件存在的行零写放大（boot 重复执行无副作用）；token 重置以 title+author
// 确定性派生，同书同 token 与 TS 侧历史数据一致。
func backfillBrokenCoverLocal(db *sql.DB) error {
	type brokenRow struct {
		id     int64
		title  string
		author string
		cover  string
	}
	rows, err := db.Query(`SELECT "id","title","author","cover" FROM "Novel" WHERE "cover" LIKE '/covers/%'`)
	if err != nil {
		return err
	}
	broken := []brokenRow{}
	for rows.Next() {
		var r brokenRow
		if err := rows.Scan(&r.id, &r.title, &r.author, &r.cover); err != nil {
			rows.Close()
			return err
		}
		// 文件路径按 cover 值本身推导（handleCovers 同契约：Base 单段防路径穿越）
		base := filepath.Base(r.cover)
		if _, statErr := os.Stat(filepath.Join(coversDir(), base)); statErr != nil {
			broken = append(broken, r)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(broken) == 0 {
		return nil
	}
	for _, r := range broken {
		token := gradientTokenFor(r.title, r.author)
		if _, err := db.Exec(`UPDATE "Novel" SET "cover" = ?, "updatedAt" = ? WHERE "id" = ?`,
			token, nowMillis(), r.id); err != nil {
			return err
		}
	}
	log.Printf("[db] 本地封面文件缺失自愈：%d 本已重置渐变 token（补抓通道将按 coverSrc 重下）", len(broken))
	return nil
}

// purgeStaleCoversOnFreshDB 全新库 stale 封面清理（Task 66-② 根治）。
//
// 背景：整机回收后 DB 文件被删、重启后空库重建（novelId 从 1 重新分配），而
// public/covers/ 运行时产物若未被回收同步清空（第 6 次回收实证：残留 2946 个旧库
// 封面文件），旧 {id}.jpg 会挂到新库同 id 新书头上——封面与书籍张冠李戴；且
// backfillBrokenCoverLocal 的「文件存在即健康」判定对错位完全失明（文件恰好在，
// 断裂被掩盖），错位封面会长期留存。
//
// 判定与动作：Novel 表零行（全新库——任何真实存量恢复都不可能为空）时，covers
// 目录现存文件必然全部错位 → 整目录清空。清空后本库新书若已有 cover='/covers/N.jpg'
// 指向（恢复流程手工导入等极端时序），紧随其后的 backfillBrokenCoverLocal 会将其
// 重置渐变 token，补抓通道按 coverSrc 重建——与既有自愈链天然衔接。
// 有书目的库（正常重启/存量恢复）绝不触碰。幂等：清后目录为空，重复执行零删除。
// 必须在 backfillBrokenCoverLocal 之前调用（时序：先清文件，缺失自愈才能看见断裂）。
//
// Task 69-c 生产护栏（双层之一）：DB_PATH 被重定向（=测试进程，recover_test.go TestMain
// 沙箱）时立即返回——测试库 Novel 恒空会被误判「全新库」，配合真实 coversDir 会把
// 生产封面目录全量清空（2026-10-01 实证：两次 go test 抹掉 1690 张封面）。双层防线：
// 测试面由 TestMain 的 COVERS_DIR 沙箱兜底（本护栏失效时也只碰沙箱目录），生产面由
// 本护栏直接拒绝执行。
func purgeStaleCoversOnFreshDB(db *sql.DB) {
	if os.Getenv("DB_PATH") != "" {
		return // 测试进程：DB 被重定向到临时库，绝不触碰真实 covers 目录
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM "Novel"`).Scan(&n); err != nil {
		log.Printf("[db] stale 封面清理探测失败（跳过本轮清理，重启重试）: %v", err)
		return
	}
	if n > 0 {
		return // 存量库：封面与书目共生，不动
	}
	if removed := purgeStaleCoversIn(coversDir()); removed > 0 {
		log.Printf("[db] 全新库检测：清空 stale 封面 %d 个（旧库 novelId 与新库重新分配错位，张冠李戴根治；渲染回退渐变，补抓通道按新库重建）", removed)
	}
}

// purgeStaleCoversIn 清空目录下全部 .jpg 文件（跳过子目录与非 jpg），返回删除数。
// 独立成函数便于测试注入临时目录（绝不触碰真实 covers 目录）。
func purgeStaleCoversIn(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0 // 目录不存在/不可读 = 无 stale 面，静默
	}
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".jpg") {
			continue
		}
		if rmErr := os.Remove(filepath.Join(dir, e.Name())); rmErr == nil {
			removed++
		}
	}
	return removed
}
