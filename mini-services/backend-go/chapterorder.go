/**
 * chapterorder.go —— 章节目录序号重排（服务端专用纯函数）。
 *
 * TS 源：src/lib/scrape/ordering.ts（22-a 修复后的纯序号语义版，逐行移植；
 * Chapter.volume 字段已随 schema 演进移除，Go 侧同样无分卷信息）。
 *
 * 源站目录常见两类乱序形态：
 *  1. 书页先渲染「最新章节 N 条（新→旧）」再渲染完整目录（旧→新）——按 DOM 顺序编 idx
 *     会让整本阅读顺序错乱；
 *  2. 整站目录新→旧倒序输出。
 *
 * 策略：以章节标题中的「第N章/节/回/话」序号为主键做乱序检测与稳定重排：
 * - 无重复序号：位置错乱占比超阈值 → 全局稳定排序（未编号章节锚定在前一编号章节之后）；
 * - 有重复序号（分卷各自重新编号）：无分卷信息可用，只做保守的「头部倒序块后移」修复；
 * - 编号章节过少（信号不足）或未见乱序 → 原样返回。
 *
 * 消费方两处（Task 48 起）：
 *  - worker 管线 phase1Skeletons（reorderRefPairs 适配器）：新数据入库前重排——
 *    TS 原版管线行为，Go 移植时曾丢失（入库从未重排 → 书页「最新章节块(新→旧)+
 *    完整目录(旧→新)」DOM 序直入 idx，目录从最新章开头）。
 *  - /api/novels/resort-chapters（存量目录重排，api_noveltools.go）。
 */
package main

import (
        "fmt"
        "regexp"
        "sort"
        "strconv"
)

// NUMBERED_MIN 编号章节少于该值不做乱序判定（信号不足，误判代价大于收益）
const NUMBERED_MIN = 8

// DISORDER_RATIO 位置错乱占比超过该阈值才重排（已有序目录 0%；最新块/整本倒序 ≈100%）
const DISORDER_RATIO = 0.2

