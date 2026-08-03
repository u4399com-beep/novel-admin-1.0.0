"""
HTML解析器集合

提供三种解析方式:
  1. CSSParser - 基于BeautifulSoup4的CSS选择器解析
  2. XPathParser - 基于lxml的XPath解析
  3. RegexParser - 基于re的正则解析 (带超时保护)

统一输出格式 ParseResult, 支持链式清洗
"""

from __future__ import annotations

import logging
import re
import signal
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union

from bs4 import BeautifulSoup, Tag, NavigableString
from lxml import etree, html

logger = logging.getLogger(__name__)


@dataclass
class ParseResult:
    """统一解析结果"""
    raw: str = ""                  # 原始提取文本
    text: str = ""                  # 清洗后文本
    items: List[str] = field(default_factory=list)  # 列表模式下的多个结果
    attrs: Dict[str, str] = field(default_factory=dict)  # 属性提取
    html: str = ""                  # 提取的HTML片段
    success: bool = False
    error: Optional[str] = None
    parser_type: str = ""           # 使用的解析器类型

    def clean(self) -> 'ParseResult':
        """基础清洗: 去除首尾空白"""
        self.text = self.text.strip()
        self.items = [item.strip() for item in self.items if item.strip()]
        return self

    def __bool__(self) -> bool:
        return self.success


class CSSParser:
    """
    CSS选择器解析器

    基于BeautifulSoup4, 支持所有CSS选择器语法:
      - 标签: div, p, span
      - 类: .class-name
      - ID: #id
      - 属性: [data-id], [href^="https"]
      - 伪类: :nth-child(2n), :first-child
      - 组合: div.content > p.title
    """

    def __init__(self, html_text: str, parser: str = "lxml"):
        """
        初始化CSS解析器

        Args:
            html_text: HTML文本
            parser: BeautifulSoup解析器 (lxml/html.parser/html5lib)
        """
        self._html = html_text
        self._soup = BeautifulSoup(html_text, parser)

    def select_one(self, selector: str) -> Optional[Tag]:
        """选择第一个匹配元素"""
        return self._soup.select_one(selector)

    def select(self, selector: str) -> List[Tag]:
        """选择所有匹配元素"""
        return self._soup.select(selector)

    def select_text(self, selector: str, strip: bool = True) -> ParseResult:
        """
        通过CSS选择器提取文本

        Args:
            selector: CSS选择器
            strip: 是否去除首尾空白

        Returns:
            ParseResult
        """
        try:
            elements = self._soup.select(selector)
            if not elements:
                return ParseResult(success=False, error=f"未找到元素: {selector}", parser_type="css")

            texts = []
            html_parts = []
            for el in elements:
                text = el.get_text(separator="\n", strip=strip)
                texts.append(text)
                html_parts.append(str(el))

            return ParseResult(
                raw=texts[0],
                text="\n".join(texts),
                items=texts,
                html="\n".join(html_parts) if len(html_parts) > 1 else html_parts[0] if html_parts else "",
                success=True,
                parser_type="css",
            )
        except Exception as e:
            return ParseResult(success=False, error=str(e), parser_type="css")

    def select_attr(self, selector: str, attr: str) -> ParseResult:
        """提取元素的属性值"""
        try:
            element = self._soup.select_one(selector)
            if not element:
                return ParseResult(success=False, error=f"未找到元素: {selector}", parser_type="css")

            value = element.get(attr, "")
            if value is None:
                value = ""

            return ParseResult(
                raw=str(value),
                text=str(value),
                attrs={attr: str(value)},
                success=True,
                parser_type="css",
            )
        except Exception as e:
            return ParseResult(success=False, error=str(e), parser_type="css")

    def select_attrs(self, selector: str, attrs: List[str]) -> ParseResult:
        """提取多个元素的多属性"""
        try:
            elements = self._soup.select(selector)
            if not elements:
                return ParseResult(success=False, error=f"未找到元素: {selector}", parser_type="css")

            result_attrs: Dict[str, str] = {}
            for attr in attrs:
                value = elements[0].get(attr, "")
                if value is not None:
                    result_attrs[attr] = str(value)

            return ParseResult(
                raw=str(result_attrs),
                text=elements[0].get_text(strip=True),
                attrs=result_attrs,
                success=True,
                parser_type="css",
            )
        except Exception as e:
            return ParseResult(success=False, error=str(e), parser_type="css")

    def extract_links(self, selector: str = "a[href]", base_url: str = "") -> List[Dict[str, str]]:
        """
        提取链接列表

        Args:
            selector: 链接元素选择器
            base_url: 基础URL (用于相对路径转绝对路径)

        Returns:
            [{"href": "...", "text": "..."}, ...]
        """
        links = []
        for a in self._soup.select(selector):
            href = a.get("href", "")
            text = a.get_text(strip=True)
            if href:
                # 相对路径处理
                if base_url and not href.startswith(("http://", "https://", "//")):
                    href = base_url.rstrip("/") + "/" + href.lstrip("/")
                links.append({"href": href, "text": text})
        return links

    def extract_images(self, selector: str = "img[src]", base_url: str = "") -> List[Dict[str, str]]:
        """提取图片列表"""
        images = []
        for img in self._soup.select(selector):
            src = img.get("src", "") or img.get("data-src", "") or img.get("data-original", "")
            alt = img.get("alt", "")
            if src:
                if base_url and not src.startswith(("http://", "https://", "//", "data:")):
                    src = base_url.rstrip("/") + "/" + src.lstrip("/")
                images.append({"src": src, "alt": alt})
        return images


