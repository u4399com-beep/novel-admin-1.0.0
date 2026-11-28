/**
 * webi18n_sweep.go —— R164 渲染出口全站 CJK 文本清扫管线（用户指令：
 * 「只要不是恒简体中文，就要把全站所有文字都进行对应语种进行翻译显示」）。
 *
 * 定位：webi18n.go 数据面管线（i18nDict/T/Tf + i18nTexts/i18nNovelMaps +
 * i18nChapterParas）之后的最后兜底闸。数据面只覆盖「被 T 包裹的 UI 串 +
 * 显式登记字段的动态数据」，实测存在三类漏网：
 *   a) 非 jiuxiaozw 主题（trxsw 等）UI 字符串大量未包 T（R163 移交项②）；
 *   b) 字典未登记词组（tmplT miss 恒回原文）；
 *   c) i18nNovelMaps 未登记字段/新模板插值点。
 * sweep 在渲染出口对最终 HTML 做文本节点扫描：凡含汉字的可见文本一律走
 * TranslationCache 语种管线——命中即替换、未命中 zh-Hant 同步 OpenCC 补译
 * （秒级词典，6s 超时）、en/ja/ko 异步预热（复用并发闸 2 + 失败负缓存，
 * 渲染路径零同步等待），译文落缓存后全站逐页收敛为纯目标语种页面。
 *
 * 设计约束：
 *   - 位置级重建（非 strings.Replace）：属性值/script 内容绝不被误替换；
 *   - 可见属性扩展（R164b）：placeholder/alt/title/aria-label 四类「用户可见」
 *     属性值同样送翻（输入框占位/图裂 alt/悬停 tooltip/读屏标签均为显示文字）；
 *     href/src/value/content 等功能属性绝不触碰（URL 参数/表单值翻译会破坏语义）；
 *   - script/style/pre/code/textarea 与 HTML 注释整体跳过（JS 字符串/JSON
 *     载荷/代码示例不翻，防结构破坏）；
 *   - 文本节点先 html.UnescapeString 再入缓存（与数据面原始文本键同域，
 *     数据面预热成果被 sweep 直接命中）；译文回写 html.EscapeString；
 *   - zh-Hant 对已是繁体的段做幂等转换（OpenCC 词典 ms 级，结果同文回填
 *     缓存；首渲染多一轮上游属可接受成本，换取未包 T 主题的完整覆盖）；
 *   - flightKey 外置：章节页传 "<chapterID>" 与 i18nChapterParas 预热键
 *     （"<chapterID>|<lang>"）拼后同键，LoadOrStore 天然去重不双飞；
 *     其它页 "<page>" 派生哈希键，同批重复请求去重、异页互不挤占。
 */
package main

import (
        "crypto/sha256"
        "encoding/hex"
        "html"
        "sort"
        "strings"
        "unicode"
)

const (
        sweepMinRunes    = 1    // 单汉字段也送翻（R164 全量语义：单位字/残句单字不残留；无汉字段本就被 sweepHasHan 挡住）
        sweepMaxRunes    = 9000 // 单段上限（translate-service MAX_ITEM_CHARS=10000 内）
        sweepWarmMaxSegs = 300  // 单次渲染最多入队预热段数（与上游 MAX_ITEMS 对齐）
        sweepShortRunes  = 120  // 短文本（书名/UI 词）回填 LRU 上限
        sweepSyncBatch   = 280  // zh-Hant 同步补译批大小（与 i18nTexts 同口径）
)

// sweepSkipTags 整体跳过的标签（内容非展示文本：代码/脚本/样式/表单预填值）
var sweepSkipTags = map[string]bool{
        "script": true, "style": true, "pre": true, "code": true, "textarea": true,
}

// sweepAttrNames 送翻的「用户可见」属性白名单（占位符/图裂说明/悬停提示/读屏标签）；
// 白名单外属性一律不碰——href/src/value/content 承载功能语义，翻译即破坏
var sweepAttrNames = map[string]bool{
        "placeholder": true, "alt": true, "title": true, "aria-label": true,
}

