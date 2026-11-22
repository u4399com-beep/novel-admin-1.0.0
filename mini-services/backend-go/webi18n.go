/**
 * webi18n.go —— R160 前台渲染语种管线（与 langip.go 判定链配对；用户指令：
 * 根据 ip 判断前台显示什么语种——服务端按语种直接输出对应语言页面，读者侧
 * 零翻译 UI（R156 立场不变：/api/translate 前台代理仍保留但阅读页无入口）。
 *
 * 两个消费面：
 *   A. UI chrome（模板硬编码字符串）：i18nDict 四语种手写字典（en/ja/ko/zh-Hant），
 *      模板经 T/Tf 函数消费——纯进程内查表，零上游零缓存。
 *   B. 内容面（书名/简介/章节标题/正文段落）：TranslationCache 全文寻址缓存
 *      （key=sha256(text)+"|"+target，与 /api/translate、TXT 导出、translatewarm
 *      预热同域复用，预热成果直接命中）+ 进程内短文本 LRU（书名/标题跨页复用）。
 *
 * 语种分级渲染策略（能力诚实分级，渲染路径永不被 LLM 拖死）：
 *   zh-CN：原样直出（零成本）。
 *   zh-Hant：LRU/缓存命中直出；未命中=渲染路径同步补译（OpenCC 词典转换秒级，
 *     短超时 6s，失败静默原文）并回写缓存——与 translatewarm 预热同语种增量补齐。
 *   en/ja/ko：LRU/缓存命中直出；未命中原文兜底 + 后台异步预热 goroutine
 *     （章级单飞行 + 并发闸 2 + 30min 失败负缓存 + 上游 90s 超时），
 *     译文落缓存后下次访问命中——渲染路径零同步等待（LLM 429/慢速均不阻塞）。
 *
 * LRU：sync.Map 短文本池上限 24000（书名/章节标题/UI 词跨页复用；正文段落不走
 * LRU 防挤占书名池——正文直查 SQLite 缓存，90/批 IN 查询 <5ms）。
 */
package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---------- UI chrome 字典（手写四语种；zh-CN=模板原文键，直返不查表） ----------

