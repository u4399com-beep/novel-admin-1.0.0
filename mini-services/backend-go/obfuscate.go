/**
 * obfuscate.go —— 渲染层对抗（Task 45-a）：renderPage 出口后置处理的唯一权威实现。
 *
 * 三项特性（SEO/防判定，用户明确要求默认生效）：
 *   A. 页面结构混淆（每页唯一）：随机 HTML 注释指纹（3-6 条，安全锚点）+ body 随机
 *      data-* 指纹属性——同一 URL 两次请求源码结构不同（多态输出），外观/交互零变化。
 *   B. 关键词/句子转码：长内容段随机字符实体化（&#NNNN; 十进制 / &#xHHHH; 十六进制
 *      随机混选）+ U+200B 零宽字符注入——源码 raw 层不再连续明文（规避关键词判定
 *      审核），浏览器解码渲染后与原文完全同形（搜索引擎索引同样解码还原）。
 *   C. 句子内容干扰：长文本段落尾部注入视觉零影响噪声元素（font-size:0 + 绝对定位
 *      屏外 + aria-hidden；不用 display:none 以降低反作弊信号强度）。
 *
 * 安全边界（绝不破坏，obfuscate_test.go 全量锁定）：
 *   1. 不改写 class/id——主题 JS（trxsw.js 等 10 套）全部依赖 querySelector/
 *      getElementById 类名/id 钩子；
 *   2. 不改变 DOM 结构——不加任何包裹层；噪声 <i> 仅作为 p/h1-h6/dd/dt「纯文本型
 *      叶子容器」的尾子元素插入，CSS 后代选择器语义不变；绝对定位脱离文档流，对
 *      Tailwind space-y-* 与 :last-child 等位置敏感样式零影响；li/div/td 等容器明确
 *      排除（主题 JS 对列表容器做 .children 遍历，huanjinwu.js 对正文 p 做
 *      querySelectorAll('p')——p 自身数量与位置不变，仅其内部多一个不可见子元素）；
 *   3. <script>/<style>/<textarea> 内容逐字节透传（JS/CSS/表单值不容变换）；既有
 *      HTML 注释、DOCTYPE 原样保留；
 *   4. 文本变换只作用于「> 与 < 之间」且 ≥12 rune 的非空白内容段——短 UI 文本
 *      （按钮「书架」/导航/字数标注）零变化；属性值（meta description/input value/
 *      data-* 钩子）不在文本段定义内，天然不碰；
 *   5. 幂等安全：变换只依赖本次随机种子（每页 crypto/rand 新种子），不依赖输入是否
 *      已变换——生产输入恒为模板新鲜输出，重复渲染产生「每页随机」而非累积损坏
 *      （实体序列全 ASCII、零宽只落非 ASCII 边界，重入不二次损坏）；
 *   6. 零宽字符只插入「前后均为非 ASCII rune」的位置——&amp;/&#39; 等既有实体序列
 *      全由 ASCII 组成，天然避开，解码后 U+200B 恒位于两个内容字符之间。
 *
 * 配置：seoConfig JSON 顶层 4 键（api_settings.go sanitizeSeoConfig 白名单，默认全开），
 * GET /api/settings "seo" 对象透出、PATCH seo 合并写回；SSR 侧 10s TTL 缓存
 * （loadObfConfig），设置变更最迟 10s 全站生效；admin 页跳过（robots Disallow，
 * admin.js 强依赖 DOM 形态，无对抗需求）。
 */
package main

