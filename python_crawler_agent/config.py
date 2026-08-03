"""
配置模块 - 环境变量加载与反爬等级定义

支持5个反爬等级, 从简单静态请求到全套反反爬对抗:
  Level 1: 静态curl_cffi请求 + TLS指纹
  Level 2: + 随机UA + 完整浏览器头
  Level 3: + Playwright隐身 + 代理轮换
  Level 4: + 字体反爬解码 + 行为模拟
  Level 5: + 验证码自动识别 + 全套行为模拟
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Dict, List, Optional


class AntiCrawlLevel(IntEnum):
    """反爬等级枚举"""
    LEVEL_1_STATIC = 1   # 静态请求 + TLS指纹
    LEVEL_2_HEADERS = 2  # + 随机UA + 完整头
    LEVEL_3_STEALTH = 3  # + Playwright隐身 + 代理
    LEVEL_4_FONT = 4     # + 字体解码 + 行为模拟
    LEVEL_5_FULL = 5     # + 验证码 + 全套模拟


@dataclass
class ProxySource:
    """代理源配置"""
    name: str
    url: str
    api_key: Optional[str] = None
    weight: int = 1  # 权重, 用于随机选择
    enabled: bool = True


@dataclass
class AntiCrawlLevelConfig:
    """单个反爬等级的配置"""
    level: int
    name: str
    use_tls_fingerprint: bool = False
    use_playwright: bool = False
    use_proxy: bool = False
    use_font_decode: bool = False
    use_captcha_solve: bool = False
    use_behavior_sim: bool = False
    use_stealth: bool = False
    retry_times: int = 1
    delay_min_ms: int = 500
    delay_max_ms: int = 2000
    poisson_lambda: float = 1.0  # 泊松分布参数(秒)


# 五级反爬配置详细定义
ANTI_CRAWL_LEVELS: Dict[int, AntiCrawlLevelConfig] = {
    1: AntiCrawlLevelConfig(
        level=1,
        name="静态采集",
        use_tls_fingerprint=True,
        retry_times=2,
        delay_min_ms=300,
        delay_max_ms=1000,
        poisson_lambda=0.7,
    ),
    2: AntiCrawlLevelConfig(
        level=2,
        name="伪装请求",
        use_tls_fingerprint=True,
        use_playwright=False,
        retry_times=3,
        delay_min_ms=500,
        delay_max_ms=2000,
        poisson_lambda=1.0,
    ),
    3: AntiCrawlLevelConfig(
        level=3,
        name="隐身浏览器",
        use_tls_fingerprint=True,
        use_playwright=True,
        use_proxy=True,
        use_stealth=True,
        retry_times=3,
        delay_min_ms=1000,
        delay_max_ms=3000,
        poisson_lambda=1.5,
    ),
    4: AntiCrawlLevelConfig(
        level=4,
        name="字体对抗",
        use_tls_fingerprint=True,
        use_playwright=True,
        use_proxy=True,
        use_stealth=True,
        use_font_decode=True,
        use_behavior_sim=True,
        retry_times=4,
        delay_min_ms=1500,
        delay_max_ms=4000,
        poisson_lambda=2.0,
    ),
    5: AntiCrawlLevelConfig(
        level=5,
        name="全副武装",
        use_tls_fingerprint=True,
        use_playwright=True,
        use_proxy=True,
        use_stealth=True,
        use_font_decode=True,
        use_captcha_solve=True,
        use_behavior_sim=True,
        retry_times=5,
        delay_min_ms=2000,
        delay_max_ms=6000,
        poisson_lambda=3.0,
    ),
}


@dataclass
class Config:
    """全局配置, 从环境变量加载"""

    # ── 基础配置 ──
    ENV: str = field(default_factory=lambda: os.getenv("ENV", "development"))
    DEBUG: bool = field(default_factory=lambda: os.getenv("DEBUG", "true").lower() == "true")
    LOG_LEVEL: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))

    # ── Celery 配置 ──
    CELERY_BROKER_URL: str = field(
        default_factory=lambda: os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
    )
    CELERY_RESULT_BACKEND: str = field(
        default_factory=lambda: os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/1")
    )
    CELERY_TASK_SERIALIZER: str = "json"
    CELERY_RESULT_SERIALIZER: str = "json"
    CELERY_ACCEPT_CONTENT: List[str] = field(default_factory=lambda: ["json"])
    CELERY_TIMEZONE: str = "Asia/Shanghai"
    CELERY_ENABLE_UTC: bool = True

    # ── Redis 配置 ──
    REDIS_URL: str = field(
        default_factory=lambda: os.getenv("REDIS_URL", "redis://localhost:6379/0")
    )
    REDIS_PROXY_DB: int = 2       # 代理池使用的Redis DB
    REDIS_FONT_DB: int = 3        # 字体映射缓存DB
    REDIS_STATS_DB: int = 4       # 爬取统计DB

    # ── Next.js 回调配置 ──
    NEXTJS_CALLBACK_URL: str = field(
        default_factory=lambda: os.getenv(
            "NEXTJS_CALLBACK_URL", "http://localhost:3000/api/scrape-tasks/callback"
        )
    )

    # ── 代理配置 ──
    PROXY_INITIAL_SCORE: int = 10
    PROXY_SUCCESS_BONUS: int = 1
    PROXY_FAIL_PENALTY: int = 2
    PROXY_CHECK_INTERVAL: int = 300  # 代理健康检查间隔(秒)
    PROXY_MIN_POOL_SIZE: int = 5
    PROXY_FETCH_TIMEOUT: int = 10
    PROXY_ROTATION_STRATEGY: str = "random"  # random / round_robin / least_used
    PROXY_SOURCES: List[ProxySource] = field(default_factory=list)

    # ── 字体解码配置 ──
    FONT_CACHE_TTL: int = 3600       # 字体映射缓存TTL(秒)
    FONT_CHECK_INTERVAL: int = 600   # 字体变化检测间隔(秒)
    FONT_MAX_RETRY: int = 3

    # ── 验证码配置 ──
    CAPTCHA_MAX_CONCURRENT: int = 3
    CAPTCHA_RATE_LIMIT_THRESHOLD: int = 5     # 触发限流的验证码频率(次/分钟)
    CAPTCHA_COOLDOWN_MULTIPLIER: float = 2.0   # 限流后延迟倍数

    # ── 浏览器配置 ──
    PLAYWRIGHT_HEADLESS: bool = True
    PLAYWRIGHT_TIMEOUT: int = 30000       # 页面加载超时(毫秒)
    PLAYWRIGHT_VIEWPORT: Dict[str, int] = field(
        default_factory=lambda: {"width": 1920, "height": 1080}
    )
    PLAYWRIGHT_LOCALE: str = "zh-CN"
    PLAYWRIGHT_TIMEZONE_ID: str = "Asia/Shanghai"

    # ── TLS指纹配置 ──
    TLS_IMPERSONATE: List[str] = field(
        default_factory=lambda: ["chrome120", "chrome116", "safari17_0", "edge101"]
    )

    # ── 数据库配置 ──
    DATABASE_URL: str = field(
        default_factory=lambda: os.getenv(
            "DATABASE_URL", "sqlite+aiosqlite:///./crawler_data.db"
        )
    )
    DB_POOL_SIZE: int = 5
    DB_MAX_OVERFLOW: int = 10
    DB_POOL_TIMEOUT: int = 30

    # ── 爬取配置 ──
    CRAWL_DEFAULT_LEVEL: int = 2
    CRAWL_MAX_CONCURRENT_CHAPTERS: int = 3
    CRAWL_CHAPTER_TIMEOUT: int = 60
    CRAWL_LIST_TIMEOUT: int = 30
    CRAWL_CALLBACK_TIMEOUT: int = 10
    CRAWL_CALLBACK_RETRIES: int = 3

    # ── 行为模拟配置 ──
    BEHAVIOR_READING_WPM_MIN: int = 200    # 阅读速度(字/分) 下限
    BEHAVIOR_READING_WPM_MAX: int = 400    # 阅读速度上限
    BEHAVIOR_SCROLL_STEP_MIN: int = 100    # 滚动步长(像素)下限
    BEHAVIOR_SCROLL_STEP_MAX: int = 500    # 滚动步长上限
    BEHAVIOR_MOUSE_SPEED_MIN: float = 0.3   # 鼠标速度(像素/毫秒)下限
    BEHAVIOR_MOUSE_SPEED_MAX: float = 2.0   # 鼠标速度上限

    def get_level_config(self, level: int) -> AntiCrawlLevelConfig:
        """获取指定等级的反爬配置"""
        if level not in ANTI_CRAWL_LEVELS:
            raise ValueError(f"无效的反爬等级: {level}, 有效范围: 1-5")
        return ANTI_CRAWL_LEVELS[level]


# 全局配置单例
_settings: Optional[Config] = None


def get_settings() -> Config:
    """获取全局配置单例"""
    global _settings
    if _settings is None:
        _settings = Config()
    return _settings


def reload_settings() -> Config:
    """强制重新加载配置"""
    global _settings
    _settings = Config()
    return _settings