var i18nDict = map[string]map[string]string{
	"zh-Hant": {
		// _shared 导航/页脚
		"首页": "首頁", "搜索": "搜尋", "分类": "分類", "最近更新": "最近更新", "完本": "完本",
		"搜索书名或作者": "搜尋書名或作者", "搜索书名、作者": "搜尋書名、作者",
		"切换日间/夜间模式": "切換日間/夜間模式", "日/夜模式切换": "日/夜模式切換",
		"桌面导航": "桌面導航", "栏目导航": "欄目導航", "快速导航": "快速導航",
		"排行榜": "排行榜", "书单": "書單", "站点地图": "站點地圖",
		"分类浏览": "分類瀏覽", "友情链接": "友情連結", "站群导航": "站群導航",
		"站群：": "站群：", "专注极速阅读体验": "專注極速閱讀體驗", "站点信息": "站點資訊",
		"提供玄幻、仙侠、都市、历史等小说免费在线阅读。查看作品简介、章节目录和最新更新，通过热门推荐与排行榜发现好书。": "提供玄幻、仙俠、都市、歷史等小說免費線上閱讀。查看作品簡介、章節目錄和最新更新，透過熱門推薦與排行榜發現好書。",
		// home
		"推荐书籍": "推薦書籍", "今日推荐": "今日推薦", "编辑推荐": "編輯推薦",
		"查看详情": "查看詳情", "正在连载，欢迎开始阅读。": "正在連載，歡迎開始閱讀。",
		"小编精选": "小編精選", "热门小说": "熱門小說", "最新上架": "最新上架",
		"点击榜": "點擊榜", "更新榜": "更新榜", "完本佳作": "完本佳作",
		"编辑们正在追的作者与故事。":    "編輯們正在追的作者與故事。",
		"全书库点击最高的作品，人气之选。": "全書庫點擊最高的作品，人氣之選。",
		"新鲜出炉，抢先开读。":       "新鮮出爐，搶先開讀。",
		"用真实点击数说话的榜单。":     "用真實點擊數說話的榜單。",
		"追更上头，最近动作最快的书。":   "追更上頭，最近動作最快的書。",
		"一口气看到大结局的安心之选。":   "一口氣看到大結局的安心之選。",
		"书友手择，值得一读。":       "書友手擇，值得一讀。",
		"更多书单":             "更多書單", "全部书单 →": "全部書單 →", "全部书单": "全部書單",
		"每日精选推荐": "每日精選推薦", "连载": "連載",
		"分类小说": "分類小說",
		// list / category / search / pseo
		"频道导航": "頻道導航", "共": "共", "本": "本",
		"上一页": "上一頁", "下一页": "下一頁", "分页": "分頁",
		"全部{0}本 →": "全部{0}本 →", "全部{0}本": "全部{0}本", "浏览{0}": "瀏覽{0}",
		"{0}全部小说列表":            "{0}全部小說列表",
		"青阅文学":                 "青閱文學",
		"{0} - 免费小说阅读":         "{0} - 免費小說閱讀",
		"{0}分类小说列表":            "{0}分類小說列表",
		"{0}（{1}）最新章节列表 - {2}": "{0}（{1}）最新章節列表 - {2}",
		"{0} 全部章节目录 - {1}":     "{0} 全部章節目錄 - {1}",
		"{0} {1} - {2}":        "{0} {1} - {2}",
		"搜索：{0} - {1}":         "搜尋：{0} - {1}",
		"关于“{0}”的小说推荐 - {1}":   "關於「{0}」的小說推薦 - {1}",
		"今日更新 {0} 章":           "今日更新 {0} 章",
		"完本小说":                 "完本小說", "推荐{0}/3": "推薦{0}/3", "{0} 章": "{0} 章",
		"阅读{0}": "閱讀{0}", "{0}封面": "{0}封面", "“{0}” 共{1}本": "「{0}」 共{1}本",
		"搜索结果": "搜尋結果", "输入书名或作者开始搜索": "輸入書名或作者開始搜尋",
		"没有找到与“{0}”相关的书籍，换个关键词试试。": "沒有找到與「{0}」相關的書籍，換個關鍵詞試試。",
		"该频道暂无收录书籍。":               "該頻道暫無收錄書籍。",
		"该专题暂无收录书籍。":               "該專題暫無收錄書籍。",
		"专题书单":                     "專題書單", "编辑精选": "編輯精選", "书库分类": "書庫分類",
		"人气": "人氣",
		// toc
		"返回书籍详情": "返回書籍詳情", "共{0}章": "共{0}章", "目录正在后台采集中，请稍后返回。": "目錄正在後台採集中，請稍後返回。",
		// book
		"详情页导航": "詳情頁導航", "返回首页": "返回首頁", "搜索书籍": "搜尋書籍",
		"复制分享链接": "複製分享連結", "位置": "位置", "作者:": "作者:", "分类:": "分類:",
		"状态:": "狀態:", "已完本": "已完本", "连载中": "連載中", "作品数据": "作品數據",
		"字数": "字數", "浏览量": "瀏覽量", "章节": "章節", "万字": "萬字", "万": "萬", "字": "字", "章": "章",
		"开始阅读": "開始閱讀", "加入书架": "加入書架", "立即阅读": "立即閱讀", "查看目录": "查看目錄",
		"最新章节": "最新章節", "完整目录": "完整目錄", "连载至{0}章": "連載至{0}章",
		"目录": "目錄", "简介": "簡介", "展开": "展開", "猜你喜欢": "猜你喜歡",
		"{0}里程碑": "{0}里程碑", "浏览 {0}": "瀏覽 {0}",
		"一万浏览": "一萬瀏覽", "十万浏览": "十萬瀏覽", "五十万浏览": "五十萬瀏覽",
		"百万浏览": "百萬瀏覽", "二百万浏览": "二百萬瀏覽", "五百万浏览": "五百萬瀏覽",
		"千万浏览": "千萬瀏覽", "五千万浏览": "五千萬瀏覽", "亿级浏览": "億級瀏覽",
		"浏览": "瀏覽",
		"滑动或点击翻页，点击中央打开菜单":          "滑動或點擊翻頁，點擊中央打開菜單",
		"本章内容为空，正文正在后台采集中，请稍后返回阅读。": "本章內容為空，正文正在後台採集中，請稍後返回閱讀。",
		"打开阅读菜单": "打開閱讀菜單",
		"阅读进度":   "閱讀進度", "书籍详情": "書籍詳情", "全部目录": "全部目錄",
		"上一章": "上一章", "下一章": "下一章", "下一章（Ctrl+→）": "下一章（Ctrl+→）",
		"已经是第一章": "已經是第一章", "已经是最新一章": "已經是最新一章", "阅读设置": "閱讀設定",
		"字号": "字號", "减小字号": "減小字號", "增大字号": "增大字號",
		"行距": "行距", "紧凑": "緊湊", "适中": "適中", "宽松": "寬鬆",
		"背景": "背景", "米色": "米色", "白纸": "白紙", "护眼": "護眼", "夜间": "夜間",
	},
	"en": {
		// _shared
		"首页": "Home", "搜索": "Search", "分类": "Categories", "最近更新": "Latest Updates", "完本": "Completed",
		"搜索书名或作者": "Search by title or author", "搜索书名、作者": "Search by title or author",
		"切换日间/夜间模式": "Toggle day/night mode", "日/夜模式切换": "Toggle day/night mode",
		"桌面导航": "Main navigation", "栏目导航": "Sections navigation", "快速导航": "Quick Links",
		"排行榜": "Rankings", "书单": "Booklists", "站点地图": "Sitemap",
		"分类浏览": "Browse Categories", "友情链接": "Friendly Links", "站群导航": "Network Sites",
		"站群：": "Network: ", "专注极速阅读体验": "Fast reading experience", "站点信息": "Site info",
		"提供玄幻、仙侠、都市、历史等小说免费在线阅读。查看作品简介、章节目录和最新更新，通过热门推荐与排行榜发现好书。": "Free online novels of fantasy, xianxia, urban and historical fiction. Browse introductions, chapter lists and the latest updates, and discover great books through recommendations and rankings.",
		// home
		"推荐书籍": "Recommended", "今日推荐": "Today's Picks", "编辑推荐": "Editor's Pick",
		"查看详情": "View Details", "正在连载，欢迎开始阅读。": " is now serializing. Start reading anytime.",
		"小编精选": "Editors' Picks", "热门小说": "Popular Novels", "最新上架": "New Arrivals",
		"点击榜": "Most Clicked", "更新榜": "Most Updated", "完本佳作": "Completed Gems",
		"编辑们正在追的作者与故事。":    "Authors and stories our editors are following.",
		"全书库点击最高的作品，人气之选。": "The most-clicked works across the library.",
		"新鲜出炉，抢先开读。":       "Fresh arrivals — be the first to read.",
		"用真实点击数说话的榜单。":     "Ranked by real reader clicks.",
		"追更上头，最近动作最快的书。":   "The fastest-updating books right now.",
		"一口气看到大结局的安心之选。":   "Fully completed — binge to the ending.",
		"书友手择，值得一读。":       "Hand-picked by fellow readers.",
		"更多书单":             "More Booklists", "全部书单 →": "All booklists →", "全部书单": "All booklists",
		"每日精选推荐": "Daily Picks", "连载": "Ongoing",
		"分类小说": "{0} Novels",
		// list / category / search / pseo
		"频道导航": "Channels", "共": "Total ", "本": " books",
		"上一页": "Previous", "下一页": "Next", "分页": "Pagination",
		"全部{0}本 →": "All {0} →", "全部{0}本": "All {0} books", "浏览{0}": "views {0}",
		"{0}全部小说列表":            "{0} - All Novels",
		"青阅文学":                 "Qingyue Literature",
		"{0} - 免费小说阅读":         "{0} - Free Novel Reading",
		"{0}分类小说列表":            "{0} - Novels",
		"{0}（{1}）最新章节列表 - {2}": "{0} ({1}) - Latest Chapters - {2}",
		"{0} 全部章节目录 - {1}":     "{0} - Full Chapter Index - {1}",
		"{0} {1} - {2}":        "{0} {1} - {2}",
		"搜索：{0} - {1}":         "Search: {0} - {1}",
		"关于“{0}”的小说推荐 - {1}":   "Novels about \"{0}\" - {1}",
		"今日更新 {0} 章":           "Updated Today: {0} chapters",
		"完本小说":                 "Completed Novels", "推荐{0}/3": "Pick {0}/3", "{0} 章": "{0} ch",
		"阅读{0}": "Read {0}", "{0}封面": "{0} cover", "“{0}” 共{1}本": "\"{0}\" - {1} books",
		"搜索结果": "Search Results", "输入书名或作者开始搜索": "Type a title or author to search",
		"没有找到与“{0}”相关的书籍，换个关键词试试。": "No results for \u201c{0}\u201d — try another keyword.",
		"该频道暂无收录书籍。":               "No books in this channel yet.",
		"该专题暂无收录书籍。":               "No books in this topic yet.",
		"专题书单":                     "Topic Booklist", "编辑精选": "Editor's Picks", "书库分类": "Library Categories",
		"人气": "Popularity ",
		// toc
		"返回书籍详情": "Back to book details", "共{0}章": "{0} chapters", "目录正在后台采集中，请稍后返回。": "The chapter list is being collected in the background — please check back later.",
		// book
		"详情页导航": "Book page navigation", "返回首页": "Back to home", "搜索书籍": "Search books",
		"复制分享链接": "Copy share link", "位置": "Breadcrumb", "作者:": "Author: ", "分类:": "Category: ",
		"状态:": "Status: ", "已完本": "Completed", "连载中": "Ongoing", "作品数据": "Book stats",
		"字数": "Words", "浏览量": "Views", "章节": "Chapters", "万字": "0k words", "万": "0k", "字": " chars", "章": " ch",
		"开始阅读": "Start Reading", "加入书架": "Add to Shelf", "立即阅读": "Read Now", "查看目录": "View TOC",
		"最新章节": "Latest Chapters", "完整目录": "Full TOC", "连载至{0}章": "{0} chapters and counting",
		"目录": "TOC", "简介": "Synopsis", "展开": "Expand", "猜你喜欢": "You May Also Like",
		"{0}里程碑": "{0} milestone", "浏览 {0}": "Views {0}",
		"一万浏览": "10k views", "十万浏览": "100k views", "五十万浏览": "500k views",
		"百万浏览": "1M views", "二百万浏览": "2M views", "五百万浏览": "5M views",
		"千万浏览": "10M views", "五千万浏览": "50M views", "亿级浏览": "100M+ views",
		"浏览": " views",
		// chapter
		"章节阅读": "Chapter reader", "阅读菜单": "Reading menu", "阅读工具": "Reader tools",
		"滑动或点击翻页，点击中央打开菜单":          "Swipe or tap to turn pages, tap center for menu",
		"本章内容为空，正文正在后台采集中，请稍后返回阅读。": "This chapter is empty — the content is being collected in the background. Please check back soon.",
		"打开阅读菜单": "Open reading menu", "阅读进度": "Reading progress",
		"书籍详情": "Book details", "全部目录": "Full chapter list",
		"上一章": "Previous chapter", "下一章": "Next chapter", "下一章（Ctrl+→）": "Next chapter (Ctrl+→)",
		"已经是第一章": "This is the first chapter", "已经是最新一章": "Already the latest chapter", "阅读设置": "Reader Settings",
		"字号": "Font Size", "减小字号": "Smaller font", "增大字号": "Larger font",
		"行距": "Line Height", "紧凑": "Tight", "适中": "Default", "宽松": "Loose",
		"背景": "Background", "米色": "Sepia", "白纸": "White", "护眼": "Green", "夜间": "Dark",
		// R164: trxsw 主题 UI chrome 增量词（sweep 字典直查消费——未包 T 模板同样生效）
		"最新更新":         "Latest Updates",
		"总推荐榜":         "Top Recommendations",
		"最新入库":         "Just Added",
		"全部分类":         "All Categories",
		"科幻未来":         "Sci-Fi",
		"悬疑灵异":         "Mystery & Supernatural",
		"轻小说":          "Light Novels",
		"其他":           "Others",
		"今日更新":         "Updated Today",
		"每周精选":         "Weekly Picks",
		"查看更多":         "See More",
		"通知":           "Notice",
		"分类导航":         "Categories",
		"搜索书名":         "Title",
		"搜索作者":         "Author",
		"收藏本站（Ctrl+D）": "Bookmark Us (Ctrl+D)",
		"阅读记录":         "Reading History",
		"简单":           "Simple",
		"快速":           "Fast",
		"纯净阅读":         "Clean Reading",
		"全部小说":         "All Novels",
		"仙侠修真":         "Xianxia & Cultivation",
		"玄幻奇幻":         "Fantasy",
		"武侠仙侠":         "Wuxia & Xianxia",
		"都市言情":         "Urban Romance",
		"历史军事":         "History & Military",
		"游戏竞技":         "Games & Esports",
		"科幻灵异":         "Sci-Fi & Mystery",
		"女生小说":         "Girls' Novels",
		"更新时间":         "Updated",
		"作者：":          "Author: ",
		"字数：":          "Words: ",
		"状态：":          "Status: ",
		// R164b: 章节页静态 chrome 增量词
		"返回目录":   "Back to TOC",
		"推荐本书":   "Recommend",
		"举报错误":   "Report an Issue",
		"恢复默认":   "Reset",
		"本章内容为空": "This chapter is empty",
	},
	"ja": {
		// _shared
		"首页": "ホーム", "搜索": "検索", "分类": "カテゴリ", "最近更新": "最新更新", "完本": "完結",
		"搜索书名或作者": "書名・著者で検索", "搜索书名、作者": "書名・著者を検索",
		"切换日间/夜间模式": "日/夜モード切替", "日/夜模式切换": "日/夜モード切替",
		"桌面导航": "ナビゲーション", "栏目导航": "セクション", "快速导航": "クイックリンク",
		"排行榜": "ランキング", "书单": "ブックリスト", "站点地图": "サイトマップ",
		"分类浏览": "カテゴリから探す", "友情链接": "相互リンク", "站群导航": "系列サイト",
		"站群：": "系列サイト：", "专注极速阅读体验": "高速な読書体験", "站点信息": "サイト情報",
		"提供玄幻、仙侠、都市、历史等小说免费在线阅读。查看作品简介、章节目录和最新更新，通过热门推荐与排行榜发现好书。": "ファンタジー・仙俠・都市・歴史などの小説を無料で読めます。作品のあらすじ、目次、最新更新をチェックし、おすすめやランキングから好みの一冊を見つけましょう。",
		// home
		"推荐书籍": "おすすめ作品", "今日推荐": "今日のおすすめ", "编辑推荐": "編集おすすめ",
		"查看详情": "詳細を見る", "正在连载，欢迎开始阅读。": "連載中です。ぜひお読みください。",
		"小编精选": "編集部ピック", "热门小说": "人気小説", "最新上架": "新着作品",
		"点击榜": "クリックランキング", "更新榜": "更新ランキング", "完本佳作": "完結の傑作",
		"编辑们正在追的作者与故事。":    "編集部が注目する作者と作品。",
		"全书库点击最高的作品，人气之选。": "書庫で最も読まれている人気作品。",
		"新鲜出炉，抢先开读。":       "届きたての新作をいち早く。",
		"用真实点击数说话的榜单。":     "リアルなクリック数で語るランキング。",
		"追更上头，最近动作最快的书。":   "更新ペース最速の話題作。",
		"一口气看到大结局的安心之选。":   "最終話まで一気読みできる完結作。",
		"书友手择，值得一读。":       "読者のおすすめ、必読の一品。",
		"更多书单":             "ブックリスト一覧", "全部书单 →": "全ブックリスト →", "全部书单": "全ブックリスト",
		"每日精选推荐": "毎日のおすすめ", "连载": "連載",
		"分类小说": "{0}小説",
		// list / category / search / pseo
		"频道导航": "チャンネル", "共": "計 ", "本": "冊",
		"上一页": "前へ", "下一页": "次へ", "分页": "ページ送り",
		"全部{0}本 →": "全{0}冊 →", "全部{0}本": "全{0}冊", "浏览{0}": "閲覧{0}",
		"{0}全部小说列表":            "{0}の小説一覧",
		"青阅文学":                 "青阅文学",
		"{0} - 免费小说阅读":         "{0} - 無料小説を読む",
		"{0}分类小说列表":            "{0}の小説一覧",
		"{0}（{1}）最新章节列表 - {2}": "{0}（{1}）最新話一覧 - {2}",
		"{0} 全部章节目录 - {1}":     "{0} 全話目次 - {1}",
		"{0} {1} - {2}":        "{0} {1} - {2}",
		"搜索：{0} - {1}":         "検索：{0} - {1}",
		"关于“{0}”的小说推荐 - {1}":   "「{0}」の小説おすすめ - {1}",
		"今日更新 {0} 章":           "今日更新 {0} 話",
		"完本小说":                 "完結小説", "推荐{0}/3": "おすすめ{0}/3", "{0} 章": "{0}章",
		"阅读{0}": "{0}を読む", "{0}封面": "{0}の表紙", "“{0}” 共{1}本": "「{0}」 計{1}冊",
		"搜索结果": "検索結果", "输入书名或作者开始搜索": "書名か著者を入力して検索",
		"没有找到与“{0}”相关的书籍，换个关键词试试。": "「{0}」に一致する書籍が見つかりません。キーワードを変えてお試しください。",
		"该频道暂无收录书籍。":               "このチャンネルにはまだ書籍がありません。",
		"该专题暂无收录书籍。":               "このテーマにはまだ書籍がありません。",
		"专题书单":                     "テーマ書單", "编辑精选": "編集セレクション", "书库分类": "書庫カテゴリ",
		"人气": "人気度 ",
		// toc
		"返回书籍详情": "作品詳細に戻る", "共{0}章": "全{0}章", "目录正在后台采集中，请稍后返回。": "目次はバックグラウンドで収集中です。後ほどご確認ください。",
		// book
		"详情页导航": "作品ページナビ", "返回首页": "ホームへ", "搜索书籍": "書籍を検索",
		"复制分享链接": "リンクをコピー", "位置": "パンくず", "作者:": "著者:", "分类:": "カテゴリ:",
		"状态:": "状態:", "已完本": "完結済", "连载中": "連載中", "作品数据": "作品データ",
		"字数": "文字数", "浏览量": "閲覧数", "章节": "章", "万字": "万字", "万": "万", "字": "字", "章": "章",
		"开始阅读": "読み始める", "加入书架": "本棚に追加", "立即阅读": "今すぐ読む", "查看目录": "目次を見る",
		"最新章节": "最新話", "完整目录": "完全な目次", "连载至{0}章": "{0}章まで連載中",
		"目录": "目次", "简介": "あらすじ", "展开": "もっと見る", "猜你喜欢": "あなたへのおすすめ",
		"{0}里程碑": "{0}マイルストーン", "浏览 {0}": "閲覧 {0}",
		"一万浏览": "1万閲覧", "十万浏览": "10万閲覧", "五十万浏览": "50万閲覧",
		"百万浏览": "100万閲覧", "二百万浏览": "200万閲覧", "五百万浏览": "500万閲覧",
		"千万浏览": "1000万閲覧", "五千万浏览": "5000万閲覧", "亿级浏览": "億級閲覧",
		"浏览": "閲覧",
		// chapter
		"章节阅读": "章の閲読", "阅读菜单": "メニュー", "阅读工具": "読書ツール",
		"滑动或点击翻页，点击中央打开菜单":          "スワイプでページ送り、中央タップでメニュー",
		"本章内容为空，正文正在后台采集中，请稍后返回阅读。": "本章の本文はまだ収集中です。後ほどご覧ください。",
		"打开阅读菜单": "メニューを開く", "阅读进度": "読書進度",
		"书籍详情": "作品詳細", "全部目录": "全章リスト",
		"上一章": "前の章", "下一章": "次の章", "下一章（Ctrl+→）": "次の章（Ctrl+→）",
		"已经是第一章": "最初の章です", "已经是最新一章": "最新の章です", "阅读设置": "読書設定",
		"字号": "文字サイズ", "减小字号": "文字を小さく", "增大字号": "文字を大きく",
		"行距": "行間", "紧凑": "狭い", "适中": "標準", "宽松": "広い",
		"背景": "背景", "米色": "セピア", "白纸": "白", "护眼": "グリーン", "夜间": "ダーク",
		// R164: trxsw 主题 UI chrome 增量词（sweep 字典直查消费——未包 T 模板同样生效）
		"最新更新":         "最新更新",
		"总推荐榜":         "総おすすめ",
		"最新入库":         "新着作品",
		"全部分类":         "全カテゴリ",
		"科幻未来":         "SF",
		"悬疑灵异":         "ミステリー",
		"轻小说":          "ライトノベル",
		"其他":           "その他",
		"今日更新":         "今日の更新",
		"每周精选":         "週間ピック",
		"查看更多":         "もっと見る",
		"通知":           "お知らせ",
		"分类导航":         "カテゴリ",
		"搜索书名":         "書名",
		"搜索作者":         "著者",
		"收藏本站（Ctrl+D）": "お気に入り登録（Ctrl+D）",
		"阅读记录":         "閲読履歴",
		"简单":           "シンプル",
		"快速":           "高速",
		"纯净阅读":         "クリーンリーディング",
		"全部小说":         "全小説",
		"仙侠修真":         "仙俠修真",
		"玄幻奇幻":         "ファンタジー",
		"武侠仙侠":         "武侠・仙俠",
		"都市言情":         "都市恋愛",
		"历史军事":         "歴史・軍事",
		"游戏竞技":         "ゲーム・競技",
		"科幻灵异":         "SF・怪奇",
		"女生小说":         "女性向け小説",
		"更新时间":         "更新日時",
		"作者：":          "著者:",
		"字数：":          "文字数:",
		"状态：":          "状態:",
		// R164b: 章节页静态 chrome 增量词
		"返回目录":   "目次へ戻る",
		"推荐本书":   "おすすめ",
		"举报错误":   "問題を報告",
		"恢复默认":   "初期設定",
		"本章内容为空": "本章はまだ収集中です",
	},
	"ko": {
		// _shared
		"首页": "홈", "搜索": "검색", "分类": "분류", "最近更新": "최근 업데이트", "完本": "완결",
		"搜索书名或作者": "제목·작가 검색", "搜索书名、作者": "제목·작가 검색",
		"切换日间/夜间模式": "낮/밤 모드 전환", "日/夜模式切换": "낮/밤 모드 전환",
		"桌面导航": "메인 내비게이션", "栏目导航": "섹션 내비게이션", "快速导航": "빠른 링크",
		"排行榜": "랭킹", "书单": "책장", "站点地图": "사이트맵",
		"分类浏览": "카테고리 탐색", "友情链接": "교환 링크", "站群导航": "네트워크 사이트",
		"站群：": "네트워크: ", "专注极速阅读体验": "초고속 독서 경험", "站点信息": "사이트 정보",
		"提供玄幻、仙侠、都市、历史等小说免费在线阅读。查看作品简介、章节目录和最新更新，通过热门推荐与排行榜发现好书。": "판타지·선협·도시·역사 소설을 무료로 연재 중입니다. 작품 소개, 목차, 최신 업데이트를 확인하고 추천과 랭킹으로 좋은 책을 발견하세요.",
		// home
		"推荐书籍": "추천 작품", "今日推荐": "오늘의 추천", "编辑推荐": "에디터 추천",
		"查看详情": "자세히 보기", "正在连载，欢迎开始阅读。": " 연재 중입니다. 지금 시작해 보세요.",
		"小编精选": "에디터 선정", "热门小说": "인기 소설", "最新上架": "신착 작품",
		"点击榜": "클릭 순위", "更新榜": "업데이트 순위", "完本佳作": "완결 걸작",
		"编辑们正在追的作者与故事。":    "에디터가 주목하는 작가와 작품.",
		"全书库点击最高的作品，人气之选。": "서재에서 가장 많이 읽힌 인기 작품.",
		"新鲜出炉，抢先开读。":       "갓 도착한 신작을 가장 먼저.",
		"用真实点击数说话的榜单。":     "실제 클릭 수로 증명하는 랭킹.",
		"追更上头，最近动作最快的书。":   "업데이트가 가장 빠른 화제작.",
		"一口气看到大结局的安心之选。":   "결말까지 몰아볼 수 있는 완결작.",
		"书友手择，值得一读。":       "독자들이 직접 고른 필독서.",
		"更多书单":             "더 많은 책장", "全部书单 →": "전체 책장 →", "全部书单": "전체 책장",
		"每日精选推荐": "오늘의 추천", "连载": "연재",
		"分类小说": "{0} 소설",
		// list / category / search / pseo
		"频道导航": "채널", "共": "총 ", "本": "권",
		"上一页": "이전", "下一页": "다음", "分页": "페이지네이션",
		"全部{0}本 →": "전체 {0}권 →", "全部{0}本": "전체 {0}권", "浏览{0}": "조회 {0}",
		"{0}全部小说列表":            "{0} 전체 소설 목록",
		"青阅文学":                 "青阅文学",
		"{0} - 免费小说阅读":         "{0} - 무료 소설 읽기",
		"{0}分类小说列表":            "{0} 장르 소설 목록",
		"{0}（{1}）最新章节列表 - {2}": "{0}({1}) 최신 화 목록 - {2}",
		"{0} 全部章节目录 - {1}":     "{0} 전체 화 목차 - {1}",
		"{0} {1} - {2}":        "{0} {1} - {2}",
		"搜索：{0} - {1}":         "검색: {0} - {1}",
		"关于“{0}”的小说推荐 - {1}":   "\"{0}\" 관련 소설 추천 - {1}",
		"今日更新 {0} 章":           "오늘 업데이트 {0}화",
		"完本小说":                 "완결 소설", "推荐{0}/3": "추천 {0}/3", "{0} 章": "{0}화",
		"阅读{0}": "{0} 읽기", "{0}封面": "{0} 표지", "“{0}” 共{1}本": "\"{0}\" 총 {1}권",
		"搜索结果": "검색 결과", "输入书名或作者开始搜索": "제목이나 작가를 입력하세요",
		"没有找到与“{0}”相关的书籍，换个关键词试试。": "「{0}」과 관련된 책을 찾지 못했습니다. 다른 키워드로 시도해 보세요.",
		"该频道暂无收录书籍。":               "이 채널에는 아직 수록된 책이 없습니다.",
		"该专题暂无收录书籍。":               "이 테마에는 아직 수록된 책이 없습니다.",
		"专题书单":                     "테마 책장", "编辑精选": "에디터 추천", "书库分类": "서재 분류",
		"人气": "인기도 ",
		// toc
		"返回书籍详情": "작품 상세로 돌아가기", "共{0}章": "총 {0}화", "目录正在后台采集中，请稍后返回。": "목차를 수집 중입니다. 잠시 후 다시 확인해 주세요.",
		// book
		"详情页导航": "작품 페이지 내비", "返回首页": "홈으로", "搜索书籍": "책 검색",
		"复制分享链接": "링크 복사", "位置": "위치", "作者:": "작가:", "分类:": "분류:",
		"状态:": "상태:", "已完本": "완결됨", "连载中": "연재 중", "作品数据": "작품 데이터",
		"字数": "글자 수", "浏览量": "조회수", "章节": "챕터", "万字": "만 자", "万": "만", "字": "자", "章": "화",
		"开始阅读": "바로 읽기", "加入书架": "서재에 추가", "立即阅读": "지금 읽기", "查看目录": "목차 보기",
		"最新章节": "최신 화", "完整目录": "전체 목록", "连载至{0}章": "{0}화까지 연재 중",
		"目录": "목차", "简介": "소개", "展开": "펼치기", "猜你喜欢": "함께 보면 좋은 책",
		"{0}里程碑": "{0} 마일스톤", "浏览 {0}": "조회 {0}",
		"一万浏览": "1만 조회", "十万浏览": "10만 조회", "五十万浏览": "50만 조회",
		"百万浏览": "100만 조회", "二百万浏览": "200만 조회", "五百万浏览": "500만 조회",
		"千万浏览": "1000만 조회", "五千万浏览": "5000만 조회", "亿级浏览": "억급 조회",
		"浏览": "조회",
		// chapter
		"章节阅读": "챕터 읽기", "阅读菜单": "독서 메뉴", "阅读工具": "독서 도구",
		"滑动或点击翻页，点击中央打开菜单":          "스와이프로 페이지 넘기기, 가운데 탭으로 메뉴",
		"本章内容为空，正文正在后台采集中，请稍后返回阅读。": "이 장의 본문을 수집 중입니다. 잠시 후 다시 이용해 주세요.",
		"打开阅读菜单": "메뉴 열기", "阅读进度": "독서 진도",
		"书籍详情": "작품 상세", "全部目录": "전체 목록",
		"上一章": "이전 챕터", "下一章": "다음 챕터", "下一章（Ctrl+→）": "다음 챕터 (Ctrl+→)",
		"已经是第一章": "첫 화입니다", "已经是最新一章": "최신 화입니다", "阅读设置": "독서 설정",
		"字号": "글자 크기", "减小字号": "글자 작게", "增大字号": "글자 크게",
		"行距": "행간", "紧凑": "좁게", "适中": "보통", "宽松": "넓게",
		"背景": "배경", "米色": "세피아", "白纸": "흰 종이", "护眼": "녹색", "夜间": "야간",
		// R164: trxsw 主题 UI chrome 增量词（sweep 字典直查消费——未包 T 模板同样生效）
		"最新更新":         "최근 업데이트",
		"总推荐榜":         "종합 추천",
		"最新入库":         "신착 작품",
		"全部分类":         "전체 분류",
		"科幻未来":         "SF",
		"悬疑灵异":         "미스터리",
		"轻小说":          "라이트노벨",
		"其他":           "기타",
		"今日更新":         "오늘 업데이트",
		"每周精选":         "주간 추천",
		"查看更多":         "더 보기",
		"通知":           "공지",
		"分类导航":         "분류",
		"搜索书名":         "제목",
		"搜索作者":         "작가",
		"收藏本站（Ctrl+D）": "즐겨찾기 (Ctrl+D)",
		"阅读记录":         "열람 기록",
		"简单":           "심플",
		"快速":           "빠름",
		"纯净阅读":         "깨끗한 독서",
		"全部小说":         "전체 소설",
		"仙侠修真":         "선협 수련",
		"玄幻奇幻":         "판타지",
		"武侠仙侠":         "무협·선협",
		"都市言情":         "도시 로맨스",
		"历史军事":         "역사·군사",
		"游戏竞技":         "게임·스포츠",
		"科幻灵异":         "SF·미스터리",
		"女生小说":         "여성 소설",
		"更新时间":         "업데이트",
		"作者：":          "작가:",
		"字数：":          "글자 수:",
		"状态：":          "상태:",
		// R164b: 章节页静态 chrome 增量词
		"返回目录":   "목차로 돌아가기",
		"推荐本书":   "추천",
		"举报错误":   "신고",
		"恢复默认":   "기본값",
		"本章内容为空": "이 장은 수집 중입니다",
	},
}

