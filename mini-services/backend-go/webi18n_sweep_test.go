/**
 * webi18n_sweep_test.go —— R164 渲染出口 CJK 清扫管线回归锁定（全部封网：
 * 绝不依赖 translate-service 真实上游）：
 *   1. i18nSweepScan：文本节点提取 golden——script/style/pre/code/textarea 整体
 *      跳过（JS 内伪标签/注释不误读）、HTML 注释跳过、引号内 '>' 不终止标签、
 *      DOCTYPE/自闭合正常消费、闭合标签本体不产段
 *   2. sweepHasHan：汉字判定（纯拉丁/数字/标点拒绝）
 *   3. i18nSweepHTML zh-CN 直通零变更
 *   4. 缓存命中替换：文本节点替换、属性值/script/注释不可达、同原文多区间全替换、
 *      实体 Unescape 对齐（&#34; 段与数据面原始文本同缓存键）、空白边缘保留
 *   5. zh-Hant 缓存命中替换（同步补译上游不可达时优雅降级原文）
 *   6. en 未命中 flightBase="" 不入队不变更（渲染路径零上游语义）
 *   7. R164b 可见属性白名单（placeholder/alt/title/aria-label 入面；
 *      href/src/value/data-* 功能属性不可达）
 *   8. sweepFlightHash 稳定性
 * 复用 recover_test.go TestMain 临时库（绝不触碰生产 db/custom.db）。
 */
package main

import (
	"strings"
	"testing"
)

// sweepSegText 取区间文本（测试辅助）
func sweepSegText(s string, sg sweepSeg) string { return s[sg.start:sg.end] }

func TestI18nSweepScan(t *testing.T) {
	src := `<html lang="zh-CN"><head><title>青阅文学</title>` +
		`<meta name="a" content="x>y 的值"><script>var s = "</div> 在 JS 里"; var j={"k":"中文"}</script>` +
		`</head><body><!-- 注释里的中文 --><p class="btn">首页</p>` +
		`<pre>代码 里的 中文</pre><style>.a{content:"样式中文"}</style>` +
		`<textarea>表单里的 中文</textarea><code>var x = 1 代码</code>` +
		`<span>玄幻</span><br/><img src="/x.png" alt="封面"/>末尾文本</body></html>`
	segs := i18nSweepScan(src)
	texts := make([]string, 0, len(segs))
	for _, sg := range segs {
		texts = append(texts, sweepSegText(src, sg))
	}
	got := strings.Join(texts, "|")
	// 应出现的文本节点
	for _, want := range []string{"青阅文学", "首页", "玄幻", "末尾文本"} {
		if !strings.Contains(got, want) {
			t.Fatalf("扫描结果缺文本节点 %q: %v", want, texts)
		}
	}
	// R164b: 白名单可见属性值入面（alt="封面" 应收集）
	if !strings.Contains(got, "封面") {
		t.Fatalf("alt 可见属性值应入清扫面: %v", texts)
	}
	// 绝不应出现（skip 标签/注释/功能属性/非白名单属性）
	for _, banned := range []string{"在 JS 里", "注释里的中文", "代码 里的 中文", "样式中文", "表单里的 中文", "var x = 1", "x>y 的值"} {
		if strings.Contains(got, banned) {
			t.Fatalf("扫描误入禁区 %q: %v", banned, texts)
		}
	}
}

func TestI18nSweepScanUnclosedSkipTag(t *testing.T) {
	// 未闭合 script：其后所有内容（含伪标签）不再产段
	src := `<p>开头</p><script>var a = 1; if (a < 2) {}`
	segs := i18nSweepScan(src)
	if len(segs) != 1 {
		t.Fatalf("未闭合 script 后不产段, got %v", segs)
	}
	if sweepSegText(src, segs[0]) != "开头" {
		t.Fatalf("唯一段应为开头: %q", sweepSegText(src, segs[0]))
	}
}

func TestI18nSweepAttrsWhitelist(t *testing.T) {
	src := `<a href="/search?kw=玄幻" title="悬停提示">链接文本</a>` +
		`<img src="/x.png" alt="图裂说明" data-tip="数据属性不翻" aria-label="读屏标签">` +
		`<input value="表单值不翻" placeholder="占位提示">`
	segs := i18nSweepScan(src)
	vals := make([]string, 0, len(segs))
	for _, sg := range segs {
		vals = append(vals, sweepSegText(src, sg))
	}
	got := strings.Join(vals, "|")
	for _, want := range []string{"悬停提示", "图裂说明", "读屏标签", "占位提示", "链接文本"} {
		if !strings.Contains(got, want) {
			t.Fatalf("白名单可见属性应收集 %q: %v", want, vals)
		}
	}
	for _, banned := range []string{"kw=玄幻", "数据属性不翻", "表单值不翻", "/x.png"} {
		if strings.Contains(got, banned) {
			t.Fatalf("功能/非白名单属性必须不可达 %q: %v", banned, vals)
		}
	}
}

func TestSweepHasHan(t *testing.T) {
	for _, s := range []string{"首页", "玄幻·X", "91.8万字", "Ｔ漢字"} {
		if !sweepHasHan(s) {
			t.Fatalf("%q 应含汉字", s)
		}
	}
	for _, s := range []string{"Home", "91.8k", "...", "", "あいうえお", "한국어"} {
		if sweepHasHan(s) {
			t.Fatalf("%q 不应判含汉字（纯假名/谚文/拉丁不送翻）", s)
		}
	}
}