// cnDigits 零〇一二两三四五六七八九（JS CN_DIGITS 逐字对齐）
var cnDigits = map[rune]int64{
        '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}

// cnUnits 十百千（JS CN_UNITS）
var cnUnits = map[rune]int64{'十': 10, '百': 100, '千': 1000}

// cnBig 万亿（JS CN_BIG）
var cnBig = map[rune]int64{'万': 10_000, '亿': 100_000_000}

// allDigitsAsc 纯阿拉伯数字判定（JS /^\d{1,9}$/；ASCII 数字即 \d 等价集）
func allDigitsAsc(s string) bool {
        if len(s) == 0 || len(s) > 9 {
                return false
        }
        for i := 0; i < len(s); i++ {
                if s[i] < '0' || s[i] > '9' {
                        return false
                }
        }
        return true
}

func parseInt10(s string) int64 {
        n, _ := strconv.ParseInt(s, 10, 64)
        return n
}

// chineseNumeralToInt 中文数字解析：支持 零〇一二两三四五六七八九十百千万亿 组合
// （如 两百零三、一千零一十、三千五百万）。非法输入返回 0 且 ok=false（JS null）。
func chineseNumeralToInt(s string) (int64, bool) {
        if s == "" {
                return 0, false
        }
        // 纯阿拉伯数字直接转
        if allDigitsAsc(s) {
                return parseInt10(s), true
        }
        var total int64   // 已完成的大节（万/亿以上）
        var section int64 // 当前万/亿节内累计
        var current int64 // 当前位累计
        any := false
        for _, ch := range s { // JS for..of 按码点迭代 → []rune 循环等价
                if d, ok := cnDigits[ch]; ok {
                        current = d
                        any = true
                } else if u, ok := cnUnits[ch]; ok { // JS CN_UNITS[ch] truthy → 命中即非零
                        section += orOne(current) * u // 「十」开头（十五）按 1 处理
                        current = 0
                        any = true
                } else if b, ok := cnBig[ch]; ok {
                        section = (section + current) * b
                        total += section
                        section = 0
                        current = 0
                        any = true
                } else {
                        return 0, false // 未知字符（「第X卷」里的非数字内容等）
                }
        }
        if !any {
                return 0, false
        }
        return total + section + current, true
}

// orOne JS (current || 1)：0 视为 1
func orOne(v int64) int64 {
        if v == 0 {
                return 1
        }
        return v
}

// chapterNoRe 第N章/节/回/话（阿拉伯 1-7 位含全角或中文数字 1-12 位；Task 50：
// ①全角数字 ０-９ 纳入——部分源站章节标题用全角编号，旧版解析 miss → 信号不足
// 不重排/乱序检测漏报；②允许少量装饰前缀（【/[/（/(/「/『）——「【第1章】」形态
// 旧版 ^第 锚定 miss。归一与捕获组语义不变（全角在 parseChapterNo 内折叠）
var chapterNoRe = regexp.MustCompile(`^[\[【(（「『]{0,2}第` + jsSpaceClass + `*([0-9０-９]{1,7}|[零〇一二两三四五六七八九十百千万]{1,12})` + jsSpaceClass + `*[章节回话]`)

// foldFullwidthDigits ASCII 数字形态归一（全角 ０-９ → ０-9），供 parseChapterNo 在
// chineseNumeralToInt（其 allDigitsAsc 仅认 ASCII）之前调用
func foldFullwidthDigits(s string) string {
        need := false
        for i := 0; i < len(s); i++ {
                if s[i] >= 0xEF {
                        need = true
                        break
                }
        }
        if !need {
                return s
        }
        b := []byte(s)
        for i := 0; i < len(b); i++ {
                // UTF-8 全角数字 EFBC90-EFBC99 → '0'-'9'
                if b[i] == 0xEF && i+2 < len(b) && b[i+1] == 0xBC && b[i+2] >= 0x90 && b[i+2] <= 0x99 {
                        b[i] = b[i+2] - 0x90 + '0'
                        b = append(b[:i+1], b[i+3:]...)
                }
        }
        return string(b)
}

// chapterPrefixRe 「123.」「123、」「123:」纯数字前缀（后跟非空白内容；含全角数字形态）
var chapterPrefixRe = regexp.MustCompile(`^([0-9０-９]{1,5})[.、:：]` + jsSpaceClass + `*\S`)

// chapterPartSuffixRe R124 章内分片尾号（5165 站拆分转载形态：「第三十四章 未竟之局03」
// 同章号多分片并列，尾缀 01/02/03… 是分片序）。取标题尾缀数字（无尾缀数字 = 0）。
// 仅在分片转载信号（高重复率 + 尾缀覆盖率 + 键唯一性）三门槛全过时才作为次级排序键，
// 误读面被门槛兜住（标题偶以年份等数字结尾的书不会同时满足高重复率前提）。
var chapterPartSuffixRe = regexp.MustCompile(`([0-9０-９]{1,3})` + jsSpaceClass + `*$`)

// parseChapterNo 解析章节标题中的序号：第N章/节/回/话（阿拉伯含全角或中文数字）、
// 或「123.」「123、」纯数字前缀。解析失败返回 ok=false（序章/番外/未编号等，JS null）。
func parseChapterNo(title string) (int64, bool) {
        n, ok, _ := parseChapterNoPart(title)
        return n, ok
}

// parseChapterNoPart 解析序号 + 章内分片尾号（R124）。分片号仅取「第N章」余部的尾缀数字
//（0 = 无分片语义），供分片转载书（5165 实测同章号 3 分片并列）做次级排序键。
func parseChapterNoPart(title string) (int64, bool, int64) {
        t := trimSpaceStr(title)
        if t == "" {
                return 0, false, 0
        }
        if m := chapterNoRe.FindStringSubmatch(t); m != nil {
                n, ok := chineseNumeralToInt(foldFullwidthDigits(m[1]))
                if ok && n >= 0 && n <= 99_999_999 {
                        return n, true, titlePartSuffix(t)
                }
                return 0, false, 0
        }
        if m := chapterPrefixRe.FindStringSubmatch(t); m != nil {
                return parseInt10(foldFullwidthDigits(m[1])), true, titlePartSuffix(t)
        }
        return 0, false, 0
}

// titlePartSuffix 标题尾缀分片号（无尾缀数字 = 0）
func titlePartSuffix(t string) int64 {
        if m := chapterPartSuffixRe.FindStringSubmatch(t); m != nil {
                return parseInt10(foldFullwidthDigits(m[1]))
        }
        return 0
}

// reorderRefsResult ReorderResult（JS refs/reordered/note 三元组）
type reorderRefsResult struct {
        refs      []ChapterRef
        reordered bool
        note      string
}

// reorderChapterRefs 章节引用乱序重排主入口。传入完整章节引用列表，返回阅读顺序
// 修正后的列表与说明。list 永不为 nil；异常时原样返回保证采集不中断（对齐 TS try/catch）。
func reorderChapterRefs(refs []ChapterRef) (res reorderRefsResult) {
        defer func() {
                // TS: catch → return { refs, reordered:false, note:'' }（Go 无异常路径，防御性兜底）
                if r := recover(); r != nil {
                        res = reorderRefsResult{refs: refs, reordered: false, note: ""}
                }
        }()
        return reorderChapterRefsImpl(refs, DISORDER_RATIO)
}

// reorderChapterRefsForce 强制重排（R86 目录截断修复配套）：忽略 DISORDER_RATIO 位置
// 错乱占比阈值（占 0 即不动），其余判定（章节数/编号数下限、重复序号保守分支）不变。
// 背景：追加式目录补全（骨架按标题增量 upsert）修复截断书后，旧「最新章节块」留在
// 中间仅 1-2% 错位，低于 20% 审计阈值不会被 resort-chapters 命中，需管理员强制重排。
func reorderChapterRefsForce(refs []ChapterRef) (res reorderRefsResult) {
        defer func() {
                if r := recover(); r != nil {
                        res = reorderRefsResult{refs: refs, reordered: false, note: ""}
                }
        }()
        return reorderChapterRefsImpl(refs, 0)
}

// reorderChapterRefsImpl 乱序检测+重排核心；threshold 为位置错乱占比阈值（>threshold 才重排）
func reorderChapterRefsImpl(refs []ChapterRef, threshold float64) reorderRefsResult {
        if len(refs) < NUMBERED_MIN {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}
        }
        nums := make([]numOpt, len(refs))
        for i, r := range refs {
                nums[i] = parseNumOpt(r.Title)
        }
        numberedIdx := make([]int, 0, len(nums))
        for i := range nums {
                if nums[i].ok {
                        numberedIdx = append(numberedIdx, i)
                }
        }
        if len(numberedIdx) < NUMBERED_MIN {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}
        }

        numberedVals := make([]int64, 0, len(numberedIdx))
        for _, i := range numberedIdx {
                numberedVals = append(numberedVals, nums[i].v)
        }
        seenDup := map[int64]bool{}
        hasDup := false
        for _, v := range numberedVals {
                if seenDup[v] {
                        hasDup = true
                        break
                }
                seenDup[v] = true
        }

        if !hasDup {
                ratio := disorderRatio(numberedVals)
                if ratio <= threshold {
                        return reorderRefsResult{refs: refs, reordered: false, note: ""}
                }
                keys := sortKeys(nums)
                type pair struct {
                        r ChapterRef
                        k float64
                }
                ordered := make([]pair, len(refs))
                for i := range refs {
                        ordered[i] = pair{refs[i], keys[i]}
                }
                // 同键保持原序（JS Array.prototype.sort 稳定）→ sort.SliceStable
                sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].k < ordered[b].k })
                out := make([]ChapterRef, len(ordered))
                for i, p := range ordered {
                        out[i] = p.r
                }
                return reorderRefsResult{
                        refs:      out,
                        reordered: true,
                        note:      "检测到章节乱序（位置错乱 " + jsToFixed0(ratio*100) + "%），已按章节序号重排",
                }
        }

        // ---- 重复序号（分卷各自编号场景）：无分卷信息可用，先试噪声容忍路径，
        // 再做保守修复——「头部倒序块」整体后移（最新章节块形态）
        if rr, ok := reorderDupTolerant(refs, nums); ok {
                return rr
        }
        return fixLeadingDescendingBlock(refs, nums)
}

