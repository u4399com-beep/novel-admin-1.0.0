/**
 * backend-go —— 智能分类归并：把源站五花八门的分类名归并到固定规范集。
 *
 * TS 源：src/lib/scrape/category.ts（逐行移植）
 *
 * 三级流水线（逐级兜底）：
 *  L1 归一化 + 同义词精确映射 —— 零成本，覆盖绝大多数常见源站分类名
 *  L2 规范关键词包含匹配 —— 「玄幻魔法」含「玄幻」→ 玄幻奇幻（按表序命中即返回）
 *  L3 LLM 兜底 —— llmChat（骨架已实现 3s 超时/全局串行链/30s 冷却窗，与 TS 治理等价），
 *     失败/超时/非法输出一律静默归「其他」（兜底类，导航/分类 ID 均在最后），绝不阻塞采集主流程
 *
 * 移植差异：
 * - TS 的 LLM 串行链/冷却由 category.ts 自治；Go 版收敛进 llm.go（gLLMMutex+cooldown），
 *   本文件直接调用 llmChat，行为等价（串行+冷却+失败返回 ""→FALLBACK）
 * - in-flight 去重：TS 用 Promise Map；Go 用 map[string]*catCall + channel 广播
 * - 进程内缓存 map + 互斥锁（含 L3 结果；冷却期失败也会缓存 FALLBACK——与 TS 行为一致）
 * - TS 系统 prompt 用 role:'assistant'（既有怪癖），原样保留
 */
package main

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// FALLBACK_CATEGORY 唯一兜底类（用户指令：不要出现「未分类」，实在没有分类归「其他」，
// 导航排序最后、分类 ID 最后 —— 排序由 ensureCategory 的 sort=9999 与迁移脚本保证）
const FALLBACK_CATEGORY = "其他"

// CANONICAL_CATEGORIES 规范分类集（与首页/分类页种子体系一致；清库重采后全站只会出现这些类目）
var CANONICAL_CATEGORIES = []string{
	"玄幻奇幻",
	"武侠仙侠",
	"都市言情",
	"历史军事",
	"科幻未来",
	"游戏竞技",
	"悬疑灵异",
	"轻小说",
}

var canonicalSet = func() map[string]bool {
	m := map[string]bool{}
	for _, c := range CANONICAL_CATEGORIES {
		m[c] = true
	}
	return m
}()