import (
	crand "crypto/rand"
	"database/sql"
	"encoding/binary"
	"log"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// ==================== 配置 ====================

// obfConfig 对抗模式配置（键与 seoConfig 白名单一致）
type obfConfig struct {
	Enable      bool // 总开关
	EncodeRatio int  // 实体化比例 0-100（同时线性控制干扰/零宽强度）
	ZeroWidth   bool // 零宽字符注入开关
	Noise       bool // 干扰元素插入开关
}

// defaultObfConfig 默认全开（用户明确要求生效）；比例 40（落在任务要求的 20%-60% 区间）
func defaultObfConfig() obfConfig {
	return obfConfig{Enable: true, EncodeRatio: obfuscateEncodeRatioDefault, ZeroWidth: true, Noise: true}
}

// obfConfigFromSeo 从 sanitizeSeoConfig 白名单产物提取对抗配置（键缺失/类型不符 = 默认值）
func obfConfigFromSeo(m map[string]any) obfConfig {
	cfg := defaultObfConfig()
	if m == nil {
		return cfg
	}
	if b, ok := m["obfuscateEnable"].(bool); ok {
		cfg.Enable = b
	}
	switch v := m["obfuscateEncodeRatio"].(type) {
	case float64:
		cfg.EncodeRatio = clampInt(int(v), 0, 100)
	case int:
		cfg.EncodeRatio = clampInt(v, 0, 100)
	case int64:
		cfg.EncodeRatio = clampInt(int(v), 0, 100)
	}
	if b, ok := m["obfuscateZeroWidth"].(bool); ok {
		cfg.ZeroWidth = b
	}
	if b, ok := m["obfuscateNoise"].(bool); ok {
		cfg.Noise = b
	}
	return cfg
}

// loadObfConfig SSR 每页调用的配置载入（10s TTL 缓存：设置变更最迟 10s 生效，
// 页面渲染零额外 DB 压力）；查询失败 fail-open 回落默认全开（与出厂语义一致）
var (
	obfCfgMu    sync.Mutex
	obfCfgCache obfConfig
	obfCfgAt    time.Time
)

func loadObfConfig() obfConfig {
	obfCfgMu.Lock()
	defer obfCfgMu.Unlock()
	if !obfCfgAt.IsZero() && time.Since(obfCfgAt) < 10*time.Second {
		return obfCfgCache
	}
	cfg := defaultObfConfig()
	var blob sql.NullString
	if err := queryOne(`SELECT "seoConfig" FROM "SiteSetting" WHERE "id" = 1`, []any{&blob}); err == nil {
		cfg = obfConfigFromSeo(sanitizeSeoConfig(safeParseJSONBlob(blob)))
	}
	obfCfgCache = cfg
	obfCfgAt = time.Now()
	return cfg
}

// newObfSeed 每页渲染新种子（crypto/rand 8 字节摘要；失败回落纳秒时钟）——
// 页页不同种子 ⇒ 页页不同指纹/转码位（多态输出的根源）
func newObfSeed() int64 {
	var b [8]byte
	if _, err := crand.Read(b[:]); err == nil {
		return int64(binary.LittleEndian.Uint64(b[:]) & 0x7fffffffffffffff)
	}
	return time.Now().UnixNano()
}

// obfMaybe renderPage 出口唯一接线点：admin 后台页跳过；任何 panic 兜底回原文输出
// （对抗层故障绝不影响页面可用性）
func obfMaybe(src, page string) (out string) {
	out = src
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[obf] panic 已兜底（原文输出）page=%s: %v", page, r)
			out = src
		}
	}()
	if page == "admin" {
		return src
	}
	cfg := loadObfConfig()
	if !cfg.Enable {
		return src
	}
	return obfuscatePageHTML(src, cfg, newObfSeed())
}

// ==================== 常量与字符池 ====================

const (
	obfMinTextRunes = 12       // 文本段参与变换的最小 rune 数（短 UI 文本不碰）
	obfNoiseCap     = 16       // 每页干扰元素上限（防极端长页噪声占比失控）
	obfZeroW        = '\u200b' // U+200B ZERO WIDTH SPACE（显式转义，源码不藏不可见字符）
)

// obfNoiseTargets 干扰元素允许插入的闭合标签白名单：纯文本型叶子容器
// （p/h1-h6/dd/dt；排除 li/div/td 等列表与布局容器——主题 JS 对列表容器做 .children
// 遍历、Tailwind space-y-* 对直接子元素做位置样式，一律不碰）
var obfNoiseTargets = map[string]bool{
	"p": true, "h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
	"dd": true, "dt": true,
}