// tmplT 模板 T 函数：UI 字符串按语种查字典；zh-CN/未登记词组返回原文（诚实降级）。
// 参数 any：非 jiuxiaozw 主题/旧测试 data 无 .Lang 键时（nil），安全回落原文不炸渲染。
func tmplT(lang any, s string) string {
	l, _ := lang.(string)
	if l == "" || l == "zh-CN" {
		return s
	}
	if d, ok := i18nDict[l]; ok {
		if v, ok2 := d[s]; ok2 && v != "" {
			return v
		}
	}
	return s
}

// tmplTf 模板 Tf 函数：带 {0}/{1} 占位符替换的 T（数字/书名混排句式）。
func tmplTf(lang any, pattern string, args ...any) string {
	l, _ := lang.(string)
	s := tmplT(l, pattern)
	for i, a := range args {
		s = strings.ReplaceAll(s, "{"+strconv.Itoa(i)+"}", fmt.Sprint(a))
	}
	return s
}

// tmplFirst 单元素批量翻译的取值辅助（i18nTexts 返回切片，取首项）
func tmplFirst(list []string) string {
	if len(list) > 0 {
		return list[0]
	}
	return ""
}

// fnum 数字 x.x 去尾零（91800/1000→"91.8"→trim→"91.8"；920000/10000→"92"）
func fnum(v float64) string {
	s := strconv.FormatFloat(v, 'f', 1, 64)
	return strings.TrimSuffix(s, ".0")
}