// CATEGORY_SYNONYMS L1 同义词精确映射（key 为归一化后的分类名）
var CATEGORY_SYNONYMS = map[string]string{
	// 玄幻奇幻
	"玄幻": "玄幻奇幻", "玄幻小说": "玄幻奇幻", "玄幻魔法": "玄幻奇幻", "玄幻奇缘": "玄幻奇幻",
	"奇幻": "玄幻奇幻", "奇幻小说": "玄幻奇幻", "魔法": "玄幻奇幻", "异界": "玄幻奇幻",
	"异世": "玄幻奇幻", "玄幻科幻": "玄幻奇幻", "东方玄幻": "玄幻奇幻", "西方奇幻": "玄幻奇幻",
	// 武侠仙侠
	"武侠": "武侠仙侠", "武侠小说": "武侠仙侠", "仙侠": "武侠仙侠", "仙侠小说": "武侠仙侠",
	"修真": "武侠仙侠", "修真小说": "武侠仙侠", "修仙": "武侠仙侠", "古典武侠": "武侠仙侠",
	"武侠仙侠": "武侠仙侠", "仙侠修真": "武侠仙侠", "洪荒": "武侠仙侠",
	// 都市言情
	"都市": "都市言情", "都市小说": "都市言情", "都市生活": "都市言情", "都市言情": "都市言情",
	"言情": "都市言情", "言情小说": "都市言情", "现代都市": "都市言情", "现实": "都市言情",
	"现实百态": "都市言情", "官场": "都市言情", "商战": "都市言情", "婚恋": "都市言情",
	"女生": "都市言情", "女生频道": "都市言情", "女频": "都市言情", "职场": "都市言情",
	// Task 27-b: 女频站高频分类实测补全（aijjxs .cat=纯美/穿越/现言/重生、23qb tag-link=耽美百合、ggd66 s1=女生耽美）
	// 独立「穿越/重生」频道在中文女频站几乎都是现代/古代言情向，归入都市言情；不映射时 LLM 限流期会湮没为「其他」
	"穿越": "都市言情", "穿越小说": "都市言情", "现言": "都市言情", "纯美": "都市言情",
	"耽美": "都市言情", "百合": "都市言情", "耽美百合": "都市言情", "女生耽美": "都市言情", "青春": "都市言情",
	// 历史军事
	"历史": "历史军事", "历史小说": "历史军事", "历史军事": "历史军事", "军事": "历史军事",
	"军事小说": "历史军事", "架空历史": "历史军事", "秦汉三国": "历史军事", "抗战": "历史军事",
	"架空": "历史军事", // Task 27-b: 「架空」频道简称（aijjxs）
	// 科幻未来
	"科幻": "科幻未来", "科幻小说": "科幻未来", "科幻空间": "科幻未来", "科幻未来": "科幻未来",
	"未来": "科幻未来", "末世": "科幻未来", "末世危机": "科幻未来", "星际": "科幻未来",
	"星际文明": "科幻未来", "机甲": "科幻未来", "末日": "科幻未来", "赛博朋克": "科幻未来",
	// 游戏竞技
	"游戏": "游戏竞技", "游戏小说": "游戏竞技", "游戏竞技": "游戏竞技", "竞技": "游戏竞技",
	"网游": "游戏竞技", "网游小说": "游戏竞技", "电竞": "游戏竞技", "体育": "游戏竞技",
	"体育竞技": "游戏竞技", "虚拟网游": "游戏竞技",
	// 悬疑灵异
	"悬疑": "悬疑灵异", "悬疑小说": "悬疑灵异", "悬疑灵异": "悬疑灵异", "灵异": "悬疑灵异",
	"恐怖": "悬疑灵异", "惊悚": "悬疑灵异", "推理": "悬疑灵异", "推理侦探": "悬疑灵异",
	"侦探": "悬疑灵异", "盗墓": "悬疑灵异", "灵异推理": "悬疑灵异", "悬疑探险": "悬疑灵异",
	// 轻小说
	"轻小说": "轻小说", "二次元": "轻小说", "同人": "轻小说", "同人小说": "轻小说",
	"同人衍生": "轻小说", "衍生": "轻小说", "日轻": "轻小说", "动漫": "轻小说",
	"n次元": "轻小说", // Task 27-b: trxsw 书页「小说分类：N次元」（归一化后小写 n次元）
	// Task 27-b: 繁体分类名直映（101kks og:novel:category 实测输出「歷史軍事」等繁体，LLM 限流期全湮没为「其他」）
	"玄幻小說": "玄幻奇幻", "奇幻小說": "玄幻奇幻", "武俠": "武侠仙侠", "武俠小說": "武侠仙侠",
	"武俠仙俠": "武侠仙侠", "仙俠": "武侠仙侠", "仙俠小說": "武侠仙侠", "修真小說": "武侠仙侠",
	"都市小說": "都市言情", "言情小說": "都市言情", "歷史": "历史军事", "歷史小說": "历史军事",
	"軍事": "历史军事", "軍事小說": "历史军事", "歷史軍事": "历史军事", "科幻小說": "科幻未来",
	"遊戲": "游戏竞技", "遊戲小說": "游戏竞技", "網遊": "游戏竞技", "電競": "游戏竞技", "體育": "游戏竞技",
	"懸疑": "悬疑灵异", "靈異": "悬疑灵异", "驚悚": "悬疑灵异", "偵探": "悬疑灵异", "盜墓": "悬疑灵异", "懸疑靈異": "悬疑灵异",
	"輕小說": "轻小说",
	// Task 27-b(主线收编): 女频年代/宅斗向高频词（存量「其他」抽样实证：九零年代文、古言宅斗占大头）
	"九零": "都市言情", "九零年": "都市言情", "年代文": "都市言情", "古言": "都市言情",
	"宅斗": "都市言情", "宫斗": "都市言情", "甜宠": "都市言情", "种田文": "都市言情",
	// Task 28-b: 重生/总裁（Task 27-b 注释提及 aijjxs .cat=重生 但词表漏收——存量实证
	// 「攻略那个校草[重生]」「重生后发现了男友的真面目」等滞留「其他」）；总裁系同归女频言情主流
	"重生": "都市言情", "重生小说": "都市言情", "总裁": "都市言情", "總裁": "都市言情", "總裁文": "都市言情",
	// Task 28-b: 繁体直映补全（对照简体表逐一核对，101kks 等繁体站实际会输出的形态）
	"異界": "玄幻奇幻", "禦獸": "玄幻奇幻", "鬥氣": "玄幻奇幻", "魔導": "玄幻奇幻",
	"職場": "都市言情", "官場": "都市言情", "商戰": "都市言情", "種田文": "都市言情",
	"甜寵": "都市言情", "宮鬥": "都市言情", "宅鬥": "都市言情", "星際": "科幻未来", "機甲": "科幻未来",
	// 兜底类名直接命中（「未分类」历史输入也归到「其他」，消灭「未分类」残留）
	"未分类": FALLBACK_CATEGORY, "其他": FALLBACK_CATEGORY, "其他小说": FALLBACK_CATEGORY,
	"unknown": FALLBACK_CATEGORY,
}

