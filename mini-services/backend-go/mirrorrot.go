/**
 * mirrorrot.go —— P3-2 规则级镜像域名轮换（关关采集器「多书源」机制的后端侧落地）。
 *
 * 关关采集器的「多书源」本质：同一内容多个入口 → 入口级独立限速域 → 吞吐 ×N、
 * 单域被封时自动切换。本实现（设计稿 docs/perf-plan.md §P3-2 的后端侧落地方案）：
 *
 *   - ScrapeRule.mirrorHosts（逗号分隔镜像域，如 "https://m1.example.com,https://m2.example.com"）；
 *   - phase2Fill 章节抓取前按 round-robin 把章节 URL 的 host 换成健康镜像（路径/查询
 *     原样保留——镜像站路径结构一致性由规则作者保证，配套 /api/scrape-rules/mirror-check
 *     内容一致性检测工具）；referer 同步换域保持同站语义；
 *   - 镜像域各自独立域槽（引擎按 host 限速，天然隔离）→ 单规则多域并行；
 *   - 镜像连败 mirrorFailDemote（默认 3）次自动降权（本轮停用，成功复活）；
 *   - 全镜像降权/未配置 → 原样走主域（零行为变化）；
 *   - FillRows/骨架行仍存主域 URL（canonical）——换域仅发生在发请求瞬间，断点续采
 *     与目录 diff 语义不变。
 *
 * 引擎侧零改动：亲和/慢锁/cookie 会话桶/域槽全部按 host 键控，镜像域天然获得独立
 * 策略链状态；镜像首次访问从 HTTP 快通道起步（同 CMS 家族通常无需过盾）。
 */
package main

import (
        "net/url"
        "sort"
        "strings"
        "sync"
)

// mirrorFailDemote 镜像连续失败 N 次降权（本轮停用；任一次成功即复活并清零连败）。
const mirrorFailDemote = 3

// mirrorHost 规范化镜像入口（scheme 缺省 https；host 含可选端口，小写）。
type mirrorHost struct {
        Scheme string
        Host   string
}

// String "https://host" 形态（存储/日志/比较统一口径）。
func (m mirrorHost) String() string { return m.Scheme + "://" + m.Host }

// parseMirrorHosts 解析规则级镜像配置 → 规范化去重列表。
//   - raw：逗号/空白/换行分隔，条目支持 "m.example.com" / "http://m.example.com" /
//     "https://m.example.com/"（带路径的条目取其 host，路径不参与——镜像按整域映射）；
//   - mainSiteURL：规则主站 URL——与主站同 host 的条目剔除（换域到主域等于没换，
//     还会叠加主域限速槽排队）；
//   - 非法条目（解析失败/空 host）静默丢弃：配置容错优先，mirror-check 工具会在
//     保存前给出可见反馈。
func parseMirrorHosts(raw, mainSiteURL string) []mirrorHost {
        mainHost := ""
        if u, err := url.Parse(strings.TrimSpace(mainSiteURL)); err == nil && u.Host != "" {
                mainHost = strings.ToLower(u.Host)
        }
        seen := map[string]bool{}
        out := make([]mirrorHost, 0, 4)
        for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
                return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t' || r == '\r'
        }) {
                part = strings.TrimSpace(part)
                if part == "" {
                        continue
                }
                scheme, host := "https", part
                if strings.Contains(part, "://") {
                        u, err := url.Parse(part)
                        if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
                                continue
                        }
                        scheme, host = u.Scheme, u.Host
                }
                host = strings.ToLower(strings.Trim(host, "/"))
                // 镜像按整域映射：条目带路径（m.example.com/xxx）取 host 部分，路径不参与
                if i := strings.IndexAny(host, "/?#"); i >= 0 {
                        host = host[:i]
                }
                if host == "" || strings.Contains(host, "/") || strings.Contains(host, "?") {
                        continue
                }
                if mainHost != "" && host == mainHost {
                        continue
                }
                mh := mirrorHost{Scheme: scheme, Host: host}
                key := mh.String()
                if seen[key] {
                        continue
                }
                seen[key] = true
                out = append(out, mh)
        }
        return out
}

// hostSwapURL 把 URL 的 scheme/host 换成镜像入口（路径/查询/锚原样保留）。
// 解析失败返回 ""（调用方原样放行主域）。
func hostSwapURL(rawURL string, mh mirrorHost) string {
        u, err := url.Parse(rawURL)
        if err != nil || u.Host == "" {
                return ""
        }
        u.Scheme = mh.Scheme
        u.Host = mh.Host
        return u.String()
}

