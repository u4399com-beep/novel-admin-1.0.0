"""
字体映射刷新任务

定期检测已监控URL的字体文件是否发生变化,
变化时自动重新下载、解析、更新映射表.

特性:
  - 哈希比对检测变化
  - 原子替换映射表 (先构建新表, 再替换旧表)
  - 失败自动回滚
  - 统计变更次数
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional

from ..config import get_settings
from ..core.font_decoder import FontDecoder
from ..core.fetcher import Fetcher

logger = logging.getLogger(__name__)


class FontRefreshManager:
    """
    字体映射刷新管理器

    维护一个监控URL列表, 定期检查字体变化.
    """

    # Redis中存储监控URL列表的key
    REDIS_MONITORED_KEY = "crawler:font:monitored"

    def __init__(
        self,
        font_decoder: Optional[FontDecoder] = None,
        fetcher: Optional[Fetcher] = None,
    ):
        self._settings = get_settings()
        self._font_decoder = font_decoder
        self._fetcher = fetcher
        self._check_interval = self._settings.FONT_CHECK_INTERVAL

    def add_monitored_url(self, font_url: str, page_url: str = "") -> None:
        """
        添加监控URL

        Args:
            font_url: 字体文件URL
            page_url: 关联的页面URL (用于重新发现字体URL)
        """
        import redis
        r = redis.Redis.from_url(
            self._settings.REDIS_URL,
            db=self._settings.REDIS_FONT_DB,
            decode_responses=True,
        )

        # 存储监控信息
        data = json.dumps({
            "font_url": font_url,
            "page_url": page_url,
            "added_at": time.time(),
            "last_check": 0,
            "change_count": 0,
        })

        r.hset(self.REDIS_MONITORED_KEY, font_url, data)
        logger.info("添加字体监控: %s", font_url)

    def get_monitored_urls(self) -> List[Dict[str, Any]]:
        """获取所有监控URL及其信息"""
        import redis
        r = redis.Redis.from_url(
            self._settings.REDIS_URL,
            db=self._settings.REDIS_FONT_DB,
            decode_responses=True,
        )

        entries = r.hgetall(self.REDIS_MONITORED_KEY)
        result = []
        for url, data_str in entries.items():
            try:
                data = json.loads(data_str)
                data["url"] = url
                result.append(data)
            except json.JSONDecodeError:
                logger.warning("解析监控数据失败: %s", url)
        return result

    def remove_monitored_url(self, font_url: str) -> bool:
        """移除监控URL"""
        import redis
        r = redis.Redis.from_url(
            self._settings.REDIS_URL,
            db=self._settings.REDIS_FONT_DB,
            decode_responses=True,
        )
        return r.hdel(self.REDIS_MONITORED_KEY, font_url) > 0

    async def check_all(self) -> Dict[str, Any]:
        """
        检查所有监控的字体URL

        Returns:
            检查结果统计
        """
        urls = self.get_monitored_urls()
        if not urls:
            return {"checked": 0, "changed": 0, "failed": 0}

        # 确保依赖初始化
        if not self._fetcher:
            self._fetcher = Fetcher(level=1)
        if not self._font_decoder:
            self._font_decoder = FontDecoder(fetcher=self._fetcher)

        stats = {"checked": 0, "changed": 0, "failed": 0, "details": []}

        for entry in urls:
            font_url = entry["url"]
            try:
                changed = await self._font_decoder.check_font_change(font_url)
                stats["checked"] += 1

                if changed:
                    stats["changed"] += 1
                    # 更新变更计数
                    self._update_check_info(font_url, changed=True)
                    stats["details"].append({
                        "url": font_url,
                        "status": "changed",
                    })
                    logger.info("字体已变化, 映射已更新: %s", font_url)
                else:
                    self._update_check_info(font_url, changed=False)

            except Exception as e:
                stats["failed"] += 1
                stats["details"].append({
                    "url": font_url,
                    "status": "error",
                    "error": str(e),
                })
                logger.error("字体检查失败: %s - %s", font_url, e)

        logger.info(
            "字体监控检查完成: 检查=%d, 变化=%d, 失败=%d",
            stats["checked"], stats["changed"], stats["failed"],
        )
        return stats

    def _update_check_info(self, font_url: str, changed: bool) -> None:
        """更新检查时间和变更计数"""
        import redis
        r = redis.Redis.from_url(
            self._settings.REDIS_URL,
            db=self._settings.REDIS_FONT_DB,
            decode_responses=True,
        )

        data_str = r.hget(self.REDIS_MONITORED_KEY, font_url)
        if not data_str:
            return

        data = json.loads(data_str)
        data["last_check"] = time.time()
        if changed:
            data["change_count"] = data.get("change_count", 0) + 1

        r.hset(self.REDIS_MONITORED_KEY, font_url, json.dumps(data))


# ══════════════════════════════════════════════════════════
# Celery任务入口
# ══════════════════════════════════════════════════════════

async def _run_refresh_font(font_url: Optional[str] = None) -> Dict[str, Any]:
    """
    刷新字体映射任务

    如果指定font_url, 只检查该URL;
    否则检查所有监控URL.
    """
    manager = FontRefreshManager()

    if font_url:
        # 单个URL检查
        fetcher = Fetcher(level=1)
        decoder = FontDecoder(fetcher=fetcher)
        try:
            changed = await decoder.check_font_change(font_url)
            return {
                "url": font_url,
                "changed": changed,
            }
        finally:
            await fetcher.close()
            decoder.close()
    else:
        # 全量检查
        return await manager.check_all()