class XPathParser:
    """
    XPath解析器

    基于lxml, 支持完整的XPath 1.0语法:
      - //div[@class="content"]/p/text()
      - //a[contains(@href, "/chapter/")]/@href
      - //table//tr[position()>1]/td[2]
    """

    def __init__(self, html_text: str):
        """
        初始化XPath解析器

        Args:
            html_text: HTML文本
        """
        self._html = html_text
        try:
            self._tree = html.fromstring(html_text)
        except Exception:
            # 容错: 包裹在html标签中
            self._tree = html.fromstring(f"<html><body>{html_text}</body></html>")

    def select_one(self, xpath: str) -> Optional[Any]:
        """选择第一个匹配节点"""
        try:
            result = self._tree.xpath(xpath)
            if result:
                return result[0]
            return None
        except Exception as e:
            logger.debug("XPath选择失败: %s - %s", xpath, e)
            return None

    def select(self, xpath: str) -> List[Any]:
        """选择所有匹配节点"""
        try:
            return self._tree.xpath(xpath)
        except Exception as e:
            logger.debug("XPath选择失败: %s - %s", xpath, e)
            return []

    def select_text(self, xpath: str) -> ParseResult:
        """
        通过XPath提取文本

        自动处理文本节点和元素节点, 统一返回字符串
        """
        try:
            results = self._tree.xpath(xpath)
            if not results:
                return ParseResult(success=False, error=f"XPath无匹配: {xpath}", parser_type="xpath")

            # 处理不同类型的XPath结果
            texts = []
            for item in results:
                if isinstance(item, str):
                    texts.append(item.strip())
                elif isinstance(item, (int, float)):
                    texts.append(str(item))
                elif hasattr(item, 'text_content'):
                    # lxml Element
                    text = item.text_content().strip()
                    if text:
                        texts.append(text)
                elif item is not None:
                    texts.append(str(item).strip())

            texts = [t for t in texts if t]
            if not texts:
                return ParseResult(success=False, error=f"XPath无文本结果: {xpath}", parser_type="xpath")

            return ParseResult(
                raw=texts[0],
                text="\n".join(texts),
                items=texts,
                success=True,
                parser_type="xpath",
            )
        except Exception as e:
            return ParseResult(success=False, error=f"XPath错误: {e}", parser_type="xpath")

    def select_attr(self, xpath: str) -> ParseResult:
        """通过XPath提取属性"""
        try:
            results = self._tree.xpath(xpath)
            if results:
                value = str(results[0]) if results[0] is not None else ""
                return ParseResult(
                    raw=value, text=value, success=True, parser_type="xpath"
                )
            return ParseResult(success=False, error=f"XPath无匹配: {xpath}", parser_type="xpath")
        except Exception as e:
            return ParseResult(success=False, error=str(e), parser_type="xpath")

    def extract_links(self, xpath: str = "//a[@href]", base_url: str = "") -> List[Dict[str, str]]:
        """通过XPath提取链接"""
        links = []
        try:
            elements = self._tree.xpath(xpath)
            for el in elements:
                if isinstance(el, html.HtmlElement):
                    href = el.get("href", "")
                    text = el.text_content().strip() if el.text else ""
                    if href:
                        if base_url and not href.startswith(("http://", "https://", "//")):
                            href = base_url.rstrip("/") + "/" + href.lstrip("/")
                        links.append({"href": href, "text": text})
        except Exception as e:
            logger.debug("XPath提取链接失败: %s", e)
        return links