// sweepSeg HTML 文本节点字节区间 [start,end)
type sweepSeg struct{ start, end int }

// sweepNode 单一唯一原文的译文归属（原文按 Unescape 后口径入缓存，与数据面同域）
type sweepNode struct {
        raw    string // Unescape 后含空白原文
        core   string // TrimSpace 后实际送翻文本
        lead   string // 前导空白（重建时原样保留）
        trail  string // 尾随空白
        ranges []sweepSeg
}

// i18nSweepScan 提取文本节点区间：引号感知的标签边界扫描（html/template 属性
// 恒引号包裹，引号内 '>' 不终止标签）；skip 标签按浏览器语义找字面闭合
// （</tag 大小写不敏感）整体跳过。
func i18nSweepScan(s string) []sweepSeg {
        segs := make([]sweepSeg, 0, 96)
        i, n := 0, len(s)
        for i < n {
                lt := strings.IndexByte(s[i:], '<')
                if lt < 0 {
                        if strings.TrimSpace(s[i:]) != "" {
                                segs = append(segs, sweepSeg{i, n})
                        }
                        return segs
                }
                tagAt := i + lt
                if strings.TrimSpace(s[i:tagAt]) != "" {
                        segs = append(segs, sweepSeg{i, tagAt})
                }
                if strings.HasPrefix(s[tagAt:], "<!--") { // 注释整体跳过
                        if end := strings.Index(s[tagAt+4:], "-->"); end >= 0 {
                                i = tagAt + 4 + end + 3
                                continue
                        }
                        return segs
                }
                // 标签边界 '>'（引号内不算）
                end := tagAt + 1
                quote := byte(0)
                for end < n {
                        c := s[end]
                        if quote != 0 {
                                if c == quote {
                                        quote = 0
                                }
                        } else if c == '"' || c == '\'' {
                                quote = c
                        } else if c == '>' {
                                break
                        }
                        end++
                }
                if end >= n {
                        return segs
                }
                nameStart := tagAt + 1
                closing := false
                if nameStart < n && (s[nameStart] == '/' || s[nameStart] == '?') {
                        closing = true
                        nameStart++
                }
                nameEnd := nameStart
                for nameEnd < n {
                        c := s[nameEnd]
                        if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == ':' {
                                nameEnd++
                        } else {
                                break
                        }
                }
                tagName := strings.ToLower(s[nameStart:nameEnd])
                if !closing && sweepSkipTags[tagName] {
                        // 浏览器语义：字面闭合标签整体跳过（script 内 JS/JSON 一律不进文本面）
                        ci := strings.Index(strings.ToLower(s[end+1:]), "</"+tagName)
                        if ci < 0 {
                                return segs
                        }
                        i = end + 1 + ci
                        continue
                }
                // R164b: 白名单可见属性值同样入清扫面（placeholder/alt/title/aria-label）
                if !closing && !sweepSkipTags[tagName] {
                        sweepCollectAttrs(s, tagAt+1, end, segsBlock(&segs))
                }
                i = end + 1
        }
        return segs
}

// segsBlock 闭包适配器（扫描主循环内联使用）
func segsBlock(segs *[]sweepSeg) func(int, int) {
        return func(a, b int) { *segs = append(*segs, sweepSeg{a, b}) }
}