// dupNoiseRatio 序号重复占比（重复行数/编号行数）≤该值视为源站噪声（同章多 URL 收录、
// 站方重复 listing、作者方少量重号——书 564 实测 9988 编号章仅 2 处重复；R124b 书 570
// 实测 1370 编号章 32 处重号=2.34%，为作者方重号噪声而非分卷各自编号），走容忍性全局
// 稳定重排；显著重复（分卷各自编号/拆分转载）不进该路径，由分片键/头部块保守路径兜底。
// 0.03 的标定依据：分卷各自编号书的重号占比签名 ≈(卷数-1)/卷数 ≥50%（6 卷书 580 实测
// 56%），0.03 与该签名保持 16 倍安全边距，误放行面可忽略。
const dupNoiseRatio = 0.03

// canonicalParseRateMin 编号解析率下限：低于该值标题序号不可信，不做容忍性全局重排。
const canonicalParseRateMin = 0.6

// partSuffixCoverageMin 分片尾号覆盖率下限（有尾缀的编号行/编号行）：分片转载书的
// 尾缀应覆盖绝大多数编号行（5165 书 578 实测 208/211）。
const partSuffixCoverageMin = 0.6

// partKeyCollisionMax (章号,分片) 键碰撞行占比上限：超过说明尾缀并非分片语义（随机
// 数字尾缀/年份），整书按该键重排会打散正文，拒绝。
const partKeyCollisionMax = 0.02

