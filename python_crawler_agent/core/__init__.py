"""
核心模块 - 反反爬虫引擎

包含6大反反爬子模块:
  1. fetcher        - 统一请求引擎 (TLS指纹 + Playwright隐身)
  2. proxy_manager  - 动态IP代理池 (Redis评分调度)
  3. anti_captcha   - 验证码自动识别 (滑块/点击/算术)
  4. font_decoder   - 字体反爬对抗 (WOFF/TTF解析 + OCR)
"""

from .fetcher import Fetcher, FetchResponse
from .proxy_manager import ProxyManager
from .anti_captcha import CaptchaSolver
from .font_decoder import FontDecoder

__all__ = [
    "Fetcher",
    "FetchResponse",
    "ProxyManager",
    "CaptchaSolver",
    "FontDecoder",
]
