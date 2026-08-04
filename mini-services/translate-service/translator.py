"""
Built-in fallback translator for the Translate micro-service.
Provides basic dictionary-based translation for common novel vocabulary
when LibreTranslate is unavailable.

Supports: zh (Chinese), en (English), ja (Japanese), ko (Korean)
Quality level: basic (word/phrase substitution)
"""

import html as html_mod
import re
import unicodedata


# ---------------------------------------------------------------------------
# Language definitions
# ---------------------------------------------------------------------------

LANGUAGES = [
    {"code": "zh", "name": "Chinese"},
    {"code": "en", "name": "English"},
    {"code": "ja", "name": "Japanese"},
    {"code": "ko", "name": "Korean"},
]

# ---------------------------------------------------------------------------
# Character script helpers for language detection
# ---------------------------------------------------------------------------

_CJK_COMMON = set(
    "的一是不了人我在有他这中大来上个国到说们为子和你地出会也时要就可以对生能而那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才反受目太量再感建务做接必场件计管期市直德资命山金指克干近形明满者快始强师望今书阶气"
)

_KATAKANA_RANGE = range(0x30A0, 0x30FF + 1)
_HIRAGANA_RANGE = range(0x3040, 0x309F + 1)

_HANGUL_SYLLABLES = range(0xAC00, 0xD7AF + 1)
_HANGUL_JAMO = range(0x1100, 0x11FF + 1)

_LATIN_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

# ---------------------------------------------------------------------------
# Dictionaries  (~200+ entries each direction, focused on novel vocabulary)
# ---------------------------------------------------------------------------

