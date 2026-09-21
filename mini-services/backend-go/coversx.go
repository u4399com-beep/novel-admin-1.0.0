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
        "image"
        "image/jpeg"
        "io"
        _ "image/gif"
        _ "image/png"
        "net"
        "net/http"
        "net/url"
        "os"
        "path/filepath"
        "regexp"
        "strconv"
        "strings"
        "sync"
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

// isPrivateIp 私有/环回/链路本机地址文本层校验（含十进制、八进制、点分变体的粗防；逐行移植）
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
        if h == "::1" || h == "::" || strings.HasPrefix(h, "fc") || strings.HasPrefix(h, "fd") || strings.HasPrefix(h, "fe80") {
                return true
        }
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
        // IPv6 一般形态：全部拒绝（小说封面图床均为公网 v4/域名）
        if strings.Contains(h, ":") {
                return true
        }
        return false
}

// assertPublicHttpURL SSRF 校验：文本层 + DNS 尽力解析（解析失败视为不可达拒绝）。
// TS dnsLookup 无显式超时；Go 加 5s 超时防解析卡死（更严格，方向一致）。
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

// coverTransport 每次下载构建 Transport（代理按规则可变）。
// Go http.Transport 代理语义与 TS undici ProxyAgent{proxyTunnel:false} 对齐：
// http 目标以绝对 URI 形式直发代理（非 CONNECT），https 目标走 CONNECT 隧道。
func coverTransport(proxyURL string) *http.Transport {
        t := &http.Transport{
                DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
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
// 返回本地路径（`/covers/{novelId}.jpg`）；任何失败返回 ""（调用方保持渐变 token）。
// 已存在本地文件时幂等复用（不重复下载）。
// proxy：站点级出口代理（规则配置，http(s) 形态）——被封锁站点的图床也需经同一出口访问。
func fetchAndStoreCover(novelID int, remoteURL, proxy string) (localPath string) {
        defer func() {
                if r := recover(); r != nil {
                        localPath = ""
                }
        }()
        dir := coversDir()
        localAbs := filepath.Join(dir, itoa(novelID)+".jpg")
        localPath = LOCAL_PREFIX + itoa(novelID) + ".jpg"
        if st, err := os.Stat(localAbs); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
                return localPath
        }

        u := assertPublicHttpURL(remoteURL)
        if u == nil {
                return ""
        }

        req, err := http.NewRequest("GET", remoteURL, nil)
        if err != nil {
                return ""
        }
        req.Header.Set("User-Agent", coverUA)
        req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
        req.Header.Set("Referer", u.Scheme+"://"+u.Host+"/")
        client := &http.Client{Timeout: COVER_DL_TIMEOUT, Transport: coverTransport(pickCoverProxy(proxy))}
        res, err := client.Do(req)
        if err != nil {
                return ""
        }
        defer res.Body.Close()
        if res.StatusCode < 200 || res.StatusCode >= 300 {
                return ""
        }
        ctype := strings.ToLower(res.Header.Get("Content-Type"))
        if ctype != "" && !strings.HasPrefix(ctype, "image/") && !strings.Contains(ctype, "octet-stream") {
                return ""
        }

        buf, err := coverReadBody(res.Body, MAX_COVER_BYTES)
        if err != nil || len(buf) == 0 {
                return ""
        }

        // 解码 + 规范化：解码失败（伪装成图片的 HTML/攻击载荷）在此拒绝
        img, _, err := image.Decode(bytes.NewReader(buf))
        if err != nil || img == nil {
                return ""
        }
        b := img.Bounds()
        w, h := b.Dx(), b.Dy()
        if w <= 0 || h <= 0 {
                return ""
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
        var ob bytes.Buffer
        if err := jpeg.Encode(&ob, out, &jpeg.Options{Quality: 80}); err != nil {
                return ""
        }
        if ob.Len() < 64 {
                return ""
        }

        if err := os.MkdirAll(dir, 0o755); err != nil {
                return ""
        }
        sum := md5.Sum([]byte(itoa(novelID)))
        tmpAbs := filepath.Join(dir, "."+hex.EncodeToString(sum[:])[:8]+".tmp")
        if err := os.WriteFile(tmpAbs, ob.Bytes(), 0o644); err != nil {
                return ""
        }
        // rename 覆盖：避免并发采集写一半被读到坏图
        if err := os.Rename(tmpAbs, localAbs); err != nil {
                if err2 := os.WriteFile(localAbs, ob.Bytes(), 0o644); err2 != nil {
                        return ""
                }
        }
        return localPath
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
