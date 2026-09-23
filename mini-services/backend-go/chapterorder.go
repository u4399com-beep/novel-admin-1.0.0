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
 * 消费方：/api/novels/resort-chapters（存量目录重排，api_noveltools.go）；
 * worker 管线的目录乱序处理由 engineclient/worker 内联实现（同源 TS 逻辑），此处不接。
 */
package main

import (
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

// chapterNoRe 第N章/节/回/话（阿拉伯 1-7 位或中文数字 1-12 位）
var chapterNoRe = regexp.MustCompile(`^第` + jsSpaceClass + `*([0-9]{1,7}|[零〇一二两三四五六七八九十百千万]{1,12})` + jsSpaceClass + `*[章节回话]`)

// chapterPrefixRe 「123.」「123、」「123:」纯数字前缀（后跟非空白内容）
var chapterPrefixRe = regexp.MustCompile(`^([0-9]{1,5})[.、:：]` + jsSpaceClass + `*\S`)

// parseChapterNo 解析章节标题中的序号：第N章/节/回/话（阿拉伯或中文数字）、
// 或「123.」「123、」纯数字前缀。解析失败返回 ok=false（序章/番外/未编号等，JS null）。
func parseChapterNo(title string) (int64, bool) {
	t := trimSpaceStr(title)
	if t == "" {
		return 0, false
	}
	if m := chapterNoRe.FindStringSubmatch(t); m != nil {
		n, ok := chineseNumeralToInt(m[1])
		if ok && n >= 0 && n <= 99_999_999 {
			return n, true
		}
		return 0, false
	}
	if m := chapterPrefixRe.FindStringSubmatch(t); m != nil {
		return parseInt10(m[1]), true
	}
	return 0, false
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
	return reorderChapterRefsImpl(refs)
}

func reorderChapterRefsImpl(refs []ChapterRef) reorderRefsResult {
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
		if ratio <= DISORDER_RATIO {
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

	// ---- 重复序号（分卷各自编号场景）：无分卷信息可用，只做保守修复——
	// 「头部倒序块」整体后移（最新章节块形态）
	return fixLeadingDescendingBlock(refs, nums)
}

// fixLeadingDescendingBlock 保守修复（重复序号且无分卷信息可用）：头部严格倒序块
// （最新章节新→旧）且其余部分有序 → 块移到尾部升序。
func fixLeadingDescendingBlock(refs []ChapterRef, nums []numOpt) reorderRefsResult {
	// 头部倒序块：自首位起连续的编号章节（不夹杂未编号，保守边界）序号严格递减
	k := 0
	blockEnd := 0
	var prev numOpt
	overflow := false
	for i := 0; i < len(nums); i++ {
		n := nums[i]
		if !n.ok {
			break
		}
		if prev.ok && n.v >= prev.v {
			break
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

// numOpt 可空序号（JS number | null）
type numOpt struct {
	ok bool
	v  int64
}

func parseNumOpt(title string) numOpt {
	v, ok := parseChapterNo(title)
	return numOpt{ok: ok, v: v}
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