func TestI18nSweepHTMLZhCNPassthrough(t *testing.T) {
	src := "<p>首页</p><span>玄幻</span>"
	if got := i18nSweepHTML("zh-CN", "pg|home", 0, src); got != src {
		t.Fatalf("zh-CN 必须零变更直通: %q", got)
	}
	if got := i18nSweepHTML("", "pg|home", 0, src); got != src {
		t.Fatalf("空语种必须零变更直通")
	}
}

func TestI18nSweepHTMLCacheHitReplace(t *testing.T) {
	mustInitTranslationCacheTable(t)
	db, err := getDB()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	// 两段预插 en 缓存（translatewarm 预热形态）
	seeds := map[string]string{"首页": "Home", "玄幻": "Fantasy"}
	for src, tr := range seeds {
		if _, err := db.Exec(`INSERT OR REPLACE INTO "TranslationCache" ("key","target","content","novelId","createdAt") VALUES (?,?,?,0,?)`,
			translateCacheKey(src, "en"), "en", tr, nowMillis()); err != nil {
			t.Fatalf("seed cache: %v", err)
		}
	}
	src := `<nav><a href="/">首页</a><a href="/category/1">玄幻</a></nav>` +
		`<script>var keep = "首页";</script><img alt="首页">` +
		`<span title="t">首页</span>`
	got := i18nSweepHTML("en", "", 0, src)
	// 文本节点替换
	if !strings.Contains(got, `<a href="/">Home</a>`) || !strings.Contains(got, `Fantasy</a>`) {
		t.Fatalf("文本节点应替换: %s", got)
	}
	// 功能属性不可达（href 原样）；白名单可见属性 alt 入面替换
	if !strings.Contains(got, `href="/"`) {
		t.Fatalf("href 必须不可达: %s", got)
	}
	if !strings.Contains(got, `alt="Home"`) {
		t.Fatalf("alt 可见属性应替换: %s", got)
	}
	// script 内不可达
	if !strings.Contains(got, `var keep = "首页";`) {
		t.Fatalf("script 内容必须不可达: %s", got)
	}
	// 同原文多区间（首页 ×2 文本节点：<a> 与 <span> 全替换）
	if n := strings.Count(got, ">Home<"); n != 2 {
		t.Fatalf("两处文本节点都应替换（got %d 处 Home）: %s", n, got)
	}
}

func TestI18nSweepHTMLEntityAndWhitespace(t *testing.T) {
	mustInitTranslationCacheTable(t)
	db, err := getDB()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	// 数据面缓存键=原始文本（直引号形态，即 &#34; 的 Unescape 结果——html/template
	// 对数据内直引号转义、弯引号原样直出）；两者 Unescape 对齐后必须命中
	src0 := `没有找到与"玄幻"相关的书籍`
	if _, err := db.Exec(`INSERT OR REPLACE INTO "TranslationCache" ("key","target","content","novelId","createdAt") VALUES (?,?,?,0,?)`,
		translateCacheKey(src0, "en"), "en", `No results for "Fantasy"`, nowMillis()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// html/template 渲染形态：直引号转义为 &#34;，段两侧带真实换行+空白
	src := "<p class=\"empty\">\n    没有找到与&#34;玄幻&#34;相关的书籍\n  </p>"
	got := i18nSweepHTML("en", "", 0, src)
	if !strings.Contains(got, `No results for &#34;Fantasy&#34;`) {
		t.Fatalf("实体段应 Unescape 对齐命中并转义回写: %s", got)
	}
	if !strings.Contains(got, ">\n    No results") {
		t.Fatalf("前导空白应保留: %s", got)
	}
}

func TestI18nSweepHTMLHantCacheHit(t *testing.T) {
	mustInitTranslationCacheTable(t)
	db, err := getDB()
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	src, trans := "妖女，快住口！", "妖女，快住口！（繁）"
	if _, err := db.Exec(`INSERT OR REPLACE INTO "TranslationCache" ("key","target","content","novelId","createdAt") VALUES (?,?,?,0,?)`,
		translateCacheKey(src, "zh-Hant"), "zh-Hant", trans, nowMillis()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// 命中段替换；未命中段上游不可达（测试封网）→ 同步补译失败静默原文（降级契约）
	got := i18nSweepHTML("zh-Hant", "", 0, `<p>`+src+`</p><p>未命中的一段</p>`)
	if !strings.Contains(got, trans) {
		t.Fatalf("zh-Hant 命中段应替换: %s", got)
	}
	if !strings.Contains(got, "未命中的一段") {
		t.Fatalf("未命中段应原文降级: %s", got)
	}
}

func TestI18nSweepHTMLEnMissNoWarmNoChange(t *testing.T) {
	mustInitTranslationCacheTable(t)
	// en 缓存全 miss + flightBase=""（显式禁预热）→ 原样返回、绝不上游
	src := `<p>一本无人问津的书</p>`
	if got := i18nSweepHTML("en", "", 0, src); got != src {
		t.Fatalf("en 未命中+禁预热必须原样: %q", got)
	}
}

func TestSweepFlightHash(t *testing.T) {
	a := sweepFlightHash([]string{"首页", "玄幻"})
	b := sweepFlightHash([]string{"首页", "玄幻"})
	c := sweepFlightHash([]string{"玄幻", "首页"})
	if a != b || len(a) != 10 {
		t.Fatalf("同批应同键且 10 位: %q vs %q", a, b)
	}
	if a == c {
		t.Fatalf("不同文本序列应异键")
	}
}