// CATEGORY_KEYWORDS L2 关键词包含匹配表：[关键词, 规范类]（表序即优先序，命中即返回）
var CATEGORY_KEYWORDS = [][2]string{
	{"玄幻", "玄幻奇幻"}, {"奇幻", "玄幻奇幻"}, {"魔法", "玄幻奇幻"}, {"异界", "玄幻奇幻"},
	{"御兽", "玄幻奇幻"}, {"魔导", "玄幻奇幻"}, {"斗气", "玄幻奇幻"}, {"武魂", "玄幻奇幻"},
	// Task 28-b: 重生/总裁与 L1 同步补齐（存量实证 2 本重生文滞留「其他」）
	{"重生", "都市言情"}, {"总裁", "都市言情"},
	{"仙侠", "武侠仙侠"}, {"武侠", "武侠仙侠"}, {"修真", "武侠仙侠"}, {"修仙", "武侠仙侠"}, {"洪荒", "武侠仙侠"}, {"长生", "武侠仙侠"},
	{"言情", "都市言情"}, {"都市", "都市言情"}, {"现实", "都市言情"}, {"官场", "都市言情"}, {"商战", "都市言情"}, {"职场", "都市言情"},
	{"官道", "都市言情"}, {"七零", "都市言情"}, {"八零", "都市言情"}, {"神豪", "都市言情"}, {"美食", "都市言情"}, {"种田", "都市言情"}, {"婚恋", "都市言情"}, {"竹马", "都市言情"},
	// Task 27-b: 女频站高频词（穿越/耽美系）：置于七零/八零之后，让「穿越七零」类标题优先命中更具体的年代词
	{"穿越", "都市言情"}, {"现言", "都市言情"}, {"纯美", "都市言情"}, {"耽美", "都市言情"}, {"百合", "都市言情"},
	{"历史", "历史军事"}, {"军事", "历史军事"}, {"战争", "历史军事"}, {"逃荒", "历史军事"}, {"宦海", "历史军事"}, {"皇宫", "历史军事"}, {"架空", "历史军事"},
	{"科幻", "科幻未来"}, {"末世", "科幻未来"}, {"末日", "科幻未来"}, {"星际", "科幻未来"}, {"机甲", "科幻未来"}, {"未来", "科幻未来"}, {"外星", "科幻未来"}, {"无限流", "科幻未来"},
	{"游戏", "游戏竞技"}, {"竞技", "游戏竞技"}, {"网游", "游戏竞技"}, {"电竞", "游戏竞技"}, {"体育", "游戏竞技"}, {"直播", "游戏竞技"},
	{"悬疑", "悬疑灵异"}, {"灵异", "悬疑灵异"}, {"恐怖", "悬疑灵异"}, {"惊悚", "悬疑灵异"},
	{"推理", "悬疑灵异"}, {"侦探", "悬疑灵异"}, {"盗墓", "悬疑灵异"}, {"探险", "悬疑灵异"},
	{"轻小说", "轻小说"}, {"二次元", "轻小说"}, {"同人", "轻小说"}, {"动漫", "轻小说"}, {"人外", "轻小说"}, {"次元", "轻小说"},
	// Task 27-b(主线收编): 女频年代/宅斗向（与 L1 同步）
	{"九零", "都市言情"}, {"年代", "都市言情"}, {"古言", "都市言情"}, {"宅斗", "都市言情"}, {"宫斗", "都市言情"}, {"甜宠", "都市言情"},
	// Task 27-b: 繁体关键词兜底（101kks 等站 og:novel:category 输出繁体，简体关键词不命中）。
	// Task 28-b: 删去与上方简体表重复的 {"玄幻"}/{"奇幻"} 两项（简体词在表首已命中，繁体段只留真繁体词），
	// 并补齐 異界/御獸/鬥氣/魔導/職場/官場/商戰/種田/甜寵/宮鬥/宅鬥/星際 与 L1 同步
	{"仙俠", "武侠仙侠"}, {"武俠", "武侠仙侠"},
	{"歷史", "历史军事"}, {"軍事", "历史军事"}, {"機甲", "科幻未来"}, {"遊戲", "游戏竞技"},
	{"網遊", "游戏竞技"}, {"電競", "游戏竞技"}, {"體育", "游戏竞技"}, {"懸疑", "悬疑灵异"},
	{"靈異", "悬疑灵异"}, {"驚悚", "悬疑灵异"}, {"偵探", "悬疑灵异"}, {"盜墓", "悬疑灵异"}, {"輕小說", "轻小说"},
	{"異界", "玄幻奇幻"}, {"御獸", "玄幻奇幻"}, {"鬥氣", "玄幻奇幻"}, {"魔導", "玄幻奇幻"},
	{"職場", "都市言情"}, {"官場", "都市言情"}, {"商戰", "都市言情"}, {"種田", "都市言情"},
	{"甜寵", "都市言情"}, {"宮鬥", "都市言情"}, {"宅鬥", "都市言情"}, {"星際", "科幻未来"},
}