// reorderDupTolerant 重复编号场景的两级容忍路径（R124，顺序即优先级）：
//
// ①分片转载键重排 reorderPartKeyRefs：高重复率 + 尾缀覆盖率达标 + (章号,分片) 键
//   基本唯一 → 按（章号, 分片, 出现序）稳定重排（5165《千劫眉》211 行 52 个章号
//   3 分片并列实测 208 键全唯一，DOM 乱序全量归位）。
// ②噪声容忍全局重排 reorderCanonicalNoiseTolerant：重复占比极低（噪声）+ 解析率
//   可信 + 确有位置错乱 → sortKeys 语义（编号主键、未编号锚定前编号之后）全局
//   稳定重排（书 564 形态：[最新块(新→旧)] + [正文(旧→新)] + 少量同号异 URL 噪声，
//   旧 fixLeadingDescendingBlock 因「其余部分严格非降」一行否决整书，阅读页从
//   第13331章 开局；本路径把最新块归位、正文升序、噪声行按出现序相邻）。
//
// 两路径都持有保守门槛（解析率/占比/碰撞率），不满足返回 ok=false 由调用方回退
// 旧保守路径；分卷各自编号书（重复占比高且无分片尾缀）两路径均不进，行为与旧版一致。
func reorderDupTolerant(refs []ChapterRef, nums []numOpt) (reorderRefsResult, bool) {
        if rr, ok := reorderPartKeyRefs(refs, nums); ok {
                return rr, true
        }
        if rr, ok := reorderCanonicalNoiseTolerant(refs, nums); ok {
                return rr, true
        }
        return reorderRefsResult{}, false
}

// reorderPartKeyRefs 分片转载键重排（门槛见 reorderDupTolerant①）
func reorderPartKeyRefs(refs []ChapterRef, nums []numOpt) (reorderRefsResult, bool) {
        if len(refs) < NUMBERED_MIN || len(refs) != len(nums) {
                return reorderRefsResult{}, false
        }
        numbered := 0
        dupRows := 0
        seen := map[int64]int{}
        withPart := 0
        for _, n := range nums {
                if !n.ok {
                        continue
                }
                numbered++
                if n.part > 0 {
                        withPart++
                }
                seen[n.v]++
                if seen[n.v] > 1 {
                        dupRows++
                }
        }
        if numbered < NUMBERED_MIN || float64(dupRows) <= dupNoiseRatio*float64(numbered) {
                return reorderRefsResult{}, false // 重复不显著：非拆分转载形态
        }
        if float64(withPart) < partSuffixCoverageMin*float64(numbered) {
                return reorderRefsResult{}, false
        }
        // 键唯一性：(章号,分片) 重复行占比 ≤ partKeyCollisionMax
        keySeen := map[[2]int64]int{}
        collisions := 0
        for _, n := range nums {
                if !n.ok {
                        continue
                }
                k := [2]int64{n.v, n.part}
                keySeen[k]++
                if keySeen[k] > 1 {
                        collisions++
                }
        }
        if float64(collisions) > partKeyCollisionMax*float64(numbered) {
                return reorderRefsResult{}, false
        }
        // 错乱检测：按（章号,分片）序与当前位序比较，0 错乱则无事可做
        keys := make([]int64, len(refs))
        orderedVals := make([]int64, 0, numbered)
        for i, n := range nums {
                if n.ok {
                        keys[i] = n.v*1000 + n.part
                        orderedVals = append(orderedVals, keys[i])
                }
        }
        if disorderRatio(orderedVals) == 0 {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}, true
        }
        out := stableSortByNumKey(refs, nums, func(n numOpt) float64 { return float64(n.v*1000 + n.part) })
        return reorderRefsResult{
                refs:      out,
                reordered: true,
                note:      fmt.Sprintf("拆分转载形态（%d 编号章 %d 处同章号分片），已按（章号+分片尾号）重排", numbered, dupRows),
        }, true
}