# en → zh
_EN_ZH = {
    # Greetings / common
    "hello": "你好",
    "goodbye": "再见",
    "thank you": "谢谢你",
    "sorry": "对不起",
    "excuse me": "打扰了",
    "please": "请",
    "yes": "是的",
    "no": "不",
    "okay": "好的",
    "maybe": "也许",
    "i don't know": "我不知道",
    "i see": "我明白了",
    "really": "真的",
    "of course": "当然",
    "certainly": "当然可以",
    "indeed": "的确",
    # Pronouns
    "i": "我",
    "you": "你",
    "he": "他",
    "she": "她",
    "it": "它",
    "we": "我们",
    "they": "他们",
    "my": "我的",
    "your": "你的",
    "his": "他的",
    "her": "她的",
    "our": "我们的",
    "me": "我",
    "him": "他",
    "them": "他们",
    "this": "这",
    "that": "那",
    "these": "这些",
    "those": "那些",
    # Common verbs
    "is": "是",
    "am": "是",
    "are": "是",
    "was": "曾是",
    "were": "曾是",
    "be": "是",
    "have": "有",
    "has": "有",
    "had": "有",
    "do": "做",
    "does": "做",
    "did": "做了",
    "will": "会",
    "would": "会",
    "can": "能",
    "could": "能",
    "should": "应该",
    "may": "可能",
    "might": "也许",
    "must": "必须",
    "need": "需要",
    "want": "想要",
    "like": "喜欢",
    "love": "爱",
    "hate": "恨",
    "know": "知道",
    "think": "认为",
    "believe": "相信",
    "feel": "感觉",
    "see": "看见",
    "look": "看",
    "watch": "注视",
    "hear": "听见",
    "listen": "听",
    "say": "说",
    "tell": "告诉",
    "speak": "说话",
    "talk": "谈话",
    "ask": "问",
    "answer": "回答",
    "come": "来",
    "go": "去",
    "walk": "走",
    "run": "跑",
    "stop": "停止",
    "start": "开始",
    "begin": "开始",
    "end": "结束",
    "finish": "完成",
    "give": "给",
    "take": "拿",
    "bring": "带来",
    "send": "发送",
    "receive": "收到",
    "open": "打开",
    "close": "关闭",
    "read": "阅读",
    "write": "写",
    "eat": "吃",
    "drink": "喝",
    "sleep": "睡觉",
    "wake": "醒来",
    "sit": "坐下",
    "stand": "站",
    "fall": "倒下",
    "die": "死",
    "live": "活",
    "kill": "杀",
    "fight": "打",
    "win": "赢",
    "lose": "输",
    "help": "帮助",
    "try": "尝试",
    "use": "用",
    "find": "找到",
    "lose": "失去",
    "buy": "买",
    "sell": "卖",
    "pay": "付钱",
    "wait": "等待",
    "remember": "记得",
    "forget": "忘记",
    "understand": "理解",
    "learn": "学习",
    "teach": "教",
    "grow": "成长",
    "change": "改变",
    "become": "成为",
    "leave": "离开",
    "return": "回来",
    "arrive": "到达",
    "enter": "进入",
    "turn": "转",
    "follow": "跟随",
    "lead": "带领",
    "hold": "握住",
    "carry": "携带",
    "put": "放",
    "place": "放置",
    "pull": "拉",
    "push": "推",
    "cut": "切",
    "break": "打破",
    "build": "建造",
    "destroy": "毁灭",
    "create": "创造",
    "protect": "保护",
    "attack": "攻击",
    "defend": "防御",
    "escape": "逃跑",
    "hide": "躲藏",
    "search": "搜索",
    "discover": "发现",
    "choose": "选择",
    "decide": "决定",
    "agree": "同意",
    "refuse": "拒绝",
    "promise": "承诺",
    "betray": "背叛",
    "forgive": "原谅",
    "trust": "信任",
    "fear": "害怕",
    "wish": "希望",
    "hope": "希望",
    "pray": "祈祷",
    # Novel-specific
    "sword": "剑",
    "magic": "魔法",
    "power": "力量",
    "king": "国王",
    "queen": "女王",
    "prince": "王子",
    "princess": "公主",
    "knight": "骑士",
    "warrior": "战士",
    "hero": "英雄",
    "villain": "恶棍",
    "enemy": "敌人",
    "monster": "怪物",
    "dragon": "龙",
    "demon": "恶魔",
    "god": "神",
    "goddess": "女神",
    "spirit": "精灵",
    "soul": "灵魂",
    "heaven": "天堂",
    "hell": "地狱",
    "world": "世界",
    "kingdom": "王国",
    "empire": "帝国",
    "castle": "城堡",
    "village": "村庄",
    "city": "城市",
    "forest": "森林",
    "mountain": "山",
    "river": "河",
    "sea": "海",
    "sky": "天空",
    "moon": "月亮",
    "sun": "太阳",
    "star": "星星",
    "fire": "火",
    "water": "水",
    "wind": "风",
    "earth": "大地",
    "ice": "冰",
    "light": "光",
    "darkness": "黑暗",
    "shadow": "影子",
    "night": "夜晚",
    "day": "白天",
    "morning": "早晨",
    "evening": "傍晚",
    "dawn": "黎明",
    "dusk": "黄昏",
    "winter": "冬天",
    "spring": "春天",
    "summer": "夏天",
    "autumn": "秋天",
    "blood": "血",
    "tear": "眼泪",
    "smile": "微笑",
    "laughter": "笑声",
    "cry": "哭泣",
    "death": "死亡",
    "life": "生命",
    "destiny": "命运",
    "fate": "命运",
    "journey": "旅程",
    "battle": "战斗",
    "war": "战争",
    "peace": "和平",
    "love": "爱",
    "friendship": "友谊",
    "revenge": "复仇",
    "secret": "秘密",
    "treasure": "宝藏",
    "adventure": "冒险",
    "danger": "危险",
    "mystery": "谜",
    "ancient": "古老的",
    "eternal": "永恒的",
    "sacred": "神圣的",
    "cursed": "被诅咒的",
    "legend": "传说",
    "prophecy": "预言",
    "master": "大师",
    "student": "学生",
    "teacher": "老师",
    "elder": "长者",
    "child": "孩子",
    "father": "父亲",
    "mother": "母亲",
    "brother": "兄弟",
    "sister": "姐妹",
    "family": "家人",
    "army": "军队",
    "soldier": "士兵",
    "general": "将军",
    "weapon": "武器",
    "armor": "铠甲",
    "shield": "盾牌",
    "bow": "弓",
    "arrow": "箭",
    "spear": "矛",
    "magic spell": "魔咒",
    "potion": "药水",
    "scroll": "卷轴",
    "book": "书",
    "letter": "信",
    "map": "地图",
    "gate": "大门",
    "path": "小路",
    "road": "路",
    "bridge": "桥",
    "tower": "塔",
    "temple": "神殿",
    "throne": "王座",
    "crown": "王冠",
    "jewel": "宝石",
    "gold": "金子",
    "silver": "银子",
    # Time / common adjectives
    "now": "现在",
    "then": "那时",
    "today": "今天",
    "tomorrow": "明天",
    "yesterday": "昨天",
    "always": "总是",
    "never": "从不",
    "sometimes": "有时候",
    "soon": "很快",
    "already": "已经",
    "together": "一起",
    "alone": "独自",
    "here": "这里",
    "there": "那里",
    "everywhere": "到处",
    "nowhere": "无处",
    "everything": "一切",
    "nothing": "什么都没有",
    "something": "一些东西",
    "beautiful": "美丽的",
    "ugly": "丑陋的",
    "strong": "强大的",
    "weak": "虚弱的",
    "fast": "快速的",
    "slow": "缓慢的",
    "big": "大的",
    "small": "小的",
    "old": "老的",
    "new": "新的",
    "good": "好的",
    "bad": "坏的",
    "right": "对的",
    "wrong": "错的",
    "happy": "开心的",
    "sad": "悲伤的",
    "angry": "生气的",
    "afraid": "害怕的",
    "brave": "勇敢的",
    "kind": "善良的",
    "cruel": "残忍的",
    "wise": "聪明的",
    "foolish": "愚蠢的",
    "rich": "富有的",
    "poor": "贫穷的",
    "young": "年轻的",
    "long": "长的",
    "short": "短的",
    "high": "高的",
    "low": "低的",
    "hot": "热的",
    "cold": "冷的",
    "dark": "黑暗的",
    "bright": "明亮的",
    "quiet": "安静的",
    "loud": "嘈杂的",
    "hard": "困难的",
    "easy": "容易的",
    "important": "重要的",
    "strange": "奇怪的",
    "familiar": "熟悉的",
    "dangerous": "危险的",
    "safe": "安全的",
    "powerful": "强大的",
    "simple": "简单的",
    "complex": "复杂的",
    "true": "真实的",
    "false": "虚假的",
    # Common adverbs / conjunctions
    "very": "非常",
    "too": "太",
    "not": "不",
    "also": "也",
    "only": "只",
    "just": "只是",
    "still": "仍然",
    "yet": "然而",
    "again": "再次",
    "ever": "曾经",
    "never": "从不",
    "almost": "几乎",
    "enough": "足够的",
    "quite": "相当",
    "very much": "非常",
    "at all": "根本",
    "in fact": "事实上",
    "for example": "例如",
    "in other words": "换句话说",
    "on the other hand": "另一方面",
    "as a result": "结果",
    "first": "第一",
    "last": "最后",
    "next": "下一个",
    "finally": "最后",
    "suddenly": "突然",
    "slowly": "慢慢地",
    "quickly": "迅速地",
    "carefully": "仔细地",
    "silently": "默默地",
    "happily": "快乐地",
    "sadly": "悲伤地",
    "angrily": "生气地",
    # Common nouns
    "man": "男人",
    "woman": "女人",
    "boy": "男孩",
    "girl": "女孩",
    "person": "人",
    "people": "人们",
    "body": "身体",
    "head": "头",
    "face": "脸",
    "eye": "眼睛",
    "eyes": "眼睛",
    "hand": "手",
    "foot": "脚",
    "heart": "心",
    "mind": "心智",
    "voice": "声音",
    "name": "名字",
    "word": "词",
    "story": "故事",
    "time": "时间",
    "year": "年",
    "month": "月",
    "week": "周",
    "day": "天",
    "hour": "小时",
    "moment": "时刻",
    "place": "地方",
    "room": "房间",
    "door": "门",
    "window": "窗户",
    "table": "桌子",
    "chair": "椅子",
    "bed": "床",
    "food": "食物",
    "water": "水",
    "air": "空气",
    "money": "钱",
    "house": "房子",
    "home": "家",
    "school": "学校",
    "work": "工作",
    "game": "游戏",
    "dream": "梦",
    "memory": "记忆",
    "truth": "真相",
    "lie": "谎言",
    # Novel dialogue / phrases
    "what is your name": "你叫什么名字",
    "my name is": "我的名字是",
    "nice to meet you": "很高兴认识你",
    "how are you": "你好吗",
    "i am fine": "我很好",
    "long time no see": "好久不见",
    "i miss you": "我想你",
    "let's go": "我们走吧",
    "wait for me": "等等我",
    "don't worry": "别担心",
    "it's okay": "没关系",
    "i'm sorry": "对不起",
    "no problem": "没问题",
    "be careful": "小心",
    "good luck": "祝好运",
    "well done": "干得好",
    "i don't understand": "我不明白",
    "can you help me": "你能帮我吗",
    "what happened": "发生了什么",
    "i don't know": "我不知道",
    "tell me": "告诉我",
    "believe me": "相信我",
    "trust me": "信任我",
    "leave me alone": "让我一个人待着",
    "don't move": "别动",
    "come here": "过来",
    "go away": "走开",
    "shut up": "闭嘴",
    "calm down": "冷静下来",
    "wake up": "醒来",
    "be quiet": "安静",
    "look out": "小心",
    "i surrender": "我投降",
    "never give up": "永不放弃",
    "i will protect you": "我会保护你",
    "do you remember": "你记得吗",
    "i remember now": "我现在想起来了",
    "it's too late": "太迟了",
    "there's no time": "没有时间了",
    "we have to go": "我们必须走了",
    "are you ready": "你准备好了吗",
    "i'm ready": "我准备好了",
    "let me think": "让我想想",
    "that's impossible": "那不可能",
    "i can't believe it": "难以置信",
    "what should we do": "我们该怎么办",
    "it's up to you": "由你决定",
    "as you wish": "如你所愿",
    "so be it": "就这样吧",
    "until next time": "下次再见",
    "the end": "结束",
}