// wcFmtL 语种感知字数格式化（模板函数）：en 千进制 k 缩写（91.8万字→"918k"，
// 万进制×10k 会让英语读者读错一个数量级，千进制直读）；ja/ko/zh-Hant 沿用万进制
// + 本地单位（万字/만 자）；zh-CN 与 wcFmt 同形（万字/字）。
func wcFmtL(lang any, v any) string {
	l, _ := lang.(string)
	n := toInt64(v)
	if n <= 0 {
		return ""
	}
	switch l {
	case "en":
		if n >= 1000 {
			return fnum(float64(n)/1000) + "k"
		}
		return strconv.FormatInt(n, 10)
	case "ja", "zh-Hant":
		if n >= 10000 {
			return fnum(float64(n)/10000) + tmplT(l, "万字")
		}
		return strconv.FormatInt(n, 10) + tmplT(l, "字")
	case "ko":
		if n >= 10000 {
			return fnum(float64(n)/10000) + "만 자"
		}
		return strconv.FormatInt(n, 10) + " 자"
	}
	// zh-CN 与既有 wcFmt 同口径
	if n >= 10000 {
		return fnum(float64(n)/10000) + "万字"
	}
	return strconv.FormatInt(n, 10) + "字"
}

// popL 人气值（真实点击量）数值部分（模板函数，aria/strong 拼接用无单位）：
// en 千进制 k；其它语种万进制（x.x万）——与 wcFmtL 同缩放语义。
func popL(lang any, v any) string {
	l, _ := lang.(string)
	n := toInt64(v)
	if n <= 0 {
		return ""
	}
	if l == "en" {
		if n >= 1000 {
			return fnum(float64(n)/1000) + "k"
		}
		return strconv.FormatInt(n, 10)
	}
	if n >= 10000 {
		return fnum(float64(n)/10000) + "万"
	}
	return strconv.FormatInt(n, 10)
}

