"""
Novel Crawling Task

Multi-stage crawling pipeline for novel sites:
  Stage 1: List page → extract novel links
  Stage 2: Book detail page → extract book info + chapter list
  Stage 3: Chapter content → extract and clean chapter text

Anti-crawl features:
  - Level routing (1-5): escalating countermeasures based on site difficulty
  - Poisson-distributed delays for human-like timing
  - Reading path simulation (homepage → category → detail → directory → content)
  - Proper Referer chain for each navigation step
  - Progress reporting via API callback to main Next.js app
  - Per-chapter retry with exponential backoff
  - Font decoding for Level 4+ sites
  - CAPTCHA solving for Level 5 sites
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import aiohttp

from ..config import AntiCrawlLevel, get_settings
from ..core.fetcher import Fetcher
from ..core.proxy_manager import ProxyManager
from ..core.font_decoder import FontDecoder
from ..core.anti_captcha import CaptchaSolver, CaptchaType
from ..parser.base_parser import CSSParser, XPathParser, ParseResult
from ..parser.clean_rules import ContentCleaner
from ..utils.human_behavior import HumanBehavior

logger = logging.getLogger(__name__)


@dataclass
class NovelInfo:
    """小说信息"""
    title: str = ""
    author: str = ""
    cover_url: str = ""
    description: str = ""
    category: str = ""
    status: str = ""
    tags: List[str] = field(default_factory=list)


@dataclass
class ChapterInfo:
    """章节信息"""
    title: str = ""
    url: str = ""
    order: int = 0


@dataclass
class ChapterContent:
    """章节内容"""
    title: str = ""
    content: str = ""
    word_count: int = 0
    url: str = ""


# 站点解析规则注册表
# 每个站点需要定义: 列表页/详情页/目录页/内容页 的CSS选择器
SITE_RULES: Dict[str, Dict[str, Any]] = {
    # 通用默认规则
    "_default": {
        "novel_list": {
            "selector": "a[href*='novel'], a[href*='book'], a[href*='read']",
            "attr": "href",
            "base_url": "",
        },
        "book_info": {
            "title": ".book-title, .novel-title, h1.book, h1"
                  "meta[property='og:title']::content",
            "author": ".author, .book-author, [class*='author']",
            "cover": ".book-cover img::src, .cover img::src, .book-img img::src",
            "description": ".book-desc, .novel-desc, .intro, .summary, .book-summary",
            "category": ".book-category, .category, .genre",
            "status": ".book-status, .status",
            "tags": ".book-tag, .tag, [class*='tag']",
        },
        "chapter_list": {
            "container": ".chapter-list, .listmain, #list, .catalog-content, .volume-wrap",
            "item": "a[href*='chapter'], a[href*='read'], dd a, li a",
            "attr": "href",
            "title_attr": "text",
        },
        "content": {
            "container": ".bookcontent, #content, .content, .read-content, .chapter-content, #BookText",
            "title": ".book-title, h1, .chapter-title",
        },
    },
}


class NovelCrawler:
    """
    小说爬虫主类

    多阶段管线:
      1. 爬取列表页 → 提取小说链接
      2. 爬取详情页 → 提取书籍信息 + 章节目录
      3. 逐章爬取内容 → 清洗 → 回调
    """

    def __init__(
        self,
        task_id: str,
        site_url: str,
        anti_crawl_level: int = 2,
        site_rules: Optional[Dict[str, Any]] = None,
        callback_url: Optional[str] = None,
        novel_id: Optional[str] = None,
    ):
        self._settings = get_settings()
        self._task_id = task_id
        self._site_url = site_url
        self._level = anti_crawl_level
        self._level_config = self._settings.get_level_config(anti_crawl_level)
        self._site_rules = site_rules or SITE_RULES["_default"]
        self._callback_url = callback_url or self._settings.NEXTJS_CALLBACK_URL
        self._novel_id = novel_id

        # 根据等级初始化组件
        self._proxy_manager: Optional[ProxyManager] = None
        self._font_decoder: Optional[FontDecoder] = None
        self._captcha_solver: Optional[CaptchaSolver] = None
        self._human_behavior = HumanBehavior()
        self._cleaner = ContentCleaner()

        # Level 3+: 启用代理
        if self._level_config.use_proxy:
            self._proxy_manager = ProxyManager()

        # Level 4+: 启用字体解码
        if self._level_config.use_font_decode:
            self._font_decoder = FontDecoder()

        # Level 5+: 启用验证码识别
        if self._level_config.use_captcha_solve:
            self._captcha_solver = CaptchaSolver()

        # 请求引擎 (后创建, 需要proxy_manager)
        self._fetcher: Optional[Fetcher] = None

        # 状态
        self._stats = {
            "total_chapters": 0,
            "crawled_chapters": 0,
            "failed_chapters": 0,
            "total_time_ms": 0,
            "captcha_encountered": 0,
            "captcha_solved": 0,
            "proxy_rotations": 0,
            "font_decoded": 0,
        }

        logger.info(
            "小说爬虫初始化: task=%s, site=%s, level=%d, rules=%s",
            task_id, site_url, anti_crawl_level, list(self._site_rules.keys()),
        )

    def _init_fetcher(self) -> Fetcher:
        """延迟初始化请求引擎"""
        if self._fetcher is None:
            self._fetcher = Fetcher(
                proxy_manager=self._proxy_manager,
                level=self._level,
            )
        return self._fetcher

    # ══════════════════════════════════════════════
    # 主流程
    # ══════════════════════════════════════════════

    async def run(self) -> Dict[str, Any]:
        """
        执行完整爬取流程

        Returns:
            爬取结果统计
        """
        fetcher = self._init_fetcher()
        start_time = time.monotonic()

        try:
            # 报告开始
            await self._report_progress("running", 0, "爬取开始")

            # Stage 1: 爬取小说详情页 (获取书籍信息和章节列表)
            novel_info, chapters = await self._crawl_book_detail(fetcher)

            if not chapters:
                logger.error("未获取到章节列表")
                await self._report_progress("failed", 0, "未获取到章节列表")
                return {"status": "failed", "error": "未获取到章节列表", **self._stats}

            self._stats["total_chapters"] = len(chapters)
            logger.info(
                "获取到 %d 个章节: %s by %s",
                len(chapters), novel_info.title, novel_info.author,
            )

            await self._report_progress(
                "running", 0,
                f"获取到 {len(chapters)} 个章节, 开始爬取内容",
                novel_info=novel_info,
                total_chapters=len(chapters),
            )

            # Stage 2: 逐章爬取内容
            for i, chapter in enumerate(chapters):
                try:
                    content = await self._crawl_chapter(fetcher, chapter, novel_info)

                    if content and content.content:
                        self._stats["crawled_chapters"] += 1

                        # 回调: 提交章节内容
                        await self._report_chapter_content(chapter, content)

                        logger.info(
                            "[%d/%d] %s - %d字",
                            i + 1, len(chapters), chapter.title, content.word_count,
                        )
                    else:
                        self._stats["failed_chapters"] += 1
                        logger.warning("[%d/%d] %s - 内容为空", i + 1, len(chapters), chapter.title)

                except Exception as e:
                    self._stats["failed_chapters"] += 1
                    logger.error("[%d/%d] %s - 爬取失败: %s", i + 1, len(chapters), chapter.title, e)

                # 进度报告
                progress = (i + 1) / len(chapters) * 100
                if (i + 1) % 5 == 0 or i == 0 or i == len(chapters) - 1:
                    await self._report_progress(
                        "running",
                        progress,
                        f"已爬取 {i + 1}/{len(chapters)} 章节",
                    )

                # 行为延迟
                if self._level_config.use_behavior_sim:
                    await self._human_behavior.async_reading_delay(
                        content.word_count if content else 500
                    )
                else:
                    delay = self._level_config.poisson_lambda
                    await self._human_behavior.async_delay(delay)

            # 完成
            self._stats["total_time_ms"] = (time.monotonic() - start_time) * 1000
            await self._report_progress(
                "success", 100,
                f"爬取完成: {self._stats['crawled_chapters']}/{len(chapters)} 章节成功",
            )

            return {
                "status": "success",
                "novel_info": {
                    "title": novel_info.title,
                    "author": novel_info.author,
                },
                **self._stats,
            }

        except Exception as e:
            self._stats["total_time_ms"] = (time.monotonic() - start_time) * 1000
            error_msg = f"爬取异常: {e}"
            logger.error("爬取失败: %s\n%s", e, traceback.format_exc())
            await self._report_progress("failed", 0, error_msg)
            return {"status": "failed", "error": error_msg, **self._stats}

        finally:
            await fetcher.close()
            if self._proxy_manager:
                self._proxy_manager.close()

    # ══════════════════════════════════════════════
    # Stage 1: 书籍详情页
    # ══════════════════════════════════════════════

    async def _crawl_book_detail(
        self, fetcher: Fetcher
    ) -> Tuple[NovelInfo, List[ChapterInfo]]:
        """
        爬取书籍详情页

        提取书籍信息 + 章节列表
        如果是列表页, 先找到小说详情链接
        """
        # 模拟阅读路径: 首页 → 详情页
        parsed = self._parse_url(self._site_url)
        base_url = f"{parsed.scheme}://{parsed.netloc}"

        # 发起请求 (带正确的Referer)
        resp = await fetcher.fetch(
            self._site_url,
            referer=base_url + "/",
            timeout=self._settings.CRAWL_LIST_TIMEOUT,
            expected_content_types=["text/html"],
        )

        if not resp.is_success:
            raise RuntimeError(f"无法访问 {self._site_url}: HTTP {resp.status_code}")

        # 检查是否需要字体解码
        font_url = self._extract_font_url(resp.text)
        if font_url and self._font_decoder:
            resp_text = await self._font_decoder.decode_text(resp.text, font_url)
        else:
            resp_text = resp.text

        # 提取书籍信息
        novel_info = self._extract_novel_info(resp_text, base_url)

        # 提取章节列表
        chapters = self._extract_chapter_list(resp_text, base_url)

        # 如果详情页没有章节列表, 可能有单独的目录页
        if not chapters and novel_info.title:
            logger.info("详情页无章节列表, 尝试查找目录页...")
            # 尝试常见的目录页URL模式
            catalog_patterns = [
                self._site_url.rstrip('/') + '/list',
                self._site_url.rstrip('/') + '/catalog',
                self._site_url.rstrip('/') + '/chapters',
                self._site_url.rstrip('/') + '/directory',
            ]

            # 尝试从页面中找到目录链接
            css_parser = CSSParser(resp_text)
            catalog_links = css_parser.extract_links(
                'a[href*="list"], a[href*="catalog"], a[href*="chapter"], a[href*="mulu"]',
                base_url=base_url,
            )
            if catalog_links:
                catalog_patterns.insert(0, catalog_links[0]['href'])

            for catalog_url in catalog_patterns:
                try:
                    catalog_resp = await fetcher.fetch(
                        catalog_url,
                        referer=self._site_url,
                        timeout=self._settings.CRAWL_LIST_TIMEOUT,
                        expected_content_types=["text/html"],
                    )
                    if catalog_resp.is_success:
                        chapters = self._extract_chapter_list(catalog_resp.text, base_url)
                        if chapters:
                            logger.info("从目录页获取到 %d 个章节: %s", len(chapters), catalog_url)
                            break
                except Exception as e:
                    logger.debug("尝试目录页失败 %s: %s", catalog_url, e)

        return novel_info, chapters

    def _extract_novel_info(self, html: str, base_url: str) -> NovelInfo:
        """从HTML中提取小说信息"""
        parser = CSSParser(html)
        rules = self._site_rules.get("book_info", {})

        info = NovelInfo()

        # 标题: 优先meta og:title, 然后CSS选择器
        title_selectors = rules.get("title", "").split(", ")
        for sel in title_selectors:
            sel = sel.strip()
            if sel.startswith("meta["):
                # meta标签选择器
                xp = XPathParser(html)
                result = xp.select_attr(f'//meta[@property="og:title"]/@content')
                if result.success and result.text:
                    info.title = result.text
                    break
            else:
                result = parser.select_text(sel)
                if result.success and result.text:
                    info.title = result.text
                    break

        if not info.title:
            # Fallback: 取title标签
            xp = XPathParser(html)
            result = xp.select_text("//title/text()")
            if result.success:
                # 清理标题中的站点名
                title = result.text.split("_")[0].split("-")[0].split("|")[0].strip()
                info.title = title

        # 作者
        author_selectors = rules.get("author", "").split(", ")
        for sel in author_selectors:
            sel = sel.strip()
            if not sel:
                continue
            result = parser.select_text(sel)
            if result.success and result.text:
                info.author = result.text
                break

        # 封面
        cover_selectors = rules.get("cover", "").split(", ")
        for sel in cover_selectors:
            sel = sel.strip()
            if "::" in sel:
                tag_sel, attr = sel.rsplit("::", 1)
                result = parser.select_attr(tag_sel.strip(), attr.strip())
            else:
                result = parser.select_attr(sel, "src")
            if result.success and result.text:
                info.cover_url = result.text
                break

        # 简介
        desc_selectors = rules.get("description", "").split(", ")
        for sel in desc_selectors:
            sel = sel.strip()
            if not sel:
                continue
            result = parser.select_text(sel)
            if result.success and len(result.text) > 20:
                info.description = self._cleaner.clean(result.text)
                break

        # 分类
        cat_selectors = rules.get("category", "").split(", ")
        for sel in cat_selectors:
            sel = sel.strip()
            if not sel:
                continue
            result = parser.select_text(sel)
            if result.success and result.text:
                info.category = result.text
                break

        # 标签
        tag_selectors = rules.get("tags", "").split(", ")
        for sel in tag_selectors:
            sel = sel.strip()
            if not sel:
                continue
            elements = parser.select(sel)
            if elements:
                info.tags = [el.get_text(strip=True) for el in elements if el.get_text(strip=True)]
                break

        return info

    def _extract_chapter_list(
        self, html: str, base_url: str
    ) -> List[ChapterInfo]:
        """从HTML中提取章节列表"""
        parser = CSSParser(html)
        rules = self._site_rules.get("chapter_list", {})

        container_sel = rules.get("container", "")
        item_sel = rules.get("item", "a")
        attr = rules.get("attr", "href")

        # 如果指定了容器, 先定位容器
        if container_sel:
            container = parser.select_one(container_sel)
            if container:
                links = container.select(item_sel)
            else:
                links = parser.select(item_sel)
        else:
            links = parser.select(item_sel)

        chapters: List[ChapterInfo] = []
        seen_urls = set()

        for i, link in enumerate(links):
            href = link.get(attr, "")
            if not href:
                continue

            # 构建完整URL
            if href.startswith(("http://", "https://")):
                full_url = href
            elif href.startswith("//"):
                full_url = "https:" + href
            else:
                full_url = base_url.rstrip("/") + "/" + href.lstrip("/")

            # 去重
            if full_url in seen_urls:
                continue
            seen_urls.add(full_url)

            title = link.get_text(strip=True)
            if not title:
                title = link.get("title", f"第{i+1}章")

            chapters.append(ChapterInfo(
                title=title,
                url=full_url,
                order=i,
            ))

        return chapters

    # ══════════════════════════════════════════════
    # Stage 2: 章节内容爬取
    # ══════════════════════════════════════════════

    async def _crawl_chapter(
        self,
        fetcher: Fetcher,
        chapter: ChapterInfo,
        novel_info: NovelInfo,
        retry: int = 0,
    ) -> Optional[ChapterContent]:
        """
        爬取单个章节内容

        带重试机制, 自动处理验证码和字体反爬
        """
        max_retry = self._level_config.retry_times

        try:
            # 阅读路径模拟: 用上一页URL作为Referer
            referer = self._site_url

            resp = await fetcher.fetch(
                chapter.url,
                referer=referer,
                timeout=self._settings.CRAWL_CHAPTER_TIMEOUT,
                expected_content_types=["text/html"],
            )

            if not resp.is_success:
                raise RuntimeError(f"HTTP {resp.status_code}")

            html_text = resp.text

            # 检查验证码
            if self._captcha_solver and self._detect_captcha(html_text):
                self._stats["captcha_encountered"] += 1
                html_text = await self._handle_captcha(fetcher, chapter.url, html_text)
                if html_text:
                    self._stats["captcha_solved"] += 1

            # 字体解码
            if self._font_decoder:
                font_url = self._extract_font_url(html_text)
                if font_url:
                    html_text = await self._font_decoder.decode_text(html_text, font_url)

            # 提取内容
            content = self._extract_chapter_content(html_text)

            if not content:
                raise ValueError("内容提取为空")

            return content

        except Exception as e:
            if retry < max_retry - 1:
                # 指数退避重试
                backoff = min(2 ** retry + 1, 15)
                logger.warning(
                    "章节重试 %d/%d: %s - %s (等待 %.1fs)",
                    retry + 1, max_retry, chapter.title, e, backoff,
                )
                await asyncio.sleep(backoff)
                return await self._crawl_chapter(fetcher, chapter, novel_info, retry + 1)
            else:
                logger.error("章节最终失败: %s - %s", chapter.title, e)
                return None

    def _extract_chapter_content(self, html: str) -> Optional[ChapterContent]:
        """从HTML中提取章节内容"""
        rules = self._site_rules.get("content", {})
        container_sel = rules.get("container", "#content, .content")
        title_sel = rules.get("title", "h1, .chapter-title")

        parser = CSSParser(html)

        # 标题
        title_result = parser.select_text(title_sel)
        title = title_result.text if title_result.success else ""

        # 内容容器
        container = parser.select_one(container_sel)
        if not container:
            # Fallback: 尝试更大的范围
            for fallback_sel in ["#BookText", ".bookcontent", "article", "main"]:
                container = parser.select_one(fallback_sel)
                if container:
                    break

        if not container:
            logger.warning("未找到内容容器: %s", container_sel)
            return None

        # 提取HTML并清洗
        raw_html = str(container)
        cleaned_text = self._cleaner.clean_html(raw_html)

        if not cleaned_text or len(cleaned_text) < 50:
            return None

        return ChapterContent(
            title=title,
            content=cleaned_text,
            word_count=len(cleaned_text),
            url="",
        )

    # ══════════════════════════════════════════════
    # 验证码处理
    # ══════════════════════════════════════════════

    def _detect_captcha(self, html: str) -> bool:
        """检测页面是否包含验证码"""
        captcha_indicators = [
            "captcha", "verify", "验证码", "滑块", "请拖动",
            "geetest", "gt_", "_captcha", "slide-verify",
            "nocaptcha", "NECaptcha", "TCaptcha",
        ]
        html_lower = html.lower()
        return any(indicator.lower() in html_lower for indicator in captcha_indicators)

    async def _handle_captcha(
        self, fetcher: Fetcher, page_url: str, html: str
    ) -> Optional[str]:
        """
        处理验证码

        尝试识别并解决页面中的验证码,
        重新获取验证码后的页面内容

        注意: 大部分第三方验证码(极验/腾讯等)需要Playwright交互
        """
        if not self._level_config.use_playwright:
            logger.warning("验证码需要Playwright支持, 当前等级未启用")
            return None

        # TODO: 具体的验证码交互逻辑 (需要根据目标站点定制)
        # 这里返回None, 实际部署时需要针对具体验证码类型实现
        logger.warning("验证码自动处理尚未实现, 需要针对目标站点定制")
        return None

    # ══════════════════════════════════════════════
    # 字体检测
    # ══════════════════════════════════════════════

    def _extract_font_url(self, html: str) -> Optional[str]:
        """从HTML/CSS中提取自定义字体URL"""
        import re
        pattern = r'@font-face[^}]*?url\([\'"\s]?([^\'"\)]+\.(?:woff2?|ttf|eot))[\'"\s]?\)'
        matches = re.findall(pattern, html, re.IGNORECASE | re.DOTALL)
        if matches:
            # 取第一个自定义字体 (通常是反爬字体)
            for url in matches:
                if 'fontawesome' not in url.lower() and 'icon' not in url.lower():
                    return url
        return None

    # ══════════════════════════════════════════════
    # 回调与进度报告
    # ══════════════════════════════════════════════

    async def _report_progress(
        self,
        status: str,
        progress: float,
        message: str,
        **extra: Any,
    ) -> None:
        """向Next.js主应用报告爬取进度"""
        payload = {
            "taskId": self._task_id,
            "status": status,
            "progress": round(progress, 1),
            "message": message,
            "stats": self._stats,
            **extra,
        }
        await self._send_callback(payload)

    async def _report_chapter_content(
        self, chapter: ChapterInfo, content: ChapterContent
    ) -> None:
        """报告章节内容"""
        payload = {
            "taskId": self._task_id,
            "type": "chapter_content",
            "chapter": {
                "title": content.title or chapter.title,
                "content": content.content,
                "wordCount": content.word_count,
                "url": chapter.url,
                "order": chapter.order,
            },
        }
        await self._send_callback(payload)

    async def _send_callback(self, payload: Dict[str, Any]) -> None:
        """发送回调请求到Next.js主应用"""
        for attempt in range(self._settings.CRAWL_CALLBACK_RETRIES):
            try:
                timeout = aiohttp.ClientTimeout(total=self._settings.CRAWL_CALLBACK_TIMEOUT)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.post(
                        self._callback_url,
                        json=payload,
                        headers={"Content-Type": "application/json"},
                    ) as resp:
                        if resp.status < 500:
                            return
                        logger.warning("回调失败: HTTP %d", resp.status)
            except Exception as e:
                logger.debug("回调异常 (尝试 %d): %s", attempt + 1, e)

            if attempt < self._settings.CRAWL_CALLBACK_RETRIES - 1:
                await asyncio.sleep(1)

    # ══════════════════════════════════════════════
    # 工具方法
    # ══════════════════════════════════════════════

    @staticmethod
    def _parse_url(url: str):
        """解析URL"""
        from urllib.parse import urlparse
        return urlparse(url)


# ══════════════════════════════════════════════════════════
# Celery任务入口 (由main.py注册)
# ══════════════════════════════════════════════════════════

async def _run_crawl_novel(
    task_id: str,
    site_url: str,
    anti_crawl_level: int = 2,
    site_rules: Optional[Dict[str, Any]] = None,
    callback_url: Optional[str] = None,
    novel_id: Optional[str] = None,
) -> Dict[str, Any]:
    """异步执行小说爬取任务 (供Celery wrapper调用)"""
    crawler = NovelCrawler(
        task_id=task_id,
        site_url=site_url,
        anti_crawl_level=anti_crawl_level,
        site_rules=site_rules,
        callback_url=callback_url,
        novel_id=novel_id,
    )
    return await crawler.run()