var (
	catWSRe     = regexp.MustCompile(jsWhitespaceClass + `+`)
	catPunctRe  = regexp.MustCompile("[·・_\\-—~～/／\\\\|｜:：,，、。.()（）\\[\\]【】<>《》\"']")
	catFullRe   = regexp.MustCompile(`[\x{FF21}-\x{FF3A}\x{FF41}-\x{FF5A}\x{FF10}-\x{FF19}]`)
	catWSFoldRE = regexp.MustCompile(jsWhitespaceClass + `+`)
)

// normalizeCategory 归一化：去空白与常见分隔符、全角转半角、小写（截断 50 rune）
func normalizeCategory(raw string) string {
	return normalizeCategoryN(raw, 50)
}

// normalizeCategoryN 归一化（截断上限可调）。
// Task 28-b: 旧版把 50 rune 截断写死在 normalizeCategory 内——分类名场景合理，但
// classifyBookLocal 的标题/简介扫描复用它后，实际扫描窗口被压到 50 字（注释宣称的
// 「简介前 240 字」从未真正生效）。长文本路径改用本函数按需放宽窗口。
func normalizeCategoryN(raw string, maxRunes int) string {
	s := raw
	s = catWSRe.ReplaceAllString(s, "")
	s = catPunctRe.ReplaceAllString(s, "")
	s = catFullRe.ReplaceAllStringFunc(s, func(ch string) string {
		r := []rune(ch)
		return string(rune(r[0] - 0xFEE0))
	})
	s = strings.ToLower(s)
	return truncateRunes(s, maxRunes)
}

// ==================== 进程内缓存与 in-flight 去重 ====================

type catCall struct {
	done chan struct{}
	val  string
}

var (
	catMu    sync.Mutex
	catCache = map[string]string{} // normalized → 规范分类名（L1/L2/L3/hint 结果统一缓存）
	catInflt = map[string]*catCall{}
)

func catCacheGet(key string) string {
	catMu.Lock()
	defer catMu.Unlock()
	return catCache[key]
}

func catCacheSet(key, val string) {
	catMu.Lock()
	catCache[key] = val
	catMu.Unlock()
}

