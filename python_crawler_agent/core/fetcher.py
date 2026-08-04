 unified request engine

Unified network request layer integrating:
  - curl_cffi: TLS/JA3 fingerprint impersonation for static pages
  - Playwright + stealth: dynamic rendering with browser fingerprint masking
  - Automatic engine selection based on anti-crawl level
  - Full browser header sets with sec-ch-ua, sec-fetch-*, etc.
  - Exponential backoff retry with response validation
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

from curl_cffi import requests as cffi_requests
from fake_useragent import UserAgent

from ..config import AntiCrawlLevelConfig, get_settings

logger = logging.getLogger(__name__)


@dataclass
class FetchResponse:
    """统一的响应对象"""
    url: str
    status_code: int
    headers: Dict[str, str]
    text: str
    content: bytes
    elapsed_ms: float
    engine: str  # "curl_cffi" 或 "playwright"
    cookies: Dict[str, str] = field(default_factory=dict)

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    @property
    def content_length(self) -> int:
        return len(self.content)


class Fetcher:
    """
    统一请求引擎

    根据反爬等级自动选择请求方式:
      - Level 1-2: curl_cffi (TLS指纹模拟)
      - Level 3+: Playwright (动态渲染 + 隐身)
    """

    # 浏览器安全头集合, 模拟真实Chrome访问
    SECURE_HEADERS = {
        "sec-ch-ua": '"Not A(Brand";v="99", "Google Chrome";v="120", "Chromium";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,image/apng,*/*;q=0.8,"
            "application/signed-exchange;v=b3;q=0.7"
        ),
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "cache-control": "max-age=0",
    }

    # 各TLS指纹对应的sec-ch-ua头
    TLS_SEC_CH_UA = {
        "chrome120": '"Not A(Brand";v="99", "Google Chrome";v="120", "Chromium";v="120"',
        "chrome116": '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
        "safari17_0": (
            '"Not A(Brand";v="99", "Safari";v="17.0", "Version";v="17.0"'
        ),
        "edge101": (
            '"Not A(Brand";v="99", "Microsoft Edge";v="101", "Chromium";v="101"'
        ),
    }

    def __init__(self, proxy_manager=None, level: int = 2):
        """
        初始化请求引擎

        Args:
            proxy_manager: 代理管理器实例 (可选)
            level: 反爬等级 (1-5)
        """
        self._settings = get_settings()
        self._proxy_manager = proxy_manager
        self._level_config = self._settings.get_level_config(level)
        self._level = level

        # User-Agent 生成器
        try:
            self._ua = UserAgent(fallback="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        except Exception:
            self._ua = UserAgent(fallback="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

        # Playwright 相关
        self._playwright = None
        self._browser = None
        self._stealth_js = ""

        # 会话cookie池 (用于保持登录态)
        self._session_cookies: Dict[str, Dict[str, str]] = {}

    def _build_headers(self, impersonate: Optional[str] = None) -> Dict[str, str]:
        """
        构建完整的浏览器请求头

        Args:
            impersonate: TLS指纹类型 (chrome120/safari17_0/edge101)

        Returns:
            完整的HTTP头字典
        """
        headers = dict(self.SECURE_HEADERS)

        # 设置User-Agent (与TLS指纹一致)
        ua = self._ua.chrome
        headers["user-agent"] = ua

        # 根据TLS指纹类型调整sec-ch-ua
        if impersonate and impersonate in self.TLS_SEC_CH_UA:
            headers["sec-ch-ua"] = self.TLS_SEC_CH_UA[impersonate]
            # Safari的UA和sec-ch-ua-platform不同
            if impersonate.startswith("safari"):
                ua = self._ua.safari
                headers["user-agent"] = ua
                headers["sec-ch-ua-platform"] = '"macOS"'
            elif impersonate.startswith("edge"):
                ua = ua.replace("Chrome", "Edg")
                headers["user-agent"] = ua

        return headers

    def _pick_impersonate(self) -> str:
        """随机选择一个TLS指纹"""
        return random.choice(self._settings.TLS_IMPERSONATE)

    def _get_proxy(self, domain: str) -> Optional[str]:
        """获取代理地址"""
        if not self._proxy_manager or not self._level_config.use_proxy:
            return None
        try:
            proxy = self._proxy_manager.get_proxy(domain)
            return proxy
        except Exception as e:
            logger.warning("获取代理失败: %s", e)
            return None

    def _validate_response(
        self,
        resp: FetchResponse,
        expected_content_types: Optional[list] = None,
        min_size: int = 100,
        max_size: int = 5 * 1024 * 1024,  # 5MB
    ) -> bool:
        """
        验证响应内容

        Args:
            resp: 响应对象
            expected_content_types: 期望的内容类型列表
            min_size: 最小内容长度
            max_size: 最大内容长度

        Returns:
            验证是否通过
        """
        # 状态码检查
        if not resp.is_success:
            logger.warning("响应状态码异常: %d for %s", resp.status_code, resp.url)
            return False

        # 内容类型检查
        if expected_content_types:
            ct = resp.headers.get("content-type", "").lower()
            if not any(t in ct for t in expected_content_types):
                logger.warning("内容类型不匹配: %s (期望: %s)", ct, expected_content_types)
                return False

        # 大小检查
        size = resp.content_length
        if size < min_size:
            logger.warning("响应内容过小: %d bytes for %s", size, resp.url)
            return False
        if size > max_size:
            logger.warning("响应内容过大: %d bytes for %s", size, resp.url)
            return False

        return True

    async def fetch(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        cookies: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        timeout: int = 30,
        expected_content_types: Optional[list] = None,
        referer: Optional[str] = None,
        use_playwright: Optional[bool] = None,
        wait_selector: Optional[str] = None,
        wait_time: Optional[int] = None,
    ) -> FetchResponse:
        """
        统一请求入口, 自动选择引擎

        Args:
            url: 请求URL
            method: HTTP方法
            headers: 自定义头 (会与默认头合并)
            cookies: 自定义cookie
            params: URL参数
            data: 表单数据
            json: JSON数据
            timeout: 超时(秒)
            expected_content_types: 期望的内容类型
            referer: Referer头
            use_playwright: 强制使用Playwright (None=自动选择)
            wait_selector: Playwright等待的选择器
            wait_time: Playwright等待时间(毫秒)

        Returns:
            FetchResponse 统一响应对象
        """
        # 自动选择引擎
        if use_playwright is None:
            use_playwright = self._level_config.use_playwright

        # 合并Referer
        extra_headers = dict(headers) if headers else {}
        if referer:
            extra_headers["referer"] = referer
            # 有Referer时, sec-fetch-site应为cross-site或same-origin
            if "same-site" in url or (referer and new_url_same_domain(referer, url)):
                extra_headers["sec-fetch-site"] = "same-origin"
            else:
                extra_headers["sec-fetch-site"] = "cross-site"

        # 根据引擎分发
        if use_playwright:
            return await self._fetch_playwright(
                url=url,
                method=method,
                headers=extra_headers,
                cookies=cookies,
                params=params,
                data=data,
                json_data=json,
                timeout=timeout,
                expected_content_types=expected_content_types,
                wait_selector=wait_selector,
                wait_time=wait_time,
            )
        else:
            return await self._fetch_curl_cffi(
                url=url,
                method=method,
                headers=extra_headers,
                cookies=cookies,
                params=params,
                data=data,
                json_data=json,
                timeout=timeout,
                expected_content_types=expected_content_types,
            )

    async def _fetch_curl_cffi(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        cookies: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        timeout: int = 30,
        expected_content_types: Optional[list] = None,
    ) -> FetchResponse:
        """
        curl_cffi请求引擎 - TLS/JA3指纹模拟

        使用curl_cffi模拟真实浏览器的TLS握手特征,
        绕过基于JA3指纹的WAF检测
        """
        impersonate = self._pick_impersonate()
        default_headers = self._build_headers(impersonate)

        # 合并自定义头
        if headers:
            default_headers.update(headers)

        # 获取代理
        proxy = self._get_proxy(url)
        proxies = {"http": proxy, "https": proxy} if proxy else None

        last_error: Optional[Exception] = None
        retry_times = self._level_config.retry_times

        for attempt in range(retry_times):
            try:
                start = time.monotonic()

                # 使用curl_cffi发起请求, 模拟指定浏览器的TLS指纹
                resp = cffi_requests.request(
                    method=method,
                    url=url,
                    headers=default_headers,
                    cookies=cookies or self._session_cookies.get(url),
                    params=params,
                    data=data,
                    json=json_data,
                    timeout=timeout,
                    impersonate=impersonate,
                    proxies=proxies,
                    verify=True,
                )

                elapsed = (time.monotonic() - start) * 1000

                result = FetchResponse(
                    url=str(resp.url),
                    status_code=resp.status_code,
                    headers=dict(resp.headers),
                    text=resp.text or "",
                    content=resp.content or b"",
                    elapsed_ms=elapsed,
                    engine="curl_cffi",
                    cookies=dict(resp.cookies) if resp.cookies else {},
                )

                # 保存会话cookie
                if result.cookies:
                    self._session_cookies[url] = result.cookies

                # 验证响应
                if self._validate_response(result, expected_content_types):
                    # 代理成功
                    if proxy and self._proxy_manager:
                        self._proxy_manager.report_success(proxy, url)
                    return result
                else:
                    # 响应验证失败, 可能被反爬
                    if proxy and self._proxy_manager:
                        self._proxy_manager.report_failure(proxy, url)
                    last_error = ValueError(f"响应验证失败: status={result.status_code}, size={result.content_length}")

            except Exception as e:
                last_error = e
                logger.warning(
                    "curl_cffi请求失败 (尝试 %d/%d): %s - %s",
                    attempt + 1, retry_times, url, e
                )
                if proxy and self._proxy_manager:
                    self._proxy_manager.report_failure(proxy, url)

            # 指数退避
            if attempt < retry_times - 1:
                backoff = min(2 ** attempt + random.uniform(0.5, 1.5), 30)
                logger.info("退避等待 %.1f 秒后重试...", backoff)
                await asyncio.sleep(backoff)

        # 所有重试失败
        error_msg = f"请求失败 (重试{retry_times}次): {url} - {last_error}"
        logger.error(error_msg)
        raise RuntimeError(error_msg) from last_error

    async def _fetch_playwright(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[Dict[str, str]] = None,
        cookies: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        timeout: int = 30,
        expected_content_types: Optional[list] = None,
        wait_selector: Optional[str] = None,
        wait_time: Optional[int] = None,
    ) -> FetchResponse:
        """
        Playwright请求引擎 - 动态渲染 + 浏览器隐身

        使用playwright-stealth插件隐藏自动化特征:
      - navigator.webdriver = false
      - chrome.runtime伪造
      - permissions查询伪装
      - 插件列表伪造
      """
        from playwright.async_api import async_playwright

        impersonate = self._pick_impersonate()
        default_headers = self._build_headers(impersonate)
        if headers:
            default_headers.update(headers)

        proxy = self._get_proxy(url)

        last_error: Optional[Exception] = None
        retry_times = self._level_config.retry_times

        for attempt in range(retry_times):
            context = None
            page = None
            try:
                start = time.monotonic()

                async with async_playwright() as pw:
                    # 浏览器启动参数 - 最大化真实感
                    launch_args = {
                        "headless": self._settings.PLAYWRIGHT_HEADLESS,
                        "args": [
                            "--disable-blink-features=AutomationControlled",
                            "--disable-infobars",
                            "--no-first-run",
                            "--no-default-browser-check",
                            "--disable-extensions",
                            "--disable-component-extensions-with-background-pages",
                            f"--window-size={self._settings.PLAYWRIGHT_VIEWPORT['width']},{self._settings.PLAYWRIGHT_VIEWPORT['height']}",
                            "--lang=zh-CN",
                            "--disable-features=IsolateOrigins,site-per-process",
                        ],
                    }

                    # 代理配置
                    if proxy:
                        launch_args["proxy"] = {"server": proxy}

                    browser = await pw.chromium.launch(**launch_args)

                    # BrowserContext 隔离 - 独立cookie空间
                    context = await browser.new_context(
                        viewport=self._settings.PLAYWRIGHT_VIEWPORT,
                        locale=self._settings.PLAYWRIGHT_LOCALE,
                        timezone_id=self._settings.PLAYWRIGHT_TIMEZONE_ID,
                        user_agent=default_headers.get("user-agent", ""),
                        extra_http_headers={
                            k: v for k, v in default_headers.items()
                            if k.lower() != "user-agent"
                        },
                        bypass_csp=True,
                        java_script_enabled=True,
                    )

                    # 注入隐身脚本
                    if self._level_config.use_stealth:
                        await context.add_init_script(self._get_stealth_script())

                    # 设置cookie
                    if cookies:
                        cookie_list = [
                            {"name": k, "value": v, "domain": "", "path": "/"}
                            for k, v in cookies.items()
                        ]
                        await context.add_cookies(cookie_list)

                    page = await context.new_page()

                    # 设置超时
                    page.set_default_timeout(timeout * 1000)
                    page.set_default_navigation_timeout(timeout * 1000)

                    # 导航到目标URL
                    response = await page.goto(url, wait_until="domcontentloaded")

                    # 等待选择器或延迟
                    if wait_selector:
                        await page.wait_for_selector(wait_selector, timeout=timeout * 1000)
                    if wait_time:
                        await page.wait_for_timeout(wait_time)

                    # 获取页面内容
                    content = await page.content()
                    resp_headers = await page.evaluate(
                        """() => {
                            // 从performance API获取响应头
                            const entries = performance.getEntriesByType('navigation');
                            return entries.length > 0 ? {} : {};
                        }"""
                    )

                    elapsed = (time.monotonic() - start) * 1000

                    result = FetchResponse(
                        url=page.url,
                        status_code=response.status if response else 0,
                        headers=resp_headers or {},
                        text=content,
                        content=content.encode("utf-8", errors="replace"),
                        elapsed_ms=elapsed,
                        engine="playwright",
                    )

                    # 验证响应
                    if self._validate_response(result, expected_content_types):
                        if proxy and self._proxy_manager:
                            self._proxy_manager.report_success(proxy, url)
                        return result
                    else:
                        if proxy and self._proxy_manager:
                            self._proxy_manager.report_failure(proxy, url)
                        last_error = ValueError(f"Playwright响应验证失败")

            except Exception as e:
                last_error = e
                logger.warning(
                    "Playwright请求失败 (尝试 %d/%d): %s - %s",
                    attempt + 1, retry_times, url, e
                )
                if proxy and self._proxy_manager:
                    self._proxy_manager.report_failure(proxy, url)

            finally:
                # 确保清理资源
                try:
                    if page:
                        await page.close()
                    if context:
                        await context.close()
                except Exception:
                    pass

            # 指数退避
            if attempt < retry_times - 1:
                backoff = min(2 ** attempt + random.uniform(1.0, 3.0), 60)
                logger.info("Playwright退避等待 %.1f 秒...", backoff)
                await asyncio.sleep(backoff)

        error_msg = f"Playwright请求失败 (重试{retry_times}次): {url} - {last_error}"
        logger.error(error_msg)
        raise RuntimeError(error_msg) from last_error

    def _get_stealth_script(self) -> str:
        """
        获取浏览器隐身JavaScript脚本

        隐藏Playwright/Puppeteer自动化特征:
        - navigator.webdriver = undefined
        - chrome.runtime存在性伪造
        - navigator.plugins伪造
        - WebGL渲染器信息伪造
        """
        return """
        // ===== navigator.webdriver 隐藏 =====
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true
        });

        // ===== chrome.runtime 伪造 =====
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) {
            window.chrome.runtime = {
                connect: function() { return { onMessage: { addListener: function() {} } }; },
                sendMessage: function() {},
                id: undefined
            };
        }

        // ===== navigator.plugins 伪造 =====
        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const plugins = [
                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                ];
                plugins.length = 3;
                return plugins;
            },
            configurable: true
        });

        // ===== navigator.languages 伪造 =====
        Object.defineProperty(navigator, 'languages', {
            get: () => ['zh-CN', 'zh', 'en-US', 'en'],
            configurable: true
        });

        // ===== Permissions API 伪装 =====
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
                Promise.resolve({ state: Notification.permission }) :
                originalQuery(parameters)
        );

        // ===== WebGL 渲染器信息伪造 =====
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Google Inc. (NVIDIA)';
            if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return getParameter.call(this, parameter);
        };

        // ===== 隐藏自动化相关属性 =====
        delete window.__playwright_evaluation_script__;
        delete window.__puppeteer_evaluation_script__;

        // ===== 伪造toString, 防止检测wrapped函数 =====
        const nativeToString = Function.prototype.toString;
        const fns = new Map();
        Function.prototype.toString = function() {
            if (fns.has(this)) return fns.get(this);
            return nativeToString.call(this);
        };
        // 保存原始函数引用
        const originalFunctions = [
            [navigator.permissions.query, 'function query() { [native code] }'],
        ];
        for (const [fn, str] of originalFunctions) {
            fns.set(fn, str);
        }
        """

    async def close(self):
        """清理资源"""
        self._session_cookies.clear()
        logger.info("Fetcher资源已清理")


# ── 工具函数 ──

def new_url_same_domain(referer: str, url: str) -> bool:
    """检查两个URL是否同域"""
    try:
        from urllib.parse import urlparse
        r = urlparse(referer)
        u = urlparse(url)
        return r.netloc == u.netloc
    except Exception:
        return False