// sweepCollectAttrs 在标签体 [lo,hi) 内定位白名单属性的引号值区间（html/template
// 属性值恒引号包裹；值内引号已转义为实体，字面同引号即真闭合）。
// 全路径必前进（每轮循环 i 至少 +1）——属性解析态机无死循环出口。
func sweepCollectAttrs(s string, lo, hi int, add func(int, int)) {
        i := lo
        for i < hi {
                for i < hi && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
                        i++
                }
                if i >= hi {
                        return
                }
                ns := i
                for i < hi && (s[i] >= 'a' && s[i] <= 'z' || s[i] >= 'A' && s[i] <= 'Z' || s[i] >= '0' && s[i] <= '9' || s[i] == '-' || s[i] == '_' || s[i] == ':') {
                        i++
                }
                if i == ns {
                        i++ // 非属性名字符（'='/异常），前进防死循环
                        continue
                }
                name := strings.ToLower(s[ns:i])
                for i < hi && s[i] != '=' && s[i] != ' ' && s[i] != '\t' && s[i] != '\n' && s[i] != '\r' {
                        i++
                }
                if i >= hi || s[i] != '=' {
                        continue // 无值属性/断字——循环头继续（i 必已前进）
                }
                i++
                for i < hi && (s[i] == ' ' || s[i] == '\t') {
                        i++
                }
                if i >= hi || (s[i] != '"' && s[i] != '\'') {
                        continue
                }
                q := s[i]
                vs := i + 1
                ve := -1
                for j := vs; j < hi; j++ {
                        if s[j] == q {
                                ve = j
                                break
                        }
                }
                if ve < 0 {
                        return
                }
                if sweepAttrNames[name] && ve > vs {
                        add(vs, ve)
                }
                i = ve + 1
        }
}

// sweepHasHan 段内是否含汉字（纯数字/拉丁/标点不送翻）
func sweepHasHan(s string) bool {
        for _, r := range s {
                if unicode.Is(unicode.Han, r) {
                        return true
                }
        }
        return false
}

// sweepFlightHash 预热飞行键内容指纹（同批重复请求去重、异页互不挤占）
func sweepFlightHash(texts []string) string {
        h := sha256.New()
        for _, t := range texts {
                h.Write([]byte(t))
                h.Write([]byte{0})
        }
        return hex.EncodeToString(h.Sum(nil))[:10]
}