// obfProtectedContent 内容保护块：逐字节透传（JS/CSS/表单值不容任何变换）
var obfProtectedContent = map[string]bool{
	"script": true, "style": true, "textarea": true,
}

// obfCommentAnchors 注释指纹候选锚点（安全位置：元素边界间/head 内，绝不落入标签内部；
// before = 闭标签前，after = 开/闭标签后）。任何主题缺失某锚点时由 flushComments 收尾补齐
var obfCommentAnchors = []string{
	"head-close", "body-close", "html-close", // before
	"body-open", "header-close", "nav-close", "main-close", "footer-close", // after
}

var obfAnchorBefore = map[string]bool{
	"head-close": true, "body-close": true, "html-close": true,
}

const obfHexDigits = "0123456789abcdef"
const obfLowerLetters = "abcdefghijklmnopqrstuvwxyz"
const obfLowerAlnum = "abcdefghijklmnopqrstuvwxyz0123456789"

// obfNoiseWords2 / obfNoiseSingles 干扰噪声词池（2 字词 + 单字，随机拼 3-8 字噪声词）
var obfNoiseWords2 = []string{
	"风云", "天地", "山河", "岁月", "星辰", "江湖", "尘世", "流光", "苍穹", "云海",
	"孤城", "旧梦", "长歌", "归途", "浮生", "墨色", "晚风", "灯火", "山野", "星空",
	"落叶", "飞雪", "听雨", "折柳", "观棋", "煮酒", "寻梅", "踏歌", "望月", "临江",
	"疏影", "暗香", "平湖", "秋月", "清欢", "余晖", "远山", "近水", "残阳", "晓雾",
}

const obfNoiseSingles = "风花雪月诗酒茶山水云天光影音书剑琴棋雾岚烟霞"

// ==================== 主扫描器 ====================

// obfState 单页渲染的变换状态（种子派生 RNG + 注释计划 + 噪声计数）
type obfState struct {
	cfg            obfConfig
	rnd            *rand.Rand
	beforeComments map[string][]string
	afterComments  map[string][]string
	planned        int
	emitted        int
	noiseCount     int
}