// ---------- 短文本 LRU（书名/章节标题/UI 短词跨页复用池） ----------

var (
	i18nShortCache sync.Map // key: lang+"|"+text → value: 译文（空串占位=已查无译文）
	i18nShortCount atomic.Int64
	i18nShortMax   = int64(24000)
)

// i18nShortGet 批量取 LRU（返回命中子集）
func i18nShortGet(lang string, texts []string) map[string]string {
	out := map[string]string{}
	for _, t := range texts {
		if v, ok := i18nShortCache.Load(lang + "|" + t); ok {
			if s, ok2 := v.(string); ok2 {
				out[t] = s
			}
		}
	}
	return out
}

// i18nShortPut 批量写 LRU（译文空串也占位防重复查缓存；超限全清——书名池稳定重建）
func i18nShortPut(lang string, pairs map[string]string) {
	for t, v := range pairs {
		if _, loaded := i18nShortCache.LoadOrStore(lang+"|"+t, v); !loaded {
			if i18nShortCount.Add(1) > i18nShortMax {
				i18nShortCache = sync.Map{}
				i18nShortCount.Store(0)
				break
			}
		}
	}
}

// i18nShortOverwrite 强制覆写写 LRU（R164：空串占位转正语义——LoadOrStore 命中
// 既有键时 Store 覆写；新键走计数路径。sweep 预热回填/同步补译双路消费）
func i18nShortOverwrite(lang string, pairs map[string]string) {
	for t, v := range pairs {
		key := lang + "|" + t
		if _, loaded := i18nShortCache.LoadOrStore(key, v); loaded {
			i18nShortCache.Store(key, v)
		} else if i18nShortCount.Add(1) > i18nShortMax {
			i18nShortCache = sync.Map{}
			i18nShortCount.Store(0)
			break
		}
	}
}