// LLM_SYSTEM_PROMPT 照抄 TS 拼接结果（候选 = 8 规范类 + 兜底类）
var LLM_SYSTEM_PROMPT = "你是中文网文分类器。把给定的源站分类名归入以下候选之一，" +
	"只输出分类名本身，不要任何其他文字：" +
	strings.Join(CANONICAL_CATEGORIES, "、") + "、" + FALLBACK_CATEGORY +
	"。无法判断时输出 " + FALLBACK_CATEGORY + "。"

// canonicalIfValid LLM 输出校验：trim 后截 20 字，必须是规范类名否则回兜底
func canonicalIfValid(out string) string {
	o := truncateRunes(trimSpaceStr(out), 20)
	if canonicalSet[o] {
		return o
	}
	return FALLBACK_CATEGORY
}

// llmClassify L3 分类名兜底（超时/限流/失败由 llmChat 治理 → "" → FALLBACK）
func llmClassify(rawName string) string {
	out := llmChat([]llmChatMessage{
		{Role: "assistant", Content: LLM_SYSTEM_PROMPT},
		{Role: "user", Content: "源站分类名：「" + truncateRunes(rawName, 40) + "」"},
	})
	return canonicalIfValid(out)
}

// llmClassifyBook L3+ 书名+简介推断（同样由 llmChat 串行+冷却治理）
func llmClassifyBook(title, description string) string {
	desc := truncateRunes(trimSpaceStr(catWSFoldRE.ReplaceAllString(description, " ")), 160)
	user := "书名《" + truncateRunes(title, 40) + "》"
	if desc != "" {
		user += "，简介：" + desc
	}
	user += "。判断它属于哪个分类，只输出分类名。"
	out := llmChat([]llmChatMessage{
		{Role: "assistant", Content: LLM_SYSTEM_PROMPT},
		{Role: "user", Content: user},
	})
	return canonicalIfValid(out)
}

// hintKey 书名+简介推断分类的缓存键（与分类名缓存同 Map，前缀隔离）
func hintKey(title string) string {
	return "hint:" + normalizeCategory(title)
}

// canonicalCategory 把源站分类名归并为规范分类名（纯映射，不触 DB；带缓存与 in-flight 去重）
func canonicalCategory(rawName string) string {
	clean := truncateRunes(strings.TrimSpace(rawName), 50)
	norm := normalizeCategory(clean)
	if norm == "" {
		return FALLBACK_CATEGORY
	}

	// Task 32-b: 繁体分类名先繁转简再匹配（101kks 等繁体站 og:novel:category 输出
	// 「歷史軍事」「武俠仙俠」形态）——t2s 占比判定零开销透传简体，繁体一次性归一后
	// 走 L1/L2 既有简体表，繁体直映/关键词补全表降级为回归兜底
	if trad := t2s(norm); trad != norm {
		norm = normalizeCategory(trad)
		if norm == "" {
			return FALLBACK_CATEGORY
		}
	}

	if cached := catCacheGet(norm); cached != "" {
		return cached
	}

	// L1 同义词精确命中
	if syn, ok := CATEGORY_SYNONYMS[norm]; ok {
		catCacheSet(norm, syn)
		return syn
	}
	// L1.5 源站名本身已是规范名
	if canonicalSet[clean] {
		catCacheSet(norm, clean)
		return clean
	}
	// L2 关键词包含命中
	for _, kv := range CATEGORY_KEYWORDS {
		if strings.Contains(norm, kv[0]) {
			catCacheSet(norm, kv[1])
			return kv[1]
		}
	}
	// L3 LLM 兜底（in-flight 去重：同分类名并发采集只调一次）
	catMu.Lock()
	if cc, ok := catInflt[norm]; ok {
		catMu.Unlock()
		<-cc.done
		return cc.val
	}
	cc := &catCall{done: make(chan struct{})}
	catInflt[norm] = cc
	catMu.Unlock()

	canon := llmClassify(clean)
	catMu.Lock()
	catCache[norm] = canon
	delete(catInflt, norm)
	catMu.Unlock()
	cc.val = canon
	close(cc.done)
	return canon
}

