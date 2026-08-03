"""
HTML解析模块

提供多种解析方式:
  - CSS选择器解析 (BeautifulSoup4)
  - XPath解析 (lxml)
  - 正则解析 (超时保护)
  - 内容清洗 (广告去除/标签剥离/空白规范化)
"""

from .base_parser import CSSParser, XPathParser, RegexParser, ParseResult
from .clean_rules import ContentCleaner, CleanRule

__all__ = [
    "CSSParser",
    "XPathParser",
    "RegexParser",
    "ParseResult",
    "ContentCleaner",
    "CleanRule",
]