// obfuscatePageHTML 单遍扫描后置处理：
//   - 文本段（> 与 < 之间，≥12 rune 非空白）→ 零宽注入 + 字符实体化；
//   - <script>/<style>/<textarea> 内容与既有注释/DOCTYPE → 逐字节透传；
//   - <body> 开标签 → 随机 data-* 指纹属性；
//   - 计划锚点 → 随机注释指纹（3-6 条）；
//   - 长文本段紧邻的 p/h1-h6/dd/dt 闭合标签前 → 随机噪声元素（概率受 EncodeRatio 控制）。
func obfuscatePageHTML(src string, cfg obfConfig, seed int64) string {
	if !cfg.Enable {
		return src
	}
	st := &obfState{cfg: cfg, rnd: rand.New(rand.NewSource(seed))}
	st.planComments()

	var b strings.Builder
	b.Grow(len(src) + 2048)
	i, n := 0, len(src)
	lastTextRunes := 0 // 紧邻当前标签的上一文本段 rune 数（空白段/任何标签后归零）
	for i < n {
		// —— 文本段（'>' 与 '<' 之间的内容）——
		lt := strings.IndexByte(src[i:], '<')
		if lt < 0 {
			b.WriteString(st.transformText(src[i:]))
			break
		}
		if lt > 0 {
			seg := src[i : i+lt]
			b.WriteString(st.transformText(seg))
			if trimSpaceStr(seg) == "" {
				lastTextRunes = 0
			} else {
				lastTextRunes = runeLen(seg)
			}
			i += lt
		}
		// —— 既有注释：原样保留（含其内一切字符）——
		if strings.HasPrefix(src[i:], "<!--") {
			rel := strings.Index(src[i+4:], "-->")
			if rel < 0 {
				b.WriteString(src[i:]) // 未闭合注释：与浏览器一致透传到 EOF
				break
			}
			end := i + 4 + rel + 3
			b.WriteString(src[i:end])
			i = end
			continue
		}
		// —— DOCTYPE / 处理指令：原样保留 ——
		if strings.HasPrefix(src[i:], "<!") || strings.HasPrefix(src[i:], "<?") {
			gt := strings.IndexByte(src[i:], '>')
			if gt < 0 {
				b.WriteString(src[i:])
				break
			}
			b.WriteString(src[i : i+gt+1])
			i += gt + 1
			continue
		}
		// —— 标签 ——
		tagEnd := obfTagEnd(src, i)
		if tagEnd < 0 {
			b.WriteString(src[i:]) // 容错：残缺标签整体透传（html/template 输出不会走到）
			break
		}
		tag := src[i:tagEnd]
		name := obfTagName(tag)
		if name == "" {
			b.WriteString(tag)
			i = tagEnd
			lastTextRunes = 0
			continue
		}
		if len(tag) > 1 && tag[1] == '/' {
			// 闭合标签：干扰插入（长文本段紧邻的文本容器）+ 注释指纹
			if cfg.Noise && obfNoiseTargets[name] && lastTextRunes >= obfMinTextRunes &&
				st.noiseCount < obfNoiseCap && st.rnd.Float64() < st.noiseChance() {
				b.WriteString(st.noiseElement())
			}
			b.WriteString(st.commentsBefore(name + "-close"))
			b.WriteString(tag)
			b.WriteString(st.commentsAfter(name + "-close"))
		} else {
			// 开标签：body 注入随机 data-* 指纹；保护块内容逐字节透传
			if name == "body" {
				b.WriteString(st.injectDataAttrs(tag))
				b.WriteString(st.commentsAfter("body-open"))
			} else {
				b.WriteString(tag)
			}
			if obfProtectedContent[name] && !strings.HasSuffix(tag, "/>") {
				rel := obfFindClosing(src[tagEnd:], name)
				if rel < 0 {
					b.WriteString(src[tagEnd:])
					break
				}
				b.WriteString(src[tagEnd : tagEnd+rel])
				i = tagEnd + rel
				lastTextRunes = 0
				continue // i 已指向 </name>，下轮按普通闭标签解析
			}
		}
		lastTextRunes = 0
		i = tagEnd
	}
	b.WriteString(st.flushComments())
	return b.String()
}

// obfTagEnd 返回标签 '>' 之后的位置（引号内 '>' 容错——html/template 属性值已转义，
// 此处理仅防御模板手写字面量）；未找到返回 -1
func obfTagEnd(src string, start int) int {
	q := byte(0)
	for j := start + 1; j < len(src); j++ {
		c := src[j]
		if q != 0 {
			if c == q {
				q = 0
			}
			continue
		}
		switch c {
		case '"', '\'':
			q = c
		case '>':
			return j + 1
		}
	}
	return -1
}

// obfTagName 提取标签名（小写；注释/DOCTYPE/残缺返回空串）
func obfTagName(tag string) string {
	i := 1
	if i < len(tag) && tag[i] == '/' {
		i++
	}
	j := i
	for j < len(tag) && (tag[j] >= 'a' && tag[j] <= 'z' || tag[j] >= 'A' && tag[j] <= 'Z' || tag[j] >= '0' && tag[j] <= '9') {
		j++
	}
	if j == i {
		return ""
	}
	return strings.ToLower(tag[i:j])
}

// obfFindClosing 在 s 中查找不区分大小写的闭合标签前缀（如 </script），返回起始下标。
// 与浏览器 HTML 解析口径一致（script 内出现字面 </script 亦会提前闭合）
func obfFindClosing(s, lowerName string) int {
	needle := "</" + lowerName
	for i := 0; i+len(needle) <= len(s); i++ {
		if s[i] == '<' && equalFoldStr(s[i:i+len(needle)], needle) {
			return i
		}
	}
	return -1
}

// ==================== 变换器 B：文本段转码 ====================