class RegexParser:
    """
    正则表达式解析器

    带超时保护, 防止ReDoS攻击导致进程挂起
    """

    # 默认超时(秒)
    DEFAULT_TIMEOUT = 5

    def __init__(self, text: str, timeout: int = DEFAULT_TIMEOUT):
        """
        初始化正则解析器

        Args:
            text: 待匹配文本
            timeout: 正则匹配超时(秒)
        """
        self._text = text
        self._timeout = timeout

    def search(self, pattern: str, flags: int = 0) -> ParseResult:
        """
        正则搜索 (单个匹配)

        Args:
            pattern: 正则表达式
            flags: re模块标志

        Returns:
            ParseResult, attrs中包含所有命名组
        """
        try:
            match = self._safe_re_search(pattern, flags)
            if not match:
                return ParseResult(success=False, error="正则无匹配", parser_type="regex")

            # 提取命名组
            attrs = match.groupdict() if match.groupdict() else {}
            # 提取所有组
            groups = match.groups() or ()

            return ParseResult(
                raw=match.group(0),
                text=match.group(1) if groups else match.group(0),
                items=list(groups),
                attrs=attrs,
                success=True,
                parser_type="regex",
            )
        except TimeoutError:
            return ParseResult(success=False, error=f"正则匹配超时 ({self._timeout}s)", parser_type="regex")
        except re.error as e:
            return ParseResult(success=False, error=f"正则语法错误: {e}", parser_type="regex")
        except Exception as e:
            return ParseResult(success=False, error=str(e), parser_type="regex")

    def findall(self, pattern: str, flags: int = 0) -> ParseResult:
        """正则查找所有匹配"""
        try:
            matches = self._safe_re_findall(pattern, flags)
            if not matches:
                return ParseResult(success=False, error="正则无匹配", parser_type="regex")

            # 统一类型
            if isinstance(matches[0], tuple):
                # 有分组: [(group1, group2), ...]
                items = ["|".join(str(g) for g in m if g) for m in matches]
            else:
                items = [str(m) for m in matches]

            return ParseResult(
                raw=str(matches),
                text=items[0] if items else "",
                items=items,
                success=True,
                parser_type="regex",
            )
        except TimeoutError:
            return ParseResult(success=False, error=f"正则匹配超时 ({self._timeout}s)", parser_type="regex")
        except re.error as e:
            return ParseResult(success=False, error=f"正则语法错误: {e}", parser_type="regex")
        except Exception as e:
            return ParseResult(success=False, error=str(e), parser_type="regex")

    def _safe_re_search(self, pattern: str, flags: int = 0) -> Optional[re.Match]:
        """带超时的正则搜索"""
        result: List[Optional[re.Match]] = [None]

        def _search():
            result[0] = re.search(pattern, self._text, flags)

        self._run_with_timeout(_search)
        return result[0]

    def _safe_re_findall(self, pattern: str, flags: int = 0) -> list:
        """带超时的正则查找"""
        result: list = []

        def _findall():
            nonlocal result
            result = re.findall(pattern, self._text, flags)

        self._run_with_timeout(_findall)
        return result

    def _run_with_timeout(self, func) -> None:
        """在超时限制内运行函数"""
        # 尝试使用信号 (仅Unix)
        try:
            def _handler(signum, frame):
                raise TimeoutError(f"操作超时 ({self._timeout}s)")

            old_handler = signal.signal(signal.SIGALRM, _handler)
            signal.alarm(self._timeout)
            try:
                func()
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)
        except (ValueError, AttributeError):
            # Windows或不支持SIGALRM, 使用线程超时
            import threading
            exception: List[Optional[Exception]] = [None]

            def _thread_func():
                try:
                    func()
                except Exception as e:
                    exception[0] = e

            thread = threading.Thread(target=_thread_func, daemon=True)
            thread.start()
            thread.join(timeout=self._timeout)
            if thread.is_alive():
                raise TimeoutError(f"操作超时 ({self._timeout}s)")
            if exception[0]:
                raise exception[0]