# zh → en  (reverse mapping, may override some entries for better quality)
_ZH_EN = {v: k for k, v in _EN_ZH.items()}

# ja → zh  (common Japanese words/novel terms → Chinese)
_JA_ZH = {
    "こんにちは": "你好",
    "さようなら": "再见",
    "ありがとう": "谢谢",
    "すみません": "对不起",
    "おはよう": "早上好",
    "こんばんは": "晚上好",
    "私": "我",
    "あなた": "你",
    "彼": "他",
    "彼女": "她",
    "友達": "朋友",
    "家族": "家人",
    "先生": "老师",
    "学生": "学生",
    "子供": "孩子",
    "男": "男人",
    "女": "女人",
    "父": "父亲",
    "母": "母亲",
    "兄": "哥哥",
    "弟": "弟弟",
    "姉": "姐姐",
    "妹": "妹妹",
    "愛": "爱",
    "愛する": "爱",
    "憎む": "恨",
    "世界": "世界",
    "国": "国家",
    "城": "城堡",
    "村": "村庄",
    "街": "街道",
    "森": "森林",
    "山": "山",
    "川": "河",
    "海": "海",
    "空": "天空",
    "星": "星星",
    "月": "月亮",
    "太陽": "太阳",
    "火": "火",
    "水": "水",
    "風": "风",
    "大地": "大地",
    "光": "光",
    "闇": "黑暗",
    "影": "影子",
    "夜": "夜晚",
    "朝": "早晨",
    "昼": "白天",
    "夕": "傍晚",
    "春": "春天",
    "夏": "夏天",
    "秋": "秋天",
    "冬": "冬天",
    "命": "生命",
    "死": "死亡",
    "血": "血",
    "涙": "眼泪",
    "笑顔": "微笑",
    "笑い": "笑声",
    "涙": "眼泪",
    "運命": "命运",
    "旅": "旅程",
    "冒険": "冒险",
    "戦い": "战斗",
    "戦争": "战争",
    "平和": "和平",
    "剣": "剑",
    "魔法": "魔法",
    "力": "力量",
    "守る": "保护",
    "攻撃": "攻击",
    "防ぐ": "防御",
    "逃げる": "逃跑",
    "隠れる": "躲藏",
    "探す": "搜索",
    "見つける": "发现",
    "選ぶ": "选择",
    "決める": "决定",
    "約束": "承诺",
    "裏切る": "背叛",
    "許す": "原谅",
    "信じる": "信任",
    "恐れる": "害怕",
    "願い": "愿望",
    "希望": "希望",
    "祈る": "祈祷",
    "王": "国王",
    "女王": "女王",
    "王子": "王子",
    "姫": "公主",
    "騎士": "骑士",
    "戦士": "战士",
    "英雄": "英雄",
    "悪者": "恶棍",
    "敵": "敌人",
    "魔王": "魔王",
    "龍": "龙",
    "神": "神",
    "女神": "女神",
    "精霊": "精灵",
    "魂": "灵魂",
    "天国": "天堂",
    "地獄": "地狱",
    "秘密": "秘密",
    "宝": "宝藏",
    "伝説": "传说",
    "予言": "预言",
    "古い": "古老的",
    "永遠": "永恒的",
    "神聖": "神圣的",
    "呪い": "诅咒",
    "先生": "大师",
    "弟子": "弟子",
    "族長": "长老",
    "軍": "军队",
    "兵士": "士兵",
    "将軍": "将军",
    "武器": "武器",
    "鎧": "铠甲",
    "盾": "盾牌",
    "弓": "弓",
    "矢": "箭",
    "槍": "矛",
    "魔法的": "魔法的",
    "薬": "药水",
    "巻物": "卷轴",
    "本": "书",
    "手紙": "信",
    "地図": "地图",
    "門": "大门",
    "道": "路",
    "橋": "桥",
    "塔": "塔",
    "神殿": "神殿",
    "玉座": "王座",
    "王冠": "王冠",
    "宝石": "宝石",
    "金": "金子",
    "銀": "银子",
    "名前": "名字",
    "言葉": "话语",
    "物語": "故事",
    "時間": "时间",
    "夢": "梦",
    "記憶": "记忆",
    "真実": "真相",
    "嘘": "谎言",
    "美しい": "美丽的",
    "強い": "强大的",
    "弱い": "虚弱的",
    "速い": "快速的",
    "遅い": "缓慢的",
    "大きい": "大的",
    "小さい": "小的",
    "古い": "古老的",
    "新しい": "新的",
    "良い": "好的",
    "悪い": "坏的",
    "嬉しい": "开心的",
    "悲しい": "悲伤的",
    "怒り": "愤怒",
    "怖い": "害怕的",
    "勇気": "勇敢",
    "親切": "善良",
    "残酷": "残忍",
    "賢い": "聪明的",
    "愚か": "愚蠢的",
    "豊か": "富有",
    "貧しい": "贫穷",
    "若い": "年轻",
    "長い": "长的",
    "短い": "短的",
    "高い": "高的",
    "低い": "低的",
    "熱い": "热的",
    "冷たい": "冷的",
    "静か": "安静的",
    "危険": "危险的",
    "安全": "安全的",
    "待って": "等等",
    "行こう": "走吧",
    "大丈夫": "没关系",
    "頑張って": "加油",
    "やめて": "停下",
    "動かないで": "别动",
    "逃げろ": "快逃",
    "信じて": "相信我",
    "忘れない": "不会忘记",
    "もう遅い": "太迟了",
    "準備はいい": "准备好了吗",
    "できる": "能做到",
    "無理": "不可能",
    "信じられない": "难以置信",
    "どうする": "怎么办",
    "お任せします": "交给你了",
    "お好きに": "随你便",
    "またね": "下次见",
    "終わり": "结束",
    "始まり": "开始",
}

