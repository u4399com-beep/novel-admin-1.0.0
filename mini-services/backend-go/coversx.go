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
 */
package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
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

// isPrivateIPv4Text 点分四段文本层判定（含越界八位组拒绝；仅接受 v4 文本形态）
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
		if a == 198 && (b == 18 || b == 19) {
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
	defer func() {
		if r := recover(); r != nil {
			localPath, failReason = "", fmt.Sprintf("panic: %v", r)
		}
	}()
	dir := coversDir()
	localAbs := filepath.Join(dir, itoa(novelID)+".jpg")
	localPath = LOCAL_PREFIX + itoa(novelID) + ".jpg"
	if st, err := os.Stat(localAbs); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
		return localPath, ""
	}

	u := assertPublicHttpURL(remoteURL)
	if u == nil {
		return "", "SSRF 校验未过（非 http(s)/解析失败/私网地址）"
	}

	req, err := http.NewRequest("GET", remoteURL, nil)
	if err != nil {
		return "", "请求构造失败: " + err.Error()
	}
	req.Header.Set("User-Agent", coverUA)
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
	req.Header.Set("Referer", u.Scheme+"://"+u.Host+"/")
	client := &http.Client{
		Timeout:   COVER_DL_TIMEOUT,
		Transport: coverTransport(pickCoverProxy(proxy)),
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
	// Task 27-c（重新应用 25-a 修复⑤收尾，合并时丢失）：每次下载新建 Transport，用完
	// CloseIdleConnections 释放空闲连接，防长跑任务连接池驻留累积
	defer client.CloseIdleConnections()
	res, err := client.Do(req)
	if err != nil {
		return "", "请求失败: " + truncateRunes(err.Error(), 120)
	}
	defer func() {
		_ = res.Body.Close()
		// body 关闭后再释放空闲连接（CloseIdleConnections 只关已归还池的连接）
		client.CloseIdleConnections()
	}()
	ob, reason := consumeCoverResponse(res)
	if reason != "" {
		return "", reason
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "落盘目录创建失败: " + err.Error()
	}
	sum := md5.Sum([]byte(itoa(novelID)))
	// Task 27-c：tmp 名加 novelID+纳秒时间戳去重——并发同书封面下载（同名书多任务
	// 各自触发）旧版共用同名 .tmp，并发 WriteFile 同路径可交错写坏后 rename 成坏图
	tmpAbs := filepath.Join(dir, "."+hex.EncodeToString(sum[:])[:8]+"-"+itoa(novelID)+"-"+strconv.FormatInt(time.Now().UnixNano(), 36)+".tmp")
	if err := os.WriteFile(tmpAbs, ob, 0o644); err != nil {
		return "", "临时文件写入失败: " + err.Error()
	}
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

// gradientTokenFor 派生渐变 token（无封面时的确定性回退）：以书名+作者 hash 均匀分布到 g1-g12。
// 与 TS createHash('md5').update(`${title}\u0000${author}`) 完全同算法——同名书必同 token
// （md5 输出一致，token 与 TS 侧历史数据也一致）。
func gradientTokenFor(title, author string) string {
	h := md5.Sum([]byte(title + "\x00" + author))
	return "g" + itoa(int(h[0])%12+1)
}