// transformText 长内容段变换：零宽注入（先做，保证 U+200B 只落非 ASCII 边界）
// + 字符实体化（跳过全部 ASCII——既有实体序列 &amp;/&#39; 天然避开）。短段/空白段原样。
func (st *obfState) transformText(seg string) string {
	if runeLen(seg) < obfMinTextRunes || trimSpaceStr(seg) == "" {
		return seg
	}
	runes := []rune(seg)
	if st.cfg.ZeroWidth {
		runes = obfInjectZeroWidth(runes, st.rnd)
	}
	out := string(runes)
	if st.cfg.EncodeRatio > 0 {
		out = obfEncodeRunes(out, st.cfg.EncodeRatio, st.rnd)
	}
	if out == seg {
		return seg
	}
	return out
}

// obfInjectZeroWidth 随机位置注入 U+200B（每 8-16 rune 一个；仅插入「前后均为非 ASCII
// rune」的边界，永不拆散实体序列/不邻接已有零宽）。textContent 变化，渲染不显示。
func obfInjectZeroWidth(runes []rune, rnd *rand.Rand) []rune {
	out := make([]rune, 0, len(runes)+len(runes)/8+1)
	gap := 8 + rnd.Intn(9)
	since := 0
	for i, r := range runes {
		out = append(out, r)
		since++
		if since >= gap && i+1 < len(runes) &&
			r >= 0x80 && r != obfZeroW && runes[i+1] >= 0x80 && runes[i+1] != obfZeroW {
			out = append(out, obfZeroW)
			since = 0
			gap = 8 + rnd.Intn(9)
		}
	}
	return out
}

// obfEncodeRunes 字符实体化：按 ratio/100 概率把汉字/非 ASCII 字母随机转 &#NNNN;（十进制）
// 或 &#xHHHH;（十六进制），两种进制随机混选；ASCII 一律不动（既有实体序列全 ASCII，
// 天然避开——绝不产生 &#38;amp; 类二次编码）。渲染解码后同形。
func obfEncodeRunes(s string, ratio int, rnd *rand.Rand) string {
	p := float64(ratio) / 100.0
	if p <= 0 {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + len(s)/4)
	changed := false
	for _, r := range s {
		if obfEncodeEligible(r) && rnd.Float64() < p {
			if rnd.Intn(2) == 0 {
				b.WriteString("&#")
				b.WriteString(strconv.Itoa(int(r)))
				b.WriteByte(';')
			} else {
				b.WriteString("&#x")
				b.WriteString(strconv.FormatInt(int64(r), 16))
				b.WriteByte(';')
			}
			changed = true
			continue
		}
		b.WriteRune(r)
	}
	if !changed {
		return s
	}
	return b.String()
}

// obfEncodeEligible 实体化目标字符：非 ASCII 的汉字/字母（U+200B、CJK 标点、数字、
// ASCII 全部跳过——保持文本骨架可读性与实体边界安全）
func obfEncodeEligible(r rune) bool {
	if r < 0x80 || r == obfZeroW {
		return false
	}
	return unicode.Is(unicode.Han, r) || unicode.IsLetter(r)
}

// ==================== 变换器 C：干扰元素 ====================

// noiseChance 干扰插入概率随 EncodeRatio 线性变化（0→0.05，100→0.50；默认 40→0.23）
func (st *obfState) noiseChance() float64 {
	return 0.05 + 0.45*float64(st.cfg.EncodeRatio)/100.0
}

const obfNoiseStyle = "font-size:0;line-height:0;position:absolute;left:-9999px"

// noiseElement 视觉零影响噪声元素：绝对定位屏外 + 零字号 + aria-hidden
// （不用 display:none——降低反作弊信号强度）
func (st *obfState) noiseElement() string {
	st.noiseCount++
	return `<i style="` + obfNoiseStyle + `" aria-hidden="true">` + st.noiseWord() + `</i>`
}

// noiseWord 随机 3-8 字噪声词（2 字词池 + 单字池随机拼装，长度钳在 3-8）
func (st *obfState) noiseWord() string {
	target := 3 + st.rnd.Intn(6)
	singles := []rune(obfNoiseSingles)
	var b strings.Builder
	cur := 0
	for cur < target {
		if cur+2 <= 8 && st.rnd.Intn(3) != 0 {
			b.WriteString(obfNoiseWords2[st.rnd.Intn(len(obfNoiseWords2))])
			cur += 2
		} else {
			b.WriteRune(singles[st.rnd.Intn(len(singles))])
			cur++
		}
	}
	return b.String()
}