// ---------- 内容面翻译管线 ----------

// i18nShortTimeoutClient 渲染路径同步补译专用短超时（OpenCC 批量秒级；LLM 语种
// 绝不走同步路径，故 6s 已是宽裕上限）
var i18nShortClient = &http.Client{Timeout: 6 * time.Second}

// i18nTexts 短文本批量翻译（书名/章节标题/简介/最新章节名等；列表页批量消费）。
// zh-CN 原样；zh-Hant 缓存命中直出/未命中同步补译；en/ja/ko 缓存命中直出/未命中原文
// （不触发上游——列表页零 LLM 成本）。
func i18nTexts(lang string, novelID int64, texts []string) []string {
	if lang == "" || lang == "zh-CN" || len(texts) == 0 {
		return texts
	}
	out := make([]string, len(texts))
	copy(out, texts)
	need := make([]string, 0, len(texts))
	seen := map[string]bool{}
	for i, t := range texts {
		if len([]rune(strings.TrimSpace(t))) < 2 {
			continue
		}
		out[i] = t // 占位：下面逐项替换
		if !seen[t] {
			seen[t] = true
			need = append(need, t)
		}
	}
	if len(need) == 0 {
		return out
	}
	// LRU 命中分流
	hits := i18nShortGet(lang, need)
	miss := make([]string, 0, len(need))
	for _, t := range need {
		if _, ok := hits[t]; !ok {
			miss = append(miss, t)
		}
	}
	if len(miss) > 0 {
		// TranslationCache 批量查询（全文寻址，与预热/导出同域）
		keys := make([]string, len(miss))
		for i, t := range miss {
			keys[i] = translateCacheKey(t, lang)
		}
		cached := translateCacheGet(keys)
		rest := make([]string, 0, len(miss))
		for _, t := range miss {
			if c, ok := cached[translateCacheKey(t, lang)]; ok && c != "" {
				hits[t] = c
				i18nShortPut(lang, map[string]string{t: c})
			} else {
				rest = append(rest, t)
			}
		}
		// zh-Hant 未命中：渲染路径同步补译（OpenCC 秒级）；LLM 语种原文兜底
		if lang == "zh-Hant" && len(rest) > 0 {
			const syncBatch = 280
			for start := 0; start < len(rest); start += syncBatch {
				end := start + syncBatch
				if end > len(rest) {
					end = len(rest)
				}
				batch := rest[start:end]
				res, err := i18nSyncTranslate(lang, batch)
				if err != nil {
					break // 上游故障：剩余段全部原文（静默，页面不因翻译故障失败）
				}
				put := map[string]string{}
				batchKeys := make([]string, len(batch))
				missIdx := make([]int, 0, len(batch))
				for i, t := range batch {
					batchKeys[i] = translateCacheKey(t, lang)
					if i < len(res) && res[i] != "" {
						hits[t] = res[i]
						put[t] = res[i]
						missIdx = append(missIdx, i)
					}
				}
				if len(missIdx) > 0 {
					translateCachePut(batch, batchKeys, res, missIdx, novelID)
				}
				if len(put) > 0 {
					i18nShortPut(lang, put)
				}
			}
		} else if lang != "zh-Hant" {
			// LLM 语种未命中段：LRU 空串占位（防重复查缓存；替换循环 v=="" 落原文）
			empty := map[string]string{}
			for _, t := range rest {
				empty[t] = ""
			}
			i18nShortPut(lang, empty)
		}
	}
	for i, t := range texts {
		if v, ok := hits[t]; ok && v != "" {
			out[i] = v
		} else {
			out[i] = t
		}
	}
	return out
}