// i18nSweepHTML 渲染出口清扫主入口：扫描→去重→查译文→分流补译→位置级重建。
// flightBase 空串 = 不做异步预热（调用面显式禁用时用）。
func i18nSweepHTML(lang, flightBase string, novelID int64, htmlStr string) string {
        if lang == "" || lang == "zh-CN" || htmlStr == "" {
                return htmlStr
        }
        segs := i18nSweepScan(htmlStr)
        if len(segs) == 0 {
                return htmlStr
        }
        uniq := map[string]*sweepNode{}
        order := make([]string, 0, len(segs))
        for _, sg := range segs {
                raw := html.UnescapeString(htmlStr[sg.start:sg.end])
                core := strings.TrimSpace(raw)
                if !sweepHasHan(core) {
                        continue
                }
                // R190 防回炉：已属目标语种的段（ja 假名/ko 谚文）不再送翻——数据面译文
                // 会被本 sweep 二次收集，zh→ja 管线回炉产出垃圾译文且 v!=t 替换显示
                if i18nLooksTargetLang(lang, core) {
                        continue
                }
                rn := len([]rune(core))
                if rn < sweepMinRunes || rn > sweepMaxRunes {
                        continue
                }
                nd, ok := uniq[core]
                if !ok {
                        li := strings.Index(raw, core)
                        nd = &sweepNode{raw: raw, core: core, lead: raw[:li], trail: raw[li+len(core):]}
                        uniq[core] = nd
                        order = append(order, core)
                }
                nd.ranges = append(nd.ranges, sg)
        }
        if len(order) == 0 {
                return htmlStr
        }
        // 译文表：i18nDict 直查（手写字典零成本即时生效——未包 T 的主题同样吃字典）
        // → LRU 正命中（仅短文本）→ TranslationCache 批量（全文寻址与数据面同域）
        tr := make(map[string]string, len(order))
        need := make([]string, 0, len(order))
        for _, t := range order {
                if v := tmplT(lang, t); v != t && v != "" {
                        tr[t] = v
                        continue
                }
                if len([]rune(t)) <= sweepShortRunes {
                        if m := i18nShortGet(lang, []string{t}); m[t] != "" {
                                tr[t] = m[t]
                                continue
                        }
                }
                need = append(need, t)
        }
        keys := make([]string, len(need))
        for i, t := range need {
                keys[i] = translateCacheKey(t, lang)
        }
        cached := translateCacheGet(keys) // 单次批量（IN 90 分批内聚在 translateCacheGet）
        for _, t := range need {
                if v, ok := cached[translateCacheKey(t, lang)]; ok && v != "" {
                        tr[t] = v
                        if len([]rune(t)) <= sweepShortRunes {
                                i18nShortOverwrite(lang, map[string]string{t: v})
                        }
                }
        }
        // 未命中分流：OpenCC 语种（zh-Hant/zh-HK）同步补译（秒级词典）；libre 语种 R190
        // 同步补译完整性闸（预算内译文展示前落库回填）→ 预算外残余异步预热
        miss := make([]string, 0, len(order))
        for _, t := range order {
                if _, ok := tr[t]; !ok {
                        miss = append(miss, t)
                }
        }
        if len(miss) > 0 {
                if i18nLangIsOpenCC(lang) {
                        i18nSweepSyncFill(lang, novelID, miss, tr)
                } else {
                        filled := i18nSyncFillMisses(lang, novelID, miss)
                        for t, v := range filled {
                                if v != "" && v != t {
                                        tr[t] = v
                                }
                        }
                        rest := make([]string, 0, len(miss))
                        for _, t := range miss {
                                if _, ok := tr[t]; !ok {
                                        rest = append(rest, t)
                                }
                        }
                        miss = rest
                        if flightBase != "" && len(miss) > 0 {
                                warm := miss
                                if len(warm) > sweepWarmMaxSegs {
                                        warm = warm[:sweepWarmMaxSegs]
                                }
                                i18nAsyncWarmKey(lang, flightBase+"|"+lang+"|"+sweepFlightHash(warm), novelID, warm)
                        }
                }
        }
        // 位置级重建：按 start 升序拼接（同原文多区间同译文；属性/script 不可达）
        type sweepRep struct {
                sweepSeg
                lead, v, trail string
        }
        reps := make([]sweepRep, 0, len(order))
        for _, t := range order {
                v, ok := tr[t]
                if !ok || v == "" || v == t {
                        continue
                }
                esc := html.EscapeString(v)
                nd := uniq[t]
                for _, rg := range nd.ranges {
                        reps = append(reps, sweepRep{rg, nd.lead, esc, nd.trail})
                }
        }
        if len(reps) == 0 {
                return htmlStr
        }
        sort.Slice(reps, func(i, j int) bool { return reps[i].start < reps[j].start })
        var b strings.Builder
        b.Grow(len(htmlStr) + 2048)
        prev := 0
        for _, rp := range reps {
                if rp.start < prev {
                        continue
                }
                b.WriteString(htmlStr[prev:rp.start])
                b.WriteString(rp.lead) // sweepRep 未内嵌 lead/trail——见下注
                b.WriteString(rp.v)
                b.WriteString(rp.trail)
                prev = rp.end
        }
        b.WriteString(htmlStr[prev:])
        return b.String()
}

// i18nSweepSyncFill zh-Hant 未命中段渲染路径同步补译（OpenCC 词典秒级，6s 超时；
// 失败静默原文——页面绝不因翻译故障失败）+ 回写缓存/LRU 与数据面同域复用。
func i18nSweepSyncFill(lang string, novelID int64, miss []string, tr map[string]string) {
        for start := 0; start < len(miss); start += sweepSyncBatch {
                end := start + sweepSyncBatch
                if end > len(miss) {
                        end = len(miss)
                }
                batch := miss[start:end]
                res, err := i18nSyncTranslate(lang, batch)
                if err != nil {
                        return
                }
                keys := make([]string, len(batch))
                missIdx := make([]int, 0, len(batch))
                put := map[string]string{}
                for i, t := range batch {
                        keys[i] = translateCacheKey(t, lang)
                        if i < len(res) && res[i] != "" {
                                tr[t] = res[i]
                                missIdx = append(missIdx, i)
                                if len([]rune(t)) <= sweepShortRunes {
                                        put[t] = res[i]
                                }
                        }
                }
                if len(missIdx) > 0 {
                        translateCachePut(batch, keys, res, missIdx, novelID)
                }
                if len(put) > 0 {
                        i18nShortOverwrite(lang, put)
                }
        }
}