// reorderCanonicalNoiseTolerant 噪声容忍全局重排（门槛见 reorderDupTolerant②）
func reorderCanonicalNoiseTolerant(refs []ChapterRef, nums []numOpt) (reorderRefsResult, bool) {
        if len(refs) < NUMBERED_MIN || len(refs) != len(nums) {
                return reorderRefsResult{}, false
        }
        numbered := 0
        dupRows := 0
        seen := map[int64]bool{}
        vals := make([]int64, 0, len(nums))
        for _, n := range nums {
                if !n.ok {
                        continue
                }
                numbered++
                if seen[n.v] {
                        dupRows++
                }
                seen[n.v] = true
                vals = append(vals, n.v)
        }
        if numbered < NUMBERED_MIN {
                return reorderRefsResult{}, false
        }
        if float64(dupRows) > dupNoiseRatio*float64(numbered) {
                return reorderRefsResult{}, false // 重复显著：非噪声形态（分卷各自编号等）
        }
        if float64(numbered) < canonicalParseRateMin*float64(len(refs)) {
                return reorderRefsResult{}, false // 解析率不足：序号不可信
        }
        if disorderRatio(vals) == 0 {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}, true
        }
        out := stableSortByNumKey(refs, nums, func(n numOpt) float64 { return float64(n.v) })
        return reorderRefsResult{
                refs:      out,
                reordered: true,
                note:      fmt.Sprintf("目录含源站噪声（%d 编号章 %d 处同号重复），已按章节序号全局重排", numbered, dupRows),
        }, true
}

// stableSortByNumKey 按数值键稳定重排（键相同时保持原相对顺序）；未编号行沿用
// sortKeys 语义：锚定前一编号行之后（+0.5 偏移），行间保持原序。
func stableSortByNumKey(refs []ChapterRef, nums []numOpt, keyOf func(numOpt) float64) []ChapterRef {
        keys := make([]float64, len(nums))
        var last int64
        for i, n := range nums {
                if n.ok {
                        last = n.v
                        keys[i] = keyOf(n)
                } else {
                        keys[i] = float64(last) + 0.5
                }
        }
        type pair struct {
                r ChapterRef
                k float64
        }
        ordered := make([]pair, len(refs))
        for i := range refs {
                ordered[i] = pair{refs[i], keys[i]}
        }
        sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].k < ordered[b].k })
        out := make([]ChapterRef, len(ordered))
        for i, p := range ordered {
                out[i] = p.r
        }
        return out
}

// fixLeadingDescendingBlock 保守修复（重复序号且容忍路径均不适用）：头部严格倒序块
// （最新章节新→旧）且其余部分有序 → 块移到尾部升序。
// R124 运行边界修复：倒序块检测在「块尾遇到正文首章」时必须终止——旧判定仅看「严格递减」，
// [13331..13326] 后紧跟 第1章（1 < 13326 仍递减）会把正文首章吞进最新块，搬移后阅读页
// 从 第2章 开局。新增边界：下一编号小于块首（runFirst）即视作正文起点，块到此为止。
func fixLeadingDescendingBlock(refs []ChapterRef, nums []numOpt) reorderRefsResult {
        // 头部倒序块：自首位起连续的编号章节（不夹杂未编号，保守边界）序号严格递减
        k := 0
        blockEnd := 0
        var prev numOpt
        runFirst := int64(0)
        overflow := false
        for i := 0; i < len(nums); i++ {
                n := nums[i]
                if !n.ok {
                        break
                }
                if prev.ok && n.v >= prev.v {
                        break
                }
                // R124：正文起点边界——编号跌幅已超过块自身跨度（runFirst-k）即视作
                // 正文升序段起点（如 [13331..13326] 后遇 第1章：1 < 13331-6），不再
                // 属于「最新章节块」。块内正常递减（每步 -1）恰不触发（n.v = runFirst-k）。
                if k > 0 && n.v < runFirst-int64(k) {
                        break
                }
                if k == 0 {
                        runFirst = n.v
                }
                prev = n
                k++
                blockEnd = i + 1
                if k > 60 { // 最新块通常 ≤ 60 条；超长倒序块按整本倒序处理，不适用本修复
                        overflow = true
                        break
                }
        }
        // 【Task 26-d 修复】溢出必须整体放弃：旧版 break 后仍以截断的 k=61 执行搬移，
        // 头块 >60 条时（如 100 条「最新章节」块）只搬前 61 条，头部残留 39 条倒序段，
        // 重排后反而仍乱（与注释「不适用本修复」的意图相悖）。溢出=整本倒序或超长头块，
        // 保守起见一律原样返回（无重复序号路径的全局重排不受影响）。
        if overflow {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}
        }
        if k < 2 || blockEnd >= len(nums) {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}
        }
        restVals := make([]int64, 0, len(nums)-k)
        for _, n := range nums[k:] {
                if n.ok {
                        restVals = append(restVals, n.v)
                }
        }
        if len(restVals) < NUMBERED_MIN {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}
        }
        // 其余部分必须基本有序（非降）才认定头部块是「最新章节」
        nonDesc := true
        for i := 1; i < len(restVals); i++ {
                if restVals[i] < restVals[i-1] {
                        nonDesc = false
                        break
                }
        }
        if !nonDesc {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}
        }
        // head = refs[0:k].reverse()（新→旧 → 旧→新）；out = refs[k:] + head
        out := make([]ChapterRef, 0, len(refs))
        out = append(out, refs[k:]...)
        for i := k - 1; i >= 0; i-- {
                out = append(out, refs[i])
        }
        return reorderRefsResult{
                refs:      out,
                reordered: true,
                note:      "头部「最新章节」块（" + itoa(k) + " 章，新→旧）已移至目录尾部并按更新顺序排列",
        }
}