# ko → zh  (common Korean words/novel terms → Chinese)
_KO_ZH = {
    "안녕하세요": "你好",
    "안녕히 가세요": "再见",
    "감사합니다": "谢谢",
    "죄송합니다": "对不起",
    "좋은 아침": "早上好",
    "저": "我",
    "당신": "你",
    "그": "他",
    "그녀": "她",
    "친구": "朋友",
    "가족": "家人",
    "선생님": "老师",
    "학생": "学生",
    "아이": "孩子",
    "남자": "男人",
    "여자": "女人",
    "아버지": "父亲",
    "어머니": "母亲",
    "형": "哥哥",
    "남동생": "弟弟",
    "누나": "姐姐",
    "여동생": "妹妹",
    "사랑": "爱",
    "미움": "恨",
    "세계": "世界",
    "나라": "国家",
    "성": "城堡",
    "마을": "村庄",
    "도시": "城市",
    "숲": "森林",
    "산": "山",
    "강": "河",
    "바다": "海",
    "하늘": "天空",
    "별": "星星",
    "달": "月亮",
    "태양": "太阳",
    "불": "火",
    "물": "水",
    "바람": "风",
    "대지": "大地",
    "빛": "光",
    "어둠": "黑暗",
    "그림자": "影子",
    "밤": "夜晚",
    "아침": "早晨",
    "낮": "白天",
    "저녁": "傍晚",
    "봄": "春天",
    "여름": "夏天",
    "가을": "秋天",
    "겨울": "冬天",
    "생명": "生命",
    "죽음": "死亡",
    "피": "血",
    "눈물": "眼泪",
    "미소": "微笑",
    "운명": "命运",
    "여행": "旅程",
    "모험": "冒险",
    "전투": "战斗",
    "전쟁": "战争",
    "평화": "和平",
    "검": "剑",
    "마법": "魔法",
    "힘": "力量",
    "보호": "保护",
    "공격": "攻击",
    "방어": "防御",
    "도망": "逃跑",
    "숨기": "躲藏",
    "찾다": "搜索",
    "발견": "发现",
    "선택": "选择",
    "결정": "决定",
    "약속": "承诺",
    "배신": "背叛",
    "용서": "原谅",
    "신뢰": "信任",
    "두려움": "害怕",
    "소원": "愿望",
    "희망": "希望",
    "기도": "祈祷",
    "왕": "国王",
    "여왕": "女王",
    "왕자": "王子",
    "공주": "公主",
    "기사": "骑士",
    "전사": "战士",
    "영웅": "英雄",
    "악당": "恶棍",
    "적": "敌人",
    "마왕": "魔王",
    "용": "龙",
    "신": "神",
    "여신": "女神",
    "정령": "精灵",
    "영혼": "灵魂",
    "천국": "天堂",
    "지옥": "地狱",
    "비밀": "秘密",
    "보물": "宝藏",
    "전설": "传说",
    "예언": "预言",
    "오래된": "古老的",
    "영원": "永恒的",
    "신성한": "神圣的",
    "저주": "诅咒",
    "스승": "大师",
    "제자": "弟子",
    "장로": "长老",
    "군대": "军队",
    "병사": "士兵",
    "장군": "将军",
    "무기": "武器",
    "갑옷": "铠甲",
    "방패": "盾牌",
    "활": "弓",
    "화살": "箭",
    "창": "矛",
    "약": "药水",
    "두루마리": "卷轴",
    "책": "书",
    "편지": "信",
    "지도": "地图",
    "문": "大门",
    "길": "路",
    "다리": "桥",
    "탑": "塔",
    "신전": "神殿",
    "왕좌": "王座",
    "왕관": "王冠",
    "보석": "宝石",
    "금": "金子",
    "은": "银子",
    "이름": "名字",
    "말": "话语",
    "이야기": "故事",
    "시간": "时间",
    "꿈": "梦",
    "기억": "记忆",
    "진실": "真相",
    "거짓": "谎言",
    "아름다운": "美丽的",
    "강한": "强大的",
    "약한": "虚弱的",
    "빠른": "快速的",
    "느린": "缓慢的",
    "큰": "大的",
    "작은": "小的",
    "좋은": "好的",
    "나쁜": "坏的",
    "행복한": "开心的",
    "슬픈": "悲伤的",
    "화난": "生气的",
    "무서운": "害怕的",
    "용감한": "勇敢的",
    "착한": "善良的",
    "잘생긴": "聪明的",
    "부자": "富有",
    "가난한": "贫穷",
    "젊은": "年轻",
    "긴": "长的",
    "짧은": "短的",
    "높은": "高的",
    "낮은": "低的",
    "뜨거운": "热的",
    "차가운": "冷的",
    "조용한": "安静的",
    "위험한": "危险的",
    "안전한": "安全的",
    "기다려": "等等",
    "가자": "走吧",
    "괜찮아": "没关系",
    "힘내": "加油",
    "멈춰": "停下",
    "움직이지 마": "别动",
    "도망쳐": "快逃",
    "믿어": "相信我",
    "잊지 않을": "不会忘记",
    "늦었다": "太迟了",
    "준비됐어": "准备好了",
    "불가능해": "不可能",
    "믿을 수 없어": "难以置信",
    "어떡해": "怎么办",
    "맡길게": "交给你了",
    "또 보자": "下次见",
    "끝": "结束",
    "시작": "开始",
}