// i18nSyncTranslate 渲染路径同步上游调用（短超时独立 client，绝不复用 150s 代理 client）
func i18nSyncTranslate(target string, texts []string) ([]string, error) {
	orig := translateUpstreamClient
	translateUpstreamClient = i18nShortClient
	defer func() { translateUpstreamClient = orig }()
	return translateUpstream(target, texts, nil)
}

// i18nMilestoneLabels 里程碑标签语种化（viewsMilestone 产出：label/nextLabel）：
// 字典词条（「一万浏览」族）直查；未命中（动态「N浏览」形态）Tf "浏览{0}" 组装。
func i18nMilestoneLabels(lang string, ms map[string]any) {
	if lang == "" || lang == "zh-CN" {
		return
	}
	trLabel := func(v string) string {
		if v == "" {
			return v
		}
		if tr := tmplT(lang, v); tr != v {
			return tr
		}
		if strings.HasSuffix(v, "浏览") {
			return tmplTf(lang, "浏览{0}", strings.TrimSuffix(v, "浏览"))
		}
		return v
	}
	if lbl, _ := ms["label"].(string); lbl != "" {
		ms["label"] = trLabel(lbl)
	}
	if nl, _ := ms["nextLabel"].(string); nl != "" {
		ms["nextLabel"] = trLabel(nl)
	}
}

// i18nNovelMaps 书籍列表字段就地多语化（home 频道/category/list/search/pseo/toc/book
// Related/LatestChapters 等全部 []map[string]any 消费方的单一入口）：收集非空字段 →
// i18nTexts 批量 → 按原序回写。novelId 归属不携带（缓存全文寻址无书维度，0 即通用桶）。
func i18nNovelMaps(lang string, list []map[string]any, fields ...string) {
	if lang == "" || lang == "zh-CN" || len(list) == 0 || len(fields) == 0 {
		return
	}
	texts := make([]string, 0, len(list)*len(fields))
	for _, m := range list {
		for _, f := range fields {
			if s, _ := m[f].(string); strings.TrimSpace(s) != "" {
				texts = append(texts, s)
			}
		}
	}
	if len(texts) == 0 {
		return
	}
	res := i18nTexts(lang, 0, texts)
	idx := 0
	for _, m := range list {
		for _, f := range fields {
			if s, _ := m[f].(string); strings.TrimSpace(s) != "" {
				if idx < len(res) && res[idx] != "" {
					m[f] = res[idx]
				}
				idx++
			}
		}
	}
}

// ---------- 正文段落管线（chapter 页） ----------

// 异步预热状态：单飞行 + 失败负缓存（30min）
var (
	i18nAsyncInflight sync.Map // key: chapterID|target → true
	i18nAsyncFailed   sync.Map // key: chapterID|target → failUntilMillis
	i18nAsyncSema     chan struct{}
	i18nAsyncOnce     sync.Once
	i18nAsyncClient   = &http.Client{Timeout: 90 * time.Second}
)