// ==================== 变换器 A：页面结构指纹 ====================

// planComments 随机挑选 3-6 个锚点各分配一条注释指纹（锚点缺失时由 flushComments 收尾）
func (st *obfState) planComments() {
	st.beforeComments = map[string][]string{}
	st.afterComments = map[string][]string{}
	k := 3 + st.rnd.Intn(4) // 3-6 条
	anchors := append([]string(nil), obfCommentAnchors...)
	st.rnd.Shuffle(len(anchors), func(a, b2 int) { anchors[a], anchors[b2] = anchors[b2], anchors[a] })
	for idx := 0; idx < k; idx++ {
		anchor := anchors[idx%len(anchors)]
		c := st.comment()
		if obfAnchorBefore[anchor] {
			st.beforeComments[anchor] = append(st.beforeComments[anchor], c)
		} else {
			st.afterComments[anchor] = append(st.afterComments[anchor], c)
		}
	}
	st.planned = k
}

func (st *obfState) commentsBefore(anchor string) string {
	cs, ok := st.beforeComments[anchor]
	if !ok || len(cs) == 0 {
		return ""
	}
	delete(st.beforeComments, anchor)
	st.emitted += len(cs)
	return strings.Join(cs, "")
}

func (st *obfState) commentsAfter(anchor string) string {
	cs, ok := st.afterComments[anchor]
	if !ok || len(cs) == 0 {
		return ""
	}
	delete(st.afterComments, anchor)
	st.emitted += len(cs)
	return strings.Join(cs, "")
}

// flushComments 计划锚点在页面中不存在时的收尾补齐（保证 3-6 条总量）
func (st *obfState) flushComments() string {
	remaining := st.planned - st.emitted
	if remaining <= 0 {
		return ""
	}
	var b strings.Builder
	for j := 0; j < remaining; j++ {
		b.WriteString(st.comment())
	}
	return b.String()
}

// comment 随机指纹注释：<!-- o:{hex8-12}.{hex4-8} -->（内部无 --，合法且唯一）
func (st *obfState) comment() string {
	a := obfRandStr(st.rnd, 8+st.rnd.Intn(5), obfHexDigits)
	b2 := obfRandStr(st.rnd, 4+st.rnd.Intn(5), obfHexDigits)
	return "<!-- o:" + a + "." + b2 + " -->"
}

// injectDataAttrs body 开标签追加 1-2 个随机名随机值 data-* 指纹属性（data- 前缀不参与
// 任何样式与既有 JS 钩子；名字生成后校验不与标签内既有属性重名）
func (st *obfState) injectDataAttrs(tag string) string {
	n := 1 + st.rnd.Intn(2)
	ins := make([]string, 0, n)
	for j := 0; j < n; j++ {
		name := ""
		for t := 0; t < 5; t++ {
			name = "data-" + obfRandStr(st.rnd, 1, obfLowerLetters) + obfRandStr(st.rnd, 3+st.rnd.Intn(3), obfLowerAlnum)
			if !strings.Contains(tag, name) {
				break
			}
			name = ""
		}
		if name == "" {
			continue
		}
		ins = append(ins, " "+name+"=\""+obfRandStr(st.rnd, 10+st.rnd.Intn(5), obfHexDigits)+"\"")
	}
	if len(ins) == 0 {
		return tag
	}
	attrs := strings.Join(ins, "")
	if strings.HasSuffix(tag, "/>") {
		return tag[:len(tag)-2] + attrs + "/>"
	}
	return tag[:len(tag)-1] + attrs + ">"
}

// obfRandStr 从 charset 随机取 n 个字符
func obfRandStr(rnd *rand.Rand, n int, charset string) string {
	b := make([]byte, n)
	for j := range b {
		b[j] = charset[rnd.Intn(len(charset))]
	}
	return string(b)
}
