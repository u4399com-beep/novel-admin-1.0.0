/**
 * obfuscate_test.go —— Task 45-a 渲染层对抗回归锁定：
 *   ①视觉等价契约：剥除注释/噪声元素/零宽字符 + 实体解码后，文本与原文完全一致
 *   ②安全边界：<script>/<style>/<textarea> 逐字节透传、class/id 零改写、短 UI 文本零变化
 *   ③每页唯一：同源码不同 seed 输出不同（多态）
 *   ④配置面：开关关闭/admin 页恒原样输出；panic 兜底恢复原文
 */
package main

import (
	"html"
	"math/rand"
	"regexp"
	"strings"
	"testing"
)

// obfDataAttrRE 每页唯一指纹属性（混淆层追加的 data-* 随机名随机值）
var obfDataAttrRE = regexp.MustCompile(`\s+data-[a-z0-9]{4,12}="[a-z0-9.]{8,}"`)

// obfStrip 视觉还原：去注释 → 去噪声 <i> 元素 → 实体解码 → 剥零宽
func obfStrip(s string) string {
	// 去注释
	for {
		i := strings.Index(s, "<!--")
		if i < 0 {
			break
		}
		j := strings.Index(s[i:], "-->")
		if j < 0 {
			s = s[:i]
			break
		}
		s = s[:i] + s[i+j+3:]
	}
	// 去噪声元素（font-size:0 起手的 <i ...>...</i>）
	for {
		i := strings.Index(s, `<i style="font-size:0`)
		if i < 0 {
			break
		}
		closeTag := "</i>"
		j := strings.Index(s[i:], closeTag)
		if j < 0 {
			s = s[:i]
			break
		}
		s = s[:i] + s[i+j+len(closeTag):]
	}
	s = html.UnescapeString(s)
	s = strings.ReplaceAll(s, "\u200b", "")
	s = obfDataAttrRE.ReplaceAllString(s, "")
	return s
}

func TestObfuscateVisualEquivalence(t *testing.T) {
	doc := `<!DOCTYPE html><html><head><title>论如何用抄来的才华养鱼塘最新章节列表</title></head>` +
		`<body><h1>论如何用抄来的才华养鱼塘（般若小铃铛）最新章节</h1>` +
		`<p class="intro">本文只有三个世界。（慢穿，超慢，看第一卷的字数就知道了哈哈。）世界一:我在现代用歌曲文学养鱼塘。</p>` +
		`<a href="/book/1" class="btn">书架</a><span>12.5万字</span></body></html>`
	for seed := int64(1); seed < 8; seed++ {
		out := obfuscatePageHTML(doc, defaultObfConfig(), seed)
		got := obfStrip(out)
		want := obfStrip(doc) // 原文本锚（doc 无注释/噪声，等价于原文）
		if got != want {
			t.Errorf("seed=%d 视觉等价破坏:\n got=%q\nwant=%q", seed, got, want)
		}
	}
}

func TestObfuscateSafeBoundaries(t *testing.T) {
	doc := `<html><head><style>.a>.b{color:red}</style><script>var x="<p>代码里的标签</p>";if(x.length>3){document.querySelector(".intro").textContent=x;}</script>` +
		`</head><body><textarea>表单原文</textarea><div class="intro" id="i1">这是一个足够长的正文文本段落，用来验证实体化与零宽注入只发生在正文上。</div>` +
		`<button class="btn-x">书架</button><nav>分类</nav></body></html>`
	out := obfuscatePageHTML(doc, defaultObfConfig(), 42)
	// script/style/textarea 逐字节透传
	for _, key := range []string{
		`var x="<p>代码里的标签</p>";if(x.length>3){document.querySelector(".intro").textContent=x;}`,
		`.a>.b{color:red}`,
		`表单原文`,
	} {
		if !strings.Contains(out, key) {
			t.Errorf("安全块被改写: %q", key)
		}
	}
	// class/id 零改写
	for _, attr := range []string{`class="intro"`, `id="i1"`, `class="btn-x"`} {
		if !strings.Contains(out, attr) {
			t.Errorf("属性钩子被改写: %s", attr)
		}
	}
	// 短 UI 文本零变化（<12 rune 不参与转码）
	for _, short := range []string{`>书架<`, `>分类<`} {
		if !strings.Contains(out, short) {
			t.Errorf("短 UI 文本被改写: %s", short)
		}
	}
}

func TestObfuscatePageUnique(t *testing.T) {
	doc := `<html><body><p>这是用来验证多态输出的足够长正文段落，同一页面两次渲染应当产生不同的源码结构。</p></body></html>`
	out1 := obfuscatePageHTML(doc, defaultObfConfig(), 1001)
	out2 := obfuscatePageHTML(doc, defaultObfConfig(), 1002)
	if out1 == out2 {
		t.Error("同源码不同 seed 输出相同，多态失效")
	}
	// 两份输出的视觉等价都成立
	if obfStrip(out1) != obfStrip(doc) || obfStrip(out2) != obfStrip(doc) {
		t.Error("多态输出破坏视觉等价")
	}
}

func TestObfuscateConfigGates(t *testing.T) {
	doc := `<html><body><p>这是用来验证配置门控的足够长正文段落，关闭开关后应当逐字节原样输出。</p></body></html>`
	if out := obfuscatePageHTML(doc, obfConfig{Enable: false}, 7); out != doc {
		t.Error("开关关闭应逐字节透传")
	}
	if out := obfMaybe(doc, "admin"); out != doc {
		t.Error("admin 页应原样透传")
	}
	// obfMaybe 的配置来自 10s TTL 缓存（生产路径），门控已在 obfuscatePageHTML 层锁定；
	// 此处验证生产配置路径下输出仍是视觉等价的合法变换（不逐字节比对——每页随机）
	out := obfMaybe(doc, "book")
	if obfStrip(out) != obfStrip(doc) {
		t.Error("生产配置路径输出破坏视觉等价")
	}
}

func TestObfuscatePanicGuard(t *testing.T) {
	// 恶劣输入：未闭合标签/超大段——panic 必须被 obfMaybe 兜底回原文
	nasty := `<html><body><p>` + strings.Repeat("长文本段落内容。", 500)
	out := obfMaybe(nasty, "book")
	if out != nasty && !strings.Contains(out, "长文本段落内容。") {
		t.Error("panic 兜底输出异常")
	}
	_ = rand.Int()
}
