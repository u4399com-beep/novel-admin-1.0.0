"""
广告清洗规则

小说网站常见广告类型:
  1. 内嵌广告段落 (推荐XX小说, 本站最新章节...)
  2. 广告链接/推荐区
  3. 版权/声明文字 (过长可截断)
  4. 阅读提示文字 (请记住本站...)
  5. 重复内容 (同一文字出现多次)
  6. 特殊字符/乱码
  7. HTML标签残留
  8. 编码异常

使用方法:
  cleaner = ContentCleaner()
  clean_text = cleaner.clean(html_text)
  # 或自定义规则
  cleaner.add_rule(CleanRule(pattern=r'推荐.*?小说', rule_type='ad'))
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Pattern

logger = logging.getLogger(__name__)


class RuleType(Enum):
    """规则类型"""
    AD = "ad"                 # 广告内容
    PROMPT = "prompt"         # 提示文字
    COPYRIGHT = "copyright"   # 版权声明
    DUPLICATE = "duplicate"   # 重复内容
    NOISE = "noise"           # 噪声 (特殊字符/乱码)
    TAG = "tag"               # HTML标签残留
    ENCODING = "encoding"     # 编码异常


@dataclass
class CleanRule:
    """清洗规则"""
    pattern: str               # 正则表达式
    rule_type: RuleType        # 规则类型
    replacement: str = ""     # 替换文本
    name: str = ""            # 规则名称 (用于日志)
    compiled: Optional[Pattern] = field(default=None, init=False)
    priority: int = 10         # 优先级 (越小越先执行)

    def __post_init__(self):
        if not self.name:
            self.name = f"{self.rule_type.value}:{self.pattern[:30]}"
        try:
            self.compiled = re.compile(self.pattern, re.IGNORECASE | re.DOTALL)
        except re.error as e:
            logger.error("规则编译失败: %s - %s", self.pattern, e)
            self.compiled = None

    def match(self, text: str) -> Optional[re.Match]:
        if self.compiled is None:
            return None
        return self.compiled.search(text)

    def apply(self, text: str) -> str:
        if self.compiled is None:
            return text
        return self.compiled.sub(self.replacement, text)


class ContentCleaner:
    """
    内容清洗器

    预置了大量小说站点常见广告/噪声的清洗规则,
    支持自定义规则扩展
    """

    # ── 预置广告规则 ──
    PRESET_AD_RULES = [
        # 推荐类广告
        CleanRule(r'(?:最新章节|最新更新|最新网址|最新域名)[：:]?\s*.{0,100}', RuleType.AD, name="最新章节广告"),
        CleanRule(r'(?:推荐|收藏|分享|关注|打赏|投月票|投推荐票).{0,50}(?:小说|阅读|本站|网址)', RuleType.AD, name="推荐类广告"),
        CleanRule(r'(?:手机版|手机端|移动端|APP下载|扫码).{0,80}', RuleType.AD, name="移动端广告"),
        CleanRule(r'(?:本站|本书|本章).{0,20}(?:最快更新|最快|无弹窗|纯文字|无广告| TXT|全文阅读)', RuleType.AD, name="站点推广广告"),
        CleanRule(r'(?:请记住|记住本站|请收藏|收藏本站|加入书签|添加书签).{0,80}', RuleType.AD, name="收藏提示广告"),
        CleanRule(r'https?://[\w.-]+\.(?:com|cn|net|org|cc|la|me|xyz|top|vip|club)/(?:\S{0,100})', RuleType.AD, name="链接广告"),
        CleanRule(r'(?:百度|谷歌|搜狗|神马)搜索.{0,60}(?:小说|本站)', RuleType.AD, name="搜索推广广告"),
        CleanRule(r'(?:微信公众号|关注公众号|公众号).{0,80}', RuleType.AD, name="公众号广告"),
        CleanRule(r'(?:QQ|微信|qq|wechat).{0,20}(?:群|号|交流|讨论).{0,60}', RuleType.AD, name="社交群广告"),

        # 阅读提示
        CleanRule(r'(?:本章未完|未完待续|精彩内容|后续内容|下一章更精彩)', RuleType.PROMPT, name="未完提示"),
        CleanRule(r'(?:天才一秒记住|一秒记住|自动记住|请牢记)', RuleType.PROMPT, name="记住提示"),
        CleanRule(r'(?:更新速度最快|最快更新|无弹窗阅读)', RuleType.PROMPT, name="速度提示"),

        # 版权声明 (截断过长的)
        CleanRule(r'(?:本文由|本章由|内容由).{0,100}(?:提供|整理|发布)', RuleType.COPYRIGHT, name="来源声明"),

        # 弹窗/广告HTML残留
        CleanRule(r'<(?:script|iframe|ins|ad|div)[^>]*(?:class|id)=["\']?[^"\'>]*(?:ad|adv|banner|popup|modal|float)[^"\'>]*["\']?[^>]*>.*?</(?:script|iframe|ins|ad|div)>', RuleType.TAG, name="广告标签", priority=1),
        CleanRule(r'<(?:script|style|noscript)[^>]*>.*?</(?:script|style|noscript)>', RuleType.TAG, name="脚本样式标签", priority=1),

        # 特殊字符噪声
        CleanRule(r'[\u200b\u200c\u200d\ufeff\u00ad]+', RuleType.NOISE, name="零宽字符"),
        CleanRule(r'\s{3,}', ' ', RuleType.NOISE, name="连续空白"),
        CleanRule(r'\n{4,}', '\n\n\n', RuleType.NOISE, name="连续空行"),
    ]

    def __init__(self):
        self._rules: List[CleanRule] = []
        self._custom_rules: List[CleanRule] = []
        # 加载预置规则
        self._rules = sorted(self.PRESET_AD_RULES, key=lambda r: r.priority)

    def add_rule(self, rule: CleanRule) -> None:
        """添加自定义清洗规则"""
        self._custom_rules.append(rule)
        # 重新排序
        self._rules = sorted(self._rules + self._custom_rules, key=lambda r: r.priority)
        logger.debug("添加清洗规则: %s", rule.name)

    def remove_rule(self, name: str) -> bool:
        """按名称移除规则"""
        before = len(self._custom_rules)
        self._custom_rules = [r for r in self._custom_rules if r.name != name]
        self._rules = sorted(self._rules, key=lambda r: r.priority)
        return len(self._custom_rules) < before

    def clean(self, text: str, aggressive: bool = False) -> str:
        """
        清洗文本内容

        Args:
            text: 原始HTML或纯文本
            aggressive: 是否启用激进模式 (更严格去重)

        Returns:
            清洗后的纯文本
        """
        if not text:
            return ""

        result = text

        # 1. HTML标签剥离
        result = self._strip_html(result)

        # 2. 编码规范化
        result = self._normalize_encoding(result)

        # 3. 应用清洗规则 (按优先级)
        for rule in self._rules:
            try:
                new_result = rule.apply(result)
                if new_result != result:
                    logger.debug("规则 [%s] 匹配, 清洗了 %d 字符", rule.name, len(result) - len(new_result))
                result = new_result
            except Exception as e:
                logger.debug("规则 [%s] 执行失败: %s", rule.name, e)

        # 4. 内容去重
        result = self._deduplicate(result, aggressive=aggressive)

        # 5. 最终清洗
        result = self._final_clean(result)

        return result

    def clean_html(self, html_text: str) -> str:
        """
        清洗HTML内容, 保留段落结构

        比 clean() 更温和, 保留必要的段落分隔
        """
        if not html_text:
            return ""

        # 移除script/style
        result = re.sub(r'<(?:script|style|noscript)[^>]*>.*?</(?:script|style|noscript)>', '', html_text, flags=re.DOTALL | re.IGNORECASE)

        # 移除广告相关标签
        result = re.sub(r'<[^>]*(?:class|id)=["\']?[^"\'>]*(?:ad|adv|banner|popup|float|sponsor)[^"\'>]*["\']?[^>]*>.*?</[^>]+>', '', result, flags=re.DOTALL | re.IGNORECASE)

        # 移除注释
        result = re.sub(r'<!--.*?-->', '', result, flags=re.DOTALL)

        # br → \n, p → \n\n, div → \n
        result = re.sub(r'<br\s*/?>', '\n', result, flags=re.IGNORECASE)
        result = re.sub(r'</(?:p|div|section|article|h[1-6])>', '\n', result, flags=re.IGNORECASE)
        result = re.sub(r'<(?:p|div|section|article|h[1-6])[^>]*>', '', result, flags=re.IGNORECASE)

        # 移除所有剩余标签
        result = re.sub(r'<[^>]+>', '', result)

        # 解码HTML实体
        result = self._decode_entities(result)

        # 编码规范化
        result = self._normalize_encoding(result)

        # 应用广告规则
        for rule in self._rules:
            if rule.rule_type in (RuleType.AD, RuleType.PROMPT, RuleType.TAG):
                result = rule.apply(result)

        # 最终清洗
        result = self._final_clean(result)

        return result

    @staticmethod
    def _strip_html(text: str) -> str:
        """去除所有HTML标签"""
        # 移除注释
        text = re.sub(r'<!--.*?-->', '', text, flags=re.DOTALL)
        # br/p/div 转换为换行
        text = re.sub(r'<br\s*/?>\s*', '\n', text, flags=re.IGNORECASE)
        text = re.sub(r'</(?:p|div|li|tr|h[1-6])>\s*', '\n', text, flags=re.IGNORECASE)
        # 移除所有标签
        text = re.sub(r'<[^>]+>', '', text)
        # 解码HTML实体
        text = ContentCleaner._decode_entities(text)
        return text

    @staticmethod
    def _decode_entities(text: str) -> str:
        """解码HTML实体"""
        # 常见HTML实体
        entities = {
            '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&',
            '&quot;': '"', '&#39;': "'", '&apos;': "'",
            '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
            '&copy;': '©', '&reg;': '®', '&trade;': '™',
        }
        for entity, char in entities.items():
            text = text.replace(entity, char)

        # 数字实体 &#1234; &#x1a2b;
        def _replace_num_entity(m):
            try:
                if m.group(1).lower().startswith('x'):
                    code = int(m.group(1)[1:], 16)
                else:
                    code = int(m.group(1))
                return chr(code)
            except (ValueError, OverflowError):
                return m.group(0)

        text = re.sub(r'&#(x?[0-9a-fA-F]+);', _replace_num_entity, text)
        return text

    @staticmethod
    def _normalize_encoding(text: str) -> str:
        """编码规范化"""
        # Unicode NFC规范化
        text = unicodedata.normalize('NFC', text)

        # 全角→半角 (ASCII范围)
        result = []
        for char in text:
            code = ord(char)
            if 0xFF01 <= code <= 0xFF5E:
                result.append(chr(code - 0xFEE0))
            elif code == 0x3000:  # 全角空格
                result.append(' ')
            else:
                result.append(char)
        text = ''.join(result)

        return text

    @staticmethod
    def _deduplicate(text: str, aggressive: bool = False) -> str:
        """
        内容去重

        - 连续重复行 → 保留一行
        - 激进模式: 全文重复段落只保留首次出现
        """
        lines = text.split('\n')

        # 连续重复行去重
        deduped = []
        prev_line = ""
        for line in lines:
            stripped = line.strip()
            if stripped and stripped == prev_line:
                continue  # 跳过连续重复
            deduped.append(line)
            prev_line = stripped

        result = '\n'.join(deduped)

        # 激进模式: 全文段落级去重
        if aggressive:
            paragraphs = result.split('\n\n')
            seen = set()
            unique = []
            for p in paragraphs:
                stripped = p.strip()
                # 生成段落指纹 (前20字符)
                if stripped and len(stripped) > 5:
                    fingerprint = stripped[:20]
                    if fingerprint in seen:
                        continue
                    seen.add(fingerprint)
                unique.append(p)
            result = '\n'.join(unique)

        return result

    @staticmethod
    def _final_clean(text: str) -> str:
        """最终清洗: 空白规范化, 首尾处理"""
        # 每行首尾空白
        lines = [line.strip() for line in text.split('\n')]
        text = '\n'.join(lines)
        # 多个连续空行 → 最多两个
        text = re.sub(r'\n{3,}', '\n\n', text)
        # 首尾
        text = text.strip()
        return text