# Build reverse mappings for ja↔zh, ko↔zh
_JA_EN = {v: k for k, v in _JA_ZH.items()}  # ja→zh reversed gives zh→ja
_ZH_JA = {v: k for k, v in _JA_ZH.items()}  # ja→zh value→key
_KO_EN = {v: k for k, v in _KO_ZH.items()}
_ZH_KO = {v: k for k, v in _KO_ZH.items()}

# en → ja (via en→zh→ja)
_EN_JA = {}
for en_w, zh_w in _EN_ZH.items():
    if zh_w in _ZH_JA:
        _EN_JA[en_w] = _ZH_JA[zh_w]

# en → ko (via en→zh→ko)
_EN_KO = {}
for en_w, zh_w in _EN_ZH.items():
    if zh_w in _ZH_KO:
        _EN_KO[en_w] = _ZH_KO[zh_w]

# Build all lookup tables: (source, target) → dict
_LOOKUP = {
    ("en", "zh"): _EN_ZH,
    ("zh", "en"): _ZH_EN,
    ("ja", "zh"): _JA_ZH,
    ("zh", "ja"): _ZH_JA,
    ("ko", "zh"): _KO_ZH,
    ("zh", "ko"): _ZH_KO,
    ("en", "ja"): _EN_JA,
    ("ja", "en"): _JA_EN,
    ("en", "ko"): _EN_KO,
    ("ko", "en"): _KO_EN,
}