// reorderChapterRefsVols 带分卷信息的乱序重排主入口（R101 服务端 API 路径专用；
// 采集管线 TOC 阶段无卷信息，仍走 reorderChapterRefs/reorderRefPairs）。
//
// 完善点（R101）：Task 45-b 起 Chapter.volume 由 detectVolume 落库、存量由
// backfillChapterVolume 幂等回填——「分卷各自编号」书籍（每卷从第1章重计）此前
// hasDup 时只能保守放弃或仅修头部倒序块；现在可用卷字段分段后做段内稳定重排。
//
// 路由语义：
//   - 无重复序号 → 与 reorderChapterRefsImpl 同路径（阈值 threshold 全局稳定重排）；
//   - 有重复序号 → 先试卷内分段重排 volumeSegmentReorder（前置不满足回退
//     fixLeadingDescendingBlock 头部倒序块保守修复）。
//
// threshold 传 DISORDER_RATIO 为常规审计口径；传 0 为强制口径（reorderChapterRefsForce
// 等价语义：位置错乱占比 0 即不动，其余判定不变）。
func reorderChapterRefsVols(refs []ChapterRef, vols []string, threshold float64) (res reorderRefsResult) {
        defer func() {
                if r := recover(); r != nil {
                        res = reorderRefsResult{refs: refs, reordered: false, note: ""}
                }
        }()
        if len(refs) == 0 || len(refs) != len(vols) {
                return reorderChapterRefsImpl(refs, threshold)
        }
        nums := make([]numOpt, len(refs))
        for i, r := range refs {
                nums[i] = parseNumOpt(r.Title)
        }
        numbered := 0
        for i := range nums {
                if nums[i].ok {
                        numbered++
                }
        }
        if numbered < NUMBERED_MIN {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}
        }
        if hasDuplicateNumbering(nums) {
                if rr, engaged := volumeSegmentReorder(refs, vols, nums); engaged {
                        return rr
                }
                if rr, ok := reorderDupTolerant(refs, nums); ok {
                        return rr
                }
                return fixLeadingDescendingBlock(refs, nums)
        }
        return reorderChapterRefsImpl(refs, threshold)
}

// hasDuplicateNumbering 编号章节序号是否存在重复（分卷各自编号的标志信号）
func hasDuplicateNumbering(nums []numOpt) bool {
        seen := map[int64]bool{}
        for _, n := range nums {
                if !n.ok {
                        continue
                }
                if seen[n.v] {
                        return true
                }
                seen[n.v] = true
        }
        return false
}

// splitVolumeSegments 按 volume 落库值切分连续同卷段：卷值变化即分段边界；
// 空卷行归属当前段（书首前导空卷行随首个非空卷同段——卷首楔子/未标卷章节）。
// 全空卷输入返回单段（上层 distinct<2 判定不启用分段重排）。
func splitVolumeSegments(vols []string) [][]int {
        segs := [][]int{}
        cur := []int{}
        curVol := ""
        started := false
        for i, v := range vols {
                if v != "" && v != curVol {
                        if started && len(cur) > 0 {
                                segs = append(segs, cur)
                                cur = []int{}
                        }
                        curVol = v
                        started = true
                }
                cur = append(cur, i)
        }
        if len(cur) > 0 {
                segs = append(segs, cur)
        }
        return segs
}