// i18nChapterParas 正文段落按语种渲染：zh-Hant 缓存命中/同步补译；en/ja/ko 缓存命中
// 替换、未命中原文兜底 + 触发后台异步预热（下次访问命中）。
func i18nChapterParas(lang string, novelID, chapterID int64, paras []string) []string {
	if lang == "" || lang == "zh-CN" || len(paras) == 0 {
		return paras
	}
	out := make([]string, len(paras))
	copy(out, paras)
	// 正文段落不走 LRU（防挤占书名池）；直查缓存
	need := make([]string, 0, len(paras))
	seen := map[string]bool{}
	for _, p := range paras {
		if len([]rune(strings.TrimSpace(p))) < 2 {
			continue
		}
		if !seen[p] {
			seen[p] = true
			need = append(need, p)
		}
	}
	if len(need) == 0 {
		return out
	}
	keys := make([]string, len(need))
	for i, t := range need {
		keys[i] = translateCacheKey(t, lang)
	}
	cached := translateCacheGet(keys)
	hits := map[string]string{}
	miss := make([]string, 0, len(need))
	for _, t := range need {
		if c, ok := cached[translateCacheKey(t, lang)]; ok && c != "" {
			hits[t] = c
		} else {
			miss = append(miss, t)
		}
	}
	if lang == "zh-Hant" && len(miss) > 0 {
		// 同步补译（OpenCC）+ 回写缓存——与 translatewarm 同语种增量补齐
		const syncBatch = 280
		for start := 0; start < len(miss); start += syncBatch {
			end := start + syncBatch
			if end > len(miss) {
				end = len(miss)
			}
			batch := miss[start:end]
			res, err := i18nSyncTranslate(lang, batch)
			if err != nil {
				break
			}
			batchKeys := make([]string, len(batch))
			missIdx := make([]int, 0, len(batch))
			for i, t := range batch {
				batchKeys[i] = translateCacheKey(t, lang)
				if i < len(res) && res[i] != "" {
					hits[t] = res[i]
					missIdx = append(missIdx, i)
				}
			}
			if len(missIdx) > 0 {
				translateCachePut(batch, batchKeys, res, missIdx, novelID)
			}
		}
	}
	for i, p := range paras {
		if v, ok := hits[p]; ok && v != "" {
			out[i] = v
		}
	}
	// en/ja/ko：未命中段后台异步预热（本页原文兜底，下次访问命中）
	if lang != "zh-Hant" && len(miss) > 0 {
		i18nAsyncWarm(lang, novelID, chapterID, miss)
	}
	return out
}

// i18nWarmChunk 预热上游分片大小（R164）：32 段/片 = 服务端 4 个 LLM 批（8 段/批
// ×并发 2），实测稳在 90s client 超时内；整批单请求形态在 130s 服务截止 vs 90s
// client 下 200+ 段必超时丢整批并触发 30min 负缓存——收敛锁死缺陷的修复参数。
const i18nWarmChunk = 32

// i18nAsyncWarm 后台异步预热（章级单飞行 + 30min 失败负缓存 + 并发闸 2）
func i18nAsyncWarm(lang string, novelID, chapterID int64, texts []string) {
	i18nAsyncWarmKey(lang, strconv.FormatInt(chapterID, 10)+"|"+lang, novelID, texts)
}

// i18nAsyncWarmKey 预热执行体（R164 flightKey 外置）：章级 "<chapterID>|<lang>"
// （i18nChapterParas 既有语义）与 sweep 渲染出口 "<flightBase>|<lang>|<hash>"
// （同批重复请求去重、异页互不挤占）共用一套并发闸 2/失败负缓存/缓存回写。
func i18nAsyncWarmKey(lang, flightKey string, novelID int64, texts []string) {
	i18nAsyncOnce.Do(func() { i18nAsyncSema = make(chan struct{}, 2) })
	key := flightKey
	if v, ok := i18nAsyncFailed.Load(key); ok {
		if until, ok2 := v.(int64); ok2 && nowMillis() < until {
			return
		}
		i18nAsyncFailed.Delete(key)
	}
	if _, loaded := i18nAsyncInflight.LoadOrStore(key, true); loaded {
		return
	}
	go func() {
		defer i18nAsyncInflight.Delete(key)
		i18nAsyncSema <- struct{}{}
		defer func() { <-i18nAsyncSema }()
		ctx, cancel := context.WithTimeout(context.Background(), 80*time.Second)
		defer cancel()
		_ = ctx // 上游超时由 client 兜底；ctx 预留未来按请求传播
		// R164 分片上游调用（每片 i18nWarmChunk 项）：translateUpstream 原版整批单请求——
		// 服务端 LLM 批 8 段/批×并发 2，200+ 段整批在 130s 服务截止内根本跑不完，而
		// 客户端 90s 必先超时 → 错误路径整批丢弃 + 30min 负缓存 → 大页面收敛锁死
		// （实测 en 首页 266 段 150s 后零收敛实锤）。分片后单片 ≤32 段（4 个 LLM 批）
		// 稳在 90s 内，逐片回写缓存渐进收敛；单片失败即止损（已成功片已落缓存），
		// 剩余 miss 集收缩 → sweepFlightHash 换新键 → 后续访问自然续跑。
		okAny := false // R164: 整 flight 零成功判定（上游 429 配额枯竭期服务端仍 ok:true 全空段——
		// 若不计失败，每次访问都空转 90s×N 片持续打配额；零成功=视同失败负缓存 30min，
		// 配额恢复后自动续跑）
		for start := 0; start < len(texts); start += i18nWarmChunk {
			end := start + i18nWarmChunk
			if end > len(texts) {
				end = len(texts)
			}
			orig := translateUpstreamClient
			translateUpstreamClient = i18nAsyncClient
			res, err := translateUpstream(lang, texts[start:end], nil)
			translateUpstreamClient = orig
			if err != nil {
				i18nAsyncFailed.Store(key, nowMillis()+30*60*1000)
				return
			}
			for _, v := range res {
				if v != "" {
					okAny = true
					break
				}
			}
			// R164 跨片节流：429 配额实测（LLM 网关共享配额极紧，整页 flight 一次
			// 打满即后续全 429）——片间 2s 间隔降低突发，最大化配额内成功率
			if end < len(texts) {
				time.Sleep(2 * time.Second)
			}
			keys := make([]string, end-start)
			missIdx := make([]int, 0, end-start)
			short := map[string]string{}
			for i, t := range texts[start:end] {
				keys[i] = translateCacheKey(t, lang)
				if i < len(res) && res[i] != "" {
					missIdx = append(missIdx, i)
					if len([]rune(t)) <= 120 {
						short[t] = res[i]
					}
				}
			}
			if len(missIdx) > 0 {
				translateCachePut(texts[start:end], keys, res, missIdx, novelID)
				// 书名/章节标题/UI 词回填 LRU（正文段落 >120 rune 不进池防挤占；
				// i18nTexts en/ja/ko miss 曾写空串占位阻断 LoadOrStore 命中，此处
				// i18nShortOverwrite 强制 Store 覆写转正——数据面与 sweep 双消费面同时受益）
				if len(short) > 0 {
					i18nShortOverwrite(lang, short)
				}
			}
		}
		if !okAny {
			i18nAsyncFailed.Store(key, nowMillis()+30*60*1000)
		}
	}()
}