# For same-language pairs, identity
for lang in ("zh", "en", "ja", "ko"):
    _LOOKUP[(lang, lang)] = {}


class BasicTranslator:
    """
    Basic dictionary-based translator for common novel vocabulary.
    Supports: zh, en, ja, ko
    Quality: basic (word/phrase substitution) — not full machine translation.
    """

    def translate(self, text: str, source: str, target: str) -> dict:
        """
        Translate text using dictionary lookup.

        Returns: {"translated_text": str, "source": str, "target": str, "confidence": float}
        """
        if not text or not text.strip():
            return {
                "translated_text": "",
                "source": source,
                "target": target,
                "confidence": 1.0,
            }

        if source == target:
            return {
                "translated_text": text,
                "source": source,
                "target": target,
                "confidence": 1.0,
            }

        table = _LOOKUP.get((source, target))
        if table is None:
            return {
                "translated_text": text,
                "source": source,
                "target": target,
                "confidence": 0.0,
            }

        translated = self._translate_text(text, table)
        return {
            "translated_text": translated,
            "source": source,
            "target": target,
            "confidence": 0.35,  # Basic dictionary translation confidence
        }

    def detect(self, text: str) -> dict:
        """
        Detect the language of the given text.

        Returns: {"detected_language": str, "confidence": float}
        """
        if not text or not text.strip():
            return {"detected_language": "en", "confidence": 0.0}

        scores = {"zh": 0.0, "en": 0.0, "ja": 0.0, "ko": 0.0}
        total_chars = 0

        for char in text:
            if char.isspace() or char in ".,;:!?\"'()[]{}-—…·、。？！""''（）【】《》":
                continue
            total_chars += 1
            cp = ord(char)

            # Katakana → Japanese
            if cp in _KATAKANA_RANGE:
                scores["ja"] += 3.0
            # Hiragana → Japanese
            elif cp in _HIRAGANA_RANGE:
                scores["ja"] += 3.0
            # Hangul → Korean
            elif cp in _HANGUL_SYLLABLES or cp in _HANGUL_JAMO:
                scores["ko"] += 3.0
            # Latin → English
            elif char in _LATIN_CHARS:
                scores["en"] += 1.0
            # CJK common characters — ambiguous
            elif char in _CJK_COMMON:
                # If there are already Japanese/Korean markers, this is likely them
                scores["zh"] += 1.0
                scores["ja"] += 0.3
                scores["ko"] += 0.3
            elif unicodedata.category(char).startswith("Lo"):
                # Other CJK characters not in our set
                scores["zh"] += 1.0
                scores["ja"] += 0.5
                scores["ko"] += 0.3

        if total_chars == 0:
            return {"detected_language": "en", "confidence": 0.0}

        # Normalize
        for lang in scores:
            scores[lang] /= total_chars

        best_lang = max(scores, key=scores.get)
        confidence = min(round(scores[best_lang], 4), 1.0)

        return {"detected_language": best_lang, "confidence": confidence}

    def get_languages(self) -> list:
        """Return the list of supported languages."""
        return LANGUAGES

    # ------------------------------------------------------------------
    # Internal methods
    # ------------------------------------------------------------------

    def _translate_text(self, text: str, table: dict) -> str:
        """
        Translate text using the dictionary table.
        Handles paragraph-by-paragraph for long texts.
        """
        # Split into paragraphs on double newline
        paragraphs = re.split(r"\n{2,}", text)
        translated_paragraphs = [self._translate_paragraph(p, table) for p in paragraphs]
        return "\n\n".join(translated_paragraphs)

    def _translate_paragraph(self, text: str, table: dict) -> str:
        """
        Translate a paragraph using dictionary lookup.

        For Latin-based source languages (en): uses word-boundary regex so
        substrings like "end" inside "friend" are not matched.
        For CJK-based source languages (zh, ja, ko): uses longest-match-first
        substring replacement since CJK has no word-boundary delimiters.
        """
        if not table:
            return text

        # 1. Multi-word phrase replacement (phrases containing spaces)
        multi_phrases = sorted(
            (k for k in table if " " in k and len(k) > 1),
            key=len, reverse=True,
        )
        result = text
        for phrase in multi_phrases:
            pattern = re.compile(re.escape(phrase), re.IGNORECASE)
            result = pattern.sub(table[phrase], result)

        # 2. Single-word replacement — strategy depends on source script
        single_words = sorted(
            (k for k in table if " " not in k and k),
            key=len, reverse=True,
        )

        # Detect if source text is primarily CJK
        _is_cjk = any(
            unicodedata.category(ch).startswith("Lo") or ord(ch) > 0x3000
            for ch in text[:20] if not ch.isspace()
        )

        if _is_cjk:
            # CJK: longest-match substring replacement (greedy)
            for word in single_words:
                result = result.replace(word, table[word])
        else:
            # Latin: word-boundary regex to avoid substring false positives
            for word in single_words:
                pattern = re.compile(r"\b" + re.escape(word) + r"\b", re.IGNORECASE)
                result = pattern.sub(table[word], result)

        return result


def translate_html(text: str, source: str, target: str, translator: BasicTranslator) -> dict:
    """
    Translate HTML content while preserving tags.
    Splits text into tag/non-tag segments, only translates non-tag segments.
    """
    # Split into HTML tags and text segments
    parts = re.split(r'(<[^>]+>)', text)

    translated_parts = []
    for part in parts:
        if part.startswith("<") and part.endswith(">"):
            # HTML tag — preserve as-is
            translated_parts.append(part)
        elif part.strip():
            # Text content — translate
            result = translator.translate(part, source, target)
            translated_parts.append(result["translated_text"])
        else:
            translated_parts.append(part)

    translated_text = "".join(translated_parts)

    return {
        "translated_text": translated_text,
        "source": source,
        "target": target,
        "confidence": 0.35,
    }