// volumeSegmentReorder 卷内分段重排（重复序号场景的正确解）：段序保持原样，段内
// 按章节序号稳定排序（未编号章节锚定段内前一编号章节之后，sortKeys 语义段内独立）。
//
// 启用前置（保守，任一不满足即 engaged=false 回退旧路径）：
//   - refs/vols 等长且非空；
//   - ≥2 个不同非空卷（真分卷书）；
//   - 编号章节总数 ≥NUMBERED_MIN，且空卷编号行占比 <10%（卷字段可信度门槛——
//     大量编号章节无卷归属时分段结果不可信）；
//   - 每段至少 1 条编号章节；
//   - 至少一段卷内存在位置错乱（全有序则无事可做，engaged=true reordered=false）。
//
// 返回 engaged=false 表示前置不满足/卷信息缺失，调用方应回退保守修复。
func volumeSegmentReorder(refs []ChapterRef, vols []string, nums []numOpt) (reorderRefsResult, bool) {
        if len(refs) == 0 || len(refs) != len(vols) || len(refs) != len(nums) {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}, false
        }
        distinct := map[string]bool{}
        for _, v := range vols {
                if v != "" {
                        distinct[v] = true
                }
        }
        if len(distinct) < 2 {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}, false
        }
        totalNumbered, emptyNumbered := 0, 0
        for i := range nums {
                if nums[i].ok {
                        totalNumbered++
                        if vols[i] == "" {
                                emptyNumbered++
                        }
                }
        }
        if totalNumbered < NUMBERED_MIN || float64(emptyNumbered) > 0.1*float64(totalNumbered) {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}, false
        }
        segs := splitVolumeSegments(vols)
        if len(segs) < 2 {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}, false
        }
        anyDisorder := false
        for _, seg := range segs {
                hasNumbered := false
                for _, i := range seg {
                        if nums[i].ok {
                                hasNumbered = true
                                break
                        }
                }
                if !hasNumbered {
                        return reorderRefsResult{refs: refs, reordered: false, note: ""}, false
                }
                if !anyDisorder {
                        vals := make([]int64, 0, len(seg))
                        for _, i := range seg {
                                if nums[i].ok {
                                        vals = append(vals, nums[i].v)
                                }
                        }
                        if disorderRatio(vals) > 0 {
                                anyDisorder = true
                        }
                }
        }
        if !anyDisorder {
                return reorderRefsResult{refs: refs, reordered: false, note: ""}, true
        }
        out := make([]ChapterRef, len(refs))
        copy(out, refs)
        for _, seg := range segs {
                keys := make([]float64, len(seg))
                segNums := make([]numOpt, len(seg))
                for j, i := range seg {
                        segNums[j] = nums[i]
                }
                copy(keys, sortKeys(segNums))
                type pair struct {
                        src int
                        k   float64
                }
                ordered := make([]pair, len(seg))
                for j := range seg {
                        ordered[j] = pair{src: j, k: keys[j]}
                }
                sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].k < ordered[b].k })
                sorted := make([]ChapterRef, len(seg))
                for j, p := range ordered {
                        sorted[j] = refs[seg[p.src]]
                }
                for j, r := range sorted {
                        out[seg[j]] = r
                }
        }
        return reorderRefsResult{
                refs:      out,
                reordered: true,
                note:      "分卷重复编号（" + itoa(len(distinct)) + " 卷），已按卷内章节序号重排",
        }, true
}

// reorderChapterRefsForceVols 强制口径 + 卷信息（R101：resort force 单书路径用——
// 追加式补全残留的 1-2% 错位低于审计阈值、分卷书卷内错乱一并强制修正）。
func reorderChapterRefsForceVols(refs []ChapterRef, vols []string) (res reorderRefsResult) {
        defer func() {
                if r := recover(); r != nil {
                        res = reorderRefsResult{refs: refs, reordered: false, note: ""}
                }
        }()
        return reorderChapterRefsVols(refs, vols, 0)
}

// chapterNoAnywhereRe R108 管线适配器专用：中段「第N章/节/回/话」提取（parseChapterNo
// 锚定开头，卷前缀剥除后形如「起步 第3章」的标题解析不到序号）。仅用于 reorderRefPairs
// 的卷内分段重排路径喂 nums——闸门不变（≥2 卷 distinct + ≥8 编号章 + 空卷编号 ≤10% +
// DISORDER_RATIO 阈值），误提取面被卷分段路径的四重前置条件兜住。
var chapterNoAnywhereRe = regexp.MustCompile(`第` + jsSpaceClass + `*([0-9０-９]{1,7}|[零〇一二两三四五六七八九十百千万]{1,12})` + jsSpaceClass + `*[章节回话]`)