// mirrorState 单镜像运行态（phase2Fill 任务级；跨任务不共享——每轮任务从全健康起步，
// 让临时故障的镜像下一轮自然复活，与 hosthealth 的跨任务记忆互不干扰）。
type mirrorState struct {
        mh         mirrorHost
        alive      bool
        failStreak int
        okN        int64
        failN      int64
}

// mirrorRotator 任务级镜像轮换器（nil = 未配置镜像，全方法 nil 安全零开销）。
type mirrorRotator struct {
        mu      sync.Mutex
        mirrors []mirrorState
        rr      int // round-robin 游标（所有镜像间推进，含降权位——避免活窗内总命中第一个活镜像）
}

// newMirrorRotator 构造轮换器；无镜像返回 nil。
func newMirrorRotator(ms []mirrorHost) *mirrorRotator {
        if len(ms) == 0 {
                return nil
        }
        r := &mirrorRotator{mirrors: make([]mirrorState, len(ms))}
        for i, mh := range ms {
                r.mirrors[i] = mirrorState{mh: mh, alive: true}
        }
        return r
}

// pickURL 抓取前改写：从活镜像中 round-robin 选一个换域（u 与 referer 同步换）。
// 无活镜像/URL 不可解析 → 原样返回。返回改写后的 (u2, referer2)。
func (r *mirrorRotator) pickURL(u, referer string) (string, string) {
        if r == nil {
                return u, referer
        }
        r.mu.Lock()
        defer r.mu.Unlock()
        if len(r.mirrors) == 0 {
                return u, referer
        }
        n := len(r.mirrors)
        for i := 0; i < n; i++ {
                idx := (r.rr + i) % n
                if !r.mirrors[idx].alive {
                        continue
                }
                r.rr = (idx + 1) % n
                u2 := hostSwapURL(u, r.mirrors[idx].mh)
                if u2 == "" {
                        continue // 主域 URL 非法：镜像换域无意义，原样放行
                }
                ref2 := referer
                if ref2 != "" {
                        if swapped := hostSwapURL(ref2, r.mirrors[idx].mh); swapped != "" {
                                ref2 = swapped
                        }
                }
                return u2, ref2
        }
        return u, referer // 全部降权：回主域
}

// report 抓取结果回填（仅对镜像域生效；主域调用静默忽略）。
// ok → 复活+清零连败；!ok → 连败+1，达 mirrorFailDemote 降权。
func (r *mirrorRotator) report(u2 string, ok bool) {
        if r == nil || u2 == "" {
                return
        }
        pu, err := url.Parse(u2)
        if err != nil || pu.Host == "" {
                return
        }
        host := strings.ToLower(pu.Host)
        r.mu.Lock()
        defer r.mu.Unlock()
        for i := range r.mirrors {
                if r.mirrors[i].mh.Host != host {
                        continue
                }
                if ok {
                        r.mirrors[i].okN++
                        r.mirrors[i].failStreak = 0
                        r.mirrors[i].alive = true
                } else {
                        r.mirrors[i].failN++
                        r.mirrors[i].failStreak++
                        if r.mirrors[i].failStreak >= mirrorFailDemote {
                                r.mirrors[i].alive = false
                        }
                }
                return
        }
}

// liveCount 当前活镜像数（观测）。
func (r *mirrorRotator) liveCount() int {
        if r == nil {
                return 0
        }
        r.mu.Lock()
        defer r.mu.Unlock()
        n := 0
        for i := range r.mirrors {
                if r.mirrors[i].alive {
                        n++
                }
        }
        return n
}

// summary 任务级镜像状态摘要（日志观测："https://m1 ✓2 ✗0 | https://m2 降权"）。
func (r *mirrorRotator) summary() string {
        if r == nil {
                return ""
        }
        r.mu.Lock()
        defer r.mu.Unlock()
        parts := make([]string, 0, len(r.mirrors))
        for i := range r.mirrors {
                m := &r.mirrors[i]
                status := "✓" + itoa(int(m.okN)) + " ✗" + itoa(int(m.failN))
                if !m.alive {
                        status += "（降权）"
                }
                parts = append(parts, m.mh.String()+" "+status)
        }
        sort.Strings(parts)
        return strings.Join(parts, " | ")
}
