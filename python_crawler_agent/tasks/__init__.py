"""
Celery任务定义

- crawl_novel: 小说爬取主任务 (多阶段管线)
- refresh_font: 字体映射刷新任务
"""

__all__ = [
    "crawl_novel_task",
    "refresh_font_task",
]