// reorderRefPairs refPair 版薄适配（phase1Skeletons 接线点；note 非空 = 已重排）。
// R108（序号排序缺口②统一）：卷信息从标题 detectVolume 就地派生，并把卷前缀从参与
// 重排的标题上剥除（与 storeChapter 落库口径一致：rest 作 title、vol 落 volume 列）。
// 此前带卷前缀的标题（「第一卷 起步 第3章」）因 parseChapterNo 锚定开头无法命中「第N章」，
// 整书退化为无信号不重排；剥除 + 中段序号兜底解析后，分卷书启用卷内分段重排
//（R101 能力此前只在 admin API 路径可用）。
// 路由：标题可解析出重复序号且卷可分（≥2 distinct 卷 + 空卷编号 ≤10%）→ 卷内分段重排；
// 其余（无重复序号/卷不可分）→ reorderChapterRefsVols——空卷退化路径与旧版逐字节一致：
// 无重复序号 → reorderChapterRefsImpl(threshold)；有重复序号且卷不可分 → fixLeadingDescendingBlock。
func reorderRefPairs(pairs []refPair) ([]refPair, string) {
        refs := make([]ChapterRef, len(pairs))
        vols := make([]string, len(pairs))
        for i, p := range pairs {
                vol, rest := detectVolume(p.Title)
                vols[i] = vol
                if vol != "" && rest != p.Title {
                        refs[i] = ChapterRef{Title: rest, URL: p.URL} // 剥卷前缀（纯卷行 rest==原标题不动）
                } else {
                        refs[i] = ChapterRef{Title: p.Title, URL: p.URL}
                }
        }
        // 卷可分 + 重复序号（分卷各自编号的标志信号）→ 卷内分段重排（nums 中段兜底解析）
        if len(refs) >= NUMBERED_MIN && len(refs) == len(vols) {
                nums := make([]numOpt, len(refs))
                numbered, emptyVolNumbered := 0, 0
                for i := range refs {
                        nums[i] = parseNumOptAnywhere(refs[i].Title)
                        if nums[i].ok {
                                numbered++
                                if vols[i] == "" {
                                        emptyVolNumbered++
                                }
                        }
                }
                if hasDuplicateNumbering(nums) && numbered >= NUMBERED_MIN &&
                        float64(emptyVolNumbered) <= 0.1*float64(numbered) &&
                        len(distinctVolCount(vols)) >= 2 {
                        if rr, engaged := volumeSegmentReorder(refs, vols, nums); engaged {
                                out := make([]refPair, len(rr.refs))
                                for i, r := range rr.refs {
                                        out[i] = refPair{Title: r.Title, URL: r.URL}
                                }
                                return out, rr.note
                        }
                }
        }
        rr := reorderChapterRefsVols(refs, vols, DISORDER_RATIO)
        out := make([]refPair, len(rr.refs))
        for i, r := range rr.refs {
                out[i] = refPair{Title: r.Title, URL: r.URL}
        }
        return out, rr.note
}

// parseNumOptAnywhere numOpt 版中段兜底解析
func parseNumOptAnywhere(title string) numOpt {
        v, ok, part := parseChapterNoPart(title)
        if !ok {
                // 中段兜底（「起步 第3章」形态）：序号取中段首个 token；分片尾号取标题尾缀
                if m := chapterNoAnywhereRe.FindStringSubmatch(title); m != nil {
                        n, pok := chineseNumeralToInt(foldFullwidthDigits(m[1]))
                        if pok && n >= 0 && n <= 99_999_999 {
                                return numOpt{ok: true, v: n, part: titlePartSuffix(trimSpaceStr(title))}
                        }
                }
                return numOpt{}
        }
        return numOpt{ok: ok, v: v, part: part}
}

// distinctVolCount 非空卷去重计数辅助
func distinctVolCount(vols []string) map[string]bool {
        distinct := map[string]bool{}
        for _, v := range vols {
                if v != "" {
                        distinct[v] = true
                }
        }
        return distinct
}

// numOpt 可空序号（JS number | null）
type numOpt struct {
        ok   bool
        v    int64
        part int64 // R124 章内分片尾号（0 = 无分片语义）
}

func parseNumOpt(title string) numOpt {
        v, ok, part := parseChapterNoPart(title)
        return numOpt{ok: ok, v: v, part: part}
}

// sortKeys 稳定排序键：编号章节取序号；未编号锚定在前一编号章节之后（0.5 偏移，
// 未编号间保持原序）
func sortKeys(nums []numOpt) []float64 {
        keys := make([]float64, len(nums))
        var last int64
        for i, n := range nums {
                if n.ok {
                        last = n.v
                        keys[i] = float64(n.v)
                } else {
                        keys[i] = float64(last) + 0.5
                }
        }
        return keys
}

// disorderRatio 位置错乱占比：与升序排序后的序列逐位比较，不同位 / 总数
func disorderRatio(nums []int64) float64 {
        if len(nums) == 0 {
                return 0
        }
        sorted := append([]int64(nil), nums...)
        sort.Slice(sorted, func(a, b int) bool { return sorted[a] < sorted[b] })
        mismatch := 0
        for i := range nums {
                if nums[i] != sorted[i] {
                        mismatch++
                }
        }
        return float64(mismatch) / float64(len(nums))
}

// jsToFixed0 JS (x).toFixed(0)（非负 x：四舍五入，并列取大 = floor(x+0.5)）
func jsToFixed0(x float64) string {
        return itoa(int(x + 0.5))
}