// classifyBookLocal 本地关键词分类：标题全量 + 简介前段（Task 27-b 收编增强）。
// 背景：LLM 凭证失效（401）期间 L3 兜底全灭，晋江系女频书（标题无分类词、简介含
// 年代/宅斗/修仙等强语义词）大量滞留「其他」。简介截前 descScanChars 字符参与
// 同表匹配——关键词均为强语义词（九零/宅斗/修真/末世等），误伤面可控。
func classifyBookLocal(title, description string) string {
	// Task 28-b: 标题/简介改用 normalizeCategoryN 宽窗口（标题 200/简介 240 rune，
	// 与 maxTitleChars 及「简介前 240 字」设计意图对齐）——旧路径复用 50 rune 截断的
	// normalizeCategory，实际只能扫到前 ~50 字
	norm := normalizeCategoryN(title, 200)
	if norm != "" {
		for _, kv := range CATEGORY_KEYWORDS {
			if strings.Contains(norm, kv[0]) {
				return kv[1]
			}
		}
	}
	// Task 27-b: 简介前段扫描（截断防长文本误命中与开销）
	if desc := strings.TrimSpace(description); desc != "" {
		runes := []rune(desc)
		if len(runes) > 240 {
			runes = runes[:240]
		}
		dnorm := normalizeCategoryN(string(runes), 240)
		if dnorm != "" {
			for _, kv := range CATEGORY_KEYWORDS {
				if strings.Contains(dnorm, kv[0]) {
					return kv[1]
				}
			}
		}
	}
	return ""
}

// canonicalCategoryWithHint 带书名/简介提示的归并：分类名归并失败（含源站无分类信息）时，
// 退而由书名+简介 LLM 推断。采集入库主入口；未分类书重归类（runner recategorizeOne）复用。
func canonicalCategoryWithHint(rawName, hintTitle, hintDescription string) string {
	direct := canonicalCategory(rawName)
	if direct != FALLBACK_CATEGORY {
		return direct
	}
	title := strings.TrimSpace(hintTitle)
	if title == "" {
		return FALLBACK_CATEGORY
	}
	key := hintKey(title)
	if cached := catCacheGet(key); cached != "" {
		return cached
	}
	// Task 28-b: 本地匹配改走「标题+简介」双扫描——旧代码只扫书名（classifyBookByTitle 即
	// classifyBookLocal(title, "")），Task 27-b 的「简介前 240 字」增强在全链路从未生效
	// （classifyBookLocal 唯一调用方恒传空简介），简介含「穿越/官场/军事」等强语义词的书
	// 在分类名/书名双失时被误送 LLM 或滞留「其他」（存量实证 #33/#55/#59/#113/#131）
	if local := classifyBookLocal(title, hintDescription); local != "" {
		catCacheSet(key, local)
		return local
	}
	canon := llmClassifyBook(title, hintDescription)
	catCacheSet(key, canon)
	return canon
}

// ensureCategory 分类保障：归并出规范名后确保 DB 存在该分类（并发创建撞唯一约束 → 回读）。
// 返回分类 id；失败返回 error 由调用方决定任务成败（与 TS ensureCategory 契约一致）。
func ensureCategory(name, hintTitle, hintDescription string) (int, error) {
	canon := canonicalCategoryWithHint(name, hintTitle, hintDescription)
	var id int
	err := queryOne("SELECT id FROM Category WHERE name = ?", []any{&id}, canon)
	if err == nil {
		return id, nil
	}
	if !isNoRows(err) {
		return 0, err
	}
	// 兜底类「其他」sort=9999 保证导航/列表排序最后（api_categories 列表 ORDER BY sort,id；
	// 配合迁移脚本取最大 id，双保险满足「分类 ID 为最后」）；普通分类默认 sort 0 不变
	var newID int64
	var ierr error
	if canon == FALLBACK_CATEGORY {
		newID, ierr = execRetryReturningID("INSERT INTO Category (name, sort) VALUES (?, 9999)", canon)
	} else {
		newID, ierr = execRetryReturningID("INSERT INTO Category (name) VALUES (?)", canon)
	}
	if ierr != nil {
		// 并发创建撞唯一约束 → 重查
		var again int
		if err2 := queryOne("SELECT id FROM Category WHERE name = ?", []any{&again}, canon); err2 == nil {
			return again, nil
		}
		return 0, fmt.Errorf("分类「%s」创建失败", canon)
	}
	return int(newID), nil
}
