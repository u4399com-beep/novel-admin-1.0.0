#!/usr/bin/env python3
"""
Celery Worker 入口

启动方式:
  celery -A python_crawler_agent.main worker --loglevel=info --concurrency=4

任务注册:
  - crawl_novel_task: 小说爬取任务 (多阶段管线)
  - refresh_font_task: 字体映射刷新任务

配置:
  通过环境变量或 .env 文件配置, 参见 config.py
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys

# 将项目根目录添加到Python路径
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format=(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    ),
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════
# Celery 应用初始化
# ══════════════════════════════════════════════

from celery import Celery
from .config import get_settings

_settings = get_settings()

app = Celery(
    "crawler_agent",
    broker=_settings.CELERY_BROKER_URL,
    backend=_settings.CELERY_RESULT_BACKEND,
    serializer=_settings.CELERY_TASK_SERIALIZER,
    result_serializer=_settings.CELERY_RESULT_SERIALIZER,
    accept_content=_settings.CELERY_ACCEPT_CONTENT,
    timezone=_settings.CELERY_TIMEZONE,
    enable_utc=_settings.CELERY_ENABLE_UTC,
)

# Celery 配置
app.conf.update(
    task_serializer=_settings.CELERY_TASK_SERIALIZER,
    result_serializer=_settings.CELERY_RESULT_SERIALIZER,
    accept_content=_settings.CELERY_ACCEPT_CONTENT,
    timezone=_settings.CELERY_TIMEZONE,
    enable_utc=_settings.CELERY_ENABLE_UTC,
    # 任务结果过期时间
    result_expires=3600,
    # 任务限流 (每秒最多处理2个爬取任务)
    task_annotations={
        'crawl_novel_task': {'rate_limit': '2/s'},
        'refresh_font_task': {'rate_limit': '10/m'},
    },
    # 任务超时
    task_time_limit=1800,   # 硬超时30分钟
    task_soft_time_limit=1500,  # 软超时25分钟
    # Worker配置
    worker_prefetch_multiplier=1,  # 每次只预取一个任务
    # 重试
    task_acks_late=True,    # 任务完成后才确认
    task_reject_on_worker_lost=True,
)

# ══════════════════════════════════════════════
# 任务注册
# ══════════════════════════════════════════════

@app.task(
    name="crawl_novel_task",
    bind=True,
    max_retries=1,
    acks_late=True,
)
def crawl_novel_task(
    self,
    task_id: str,
    site_url: str,
    anti_crawl_level: int = 2,
    site_rules: dict | None = None,
    callback_url: str | None = None,
    novel_id: str | None = None,
) -> dict:
    """
    小说爬取Celery任务

    Args:
        task_id: 任务ID (与Next.js scrape_tasks表对应)
        site_url: 目标站点URL
        anti_crawl_level: 反爬等级 (1-5)
        site_rules: 自定义站点解析规则
        callback_url: 回调URL
        novel_id: 小说ID (与Next.js novels表对应)

    Returns:
        爬取结果统计字典
    """
    logger.info(
        "[Celery] 收到爬取任务: task=%s, url=%s, level=%d",
        task_id, site_url, anti_crawl_level,
    )

    try:
        # 在事件循环中运行异步任务
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        from .tasks.crawl_novel import _run_crawl_novel
        result = loop.run_until_complete(
            _run_crawl_novel(
                task_id=task_id,
                site_url=site_url,
                anti_crawl_level=anti_crawl_level,
                site_rules=site_rules,
                callback_url=callback_url,
                novel_id=novel_id,
            )
        )
        loop.close()
        return result

    except Exception as e:
        logger.error("[Celery] 爬取任务异常: %s - %s", task_id, e, exc_info=True)
        return {
            "status": "failed",
            "error": str(e),
            "task_id": task_id,
        }


@app.task(
    name="refresh_font_task",
    bind=True,
    max_retries=2,
)
def refresh_font_task(
    self,
    font_url: str | None = None,
) -> dict:
    """
    字体映射刷新Celery任务

    Args:
        font_url: 指定字体URL (None=检查所有监控URL)

    Returns:
        刷新结果统计
    """
    logger.info("[Celery] 收到字体刷新任务: font_url=%s", font_url or "all")

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        from .tasks.refresh_font import _run_refresh_font
        result = loop.run_until_complete(_run_refresh_font(font_url))
        loop.close()
        return result

    except Exception as e:
        logger.error("[Celery] 字体刷新任务异常: %s", e, exc_info=True)
        if self.request.retries < self.max_retries:
            raise self.retry(countdown=60, exc=e)
        return {"status": "failed", "error": str(e)}


# ══════════════════════════════════════════════
# 定时任务 (Beat Schedule)
# ══════════════════════════════════════════════

app.conf.beat_schedule = {
    # 每10分钟检查一次字体变化
    "refresh-font-mapping": {
        "task": "refresh_font_task",
        "schedule": 600.0,  # 秒
        "kwargs": {"font_url": None},
    },
    # 每5分钟检查代理池健康
    # (代理健康检查在proxy_manager中独立运行)
}

# ══════════════════════════════════════════════
# 启动入口
# ══════════════════════════════════════════════

if __name__ == "__main__":
    # 直接运行此文件启动worker
    argv = [
        "worker",
        "--loglevel=info",
        "--concurrency=4",
        "--queues=crawler,default",
        "--hostname=crawler@%h",
    ]
    app.worker_main(argv)
