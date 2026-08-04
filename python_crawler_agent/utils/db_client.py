"""
数据库客户端

SQLAlchemy异步引擎 + 连接池
模型定义: 代理池、字体映射、爬取统计
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
)
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from ..config import get_settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """ORM基类"""
    pass


# ══════════════════════════════════════════════
# 模型定义
# ══════════════════════════════════════════════

class ProxyModel(Base):
    """代理记录"""
    __tablename__ = "proxies"

    id = Column(Integer, primary_key=True, autoincrement=True)
    proxy = Column(String(255), unique=True, nullable=False, index=True)
    protocol = Column(String(20), default="http")
    score = Column(Integer, default=10)
    success_count = Column(Integer, default=0)
    fail_count = Column(Integer, default=0)
    use_count = Column(Integer, default=0)
    domain_affinity = Column(String(255), default="")
    is_banned = Column(Boolean, default=False)
    last_used_at = Column(DateTime, nullable=True)
    last_check_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class FontMappingModel(Base):
    """字体映射记录"""
    __tablename__ = "font_mappings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    font_url = Column(String(1024), nullable=False, index=True)
    font_hash = Column(String(64), nullable=False, index=True)
    mapping_json = Column(Text, nullable=False)  # JSON格式映射表
    char_count = Column(Integer, default=0)        # 映射字符数
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)


class CrawlStatsModel(Base):
    """爬取统计记录"""
    __tablename__ = "crawl_stats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(64), nullable=False, index=True)
    novel_id = Column(String(64), nullable=True, index=True)
    site_url = Column(String(1024), nullable=False)
    anti_crawl_level = Column(Integer, default=1)
    status = Column(String(20), default="pending")  # pending/running/success/failed
    total_chapters = Column(Integer, default=0)
    crawled_chapters = Column(Integer, default=0)
    failed_chapters = Column(Integer, default=0)
    avg_response_ms = Column(Float, default=0.0)
    total_errors = Column(Integer, default=0)
    captcha_encountered = Column(Integer, default=0)
    captcha_solved = Column(Integer, default=0)
    font_changes_detected = Column(Integer, default=0)
    proxy_rotations = Column(Integer, default=0)
    error_message = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class CrawlLogModel(Base):
    """爬取日志 (每个章节一条)"""
    __tablename__ = "crawl_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(64), nullable=False, index=True)
    chapter_url = Column(String(1024), nullable=False)
    chapter_title = Column(String(512), nullable=True)
    status = Column(String(20), default="pending")
    response_ms = Column(Float, default=0.0)
    error_message = Column(Text, nullable=True)
    retry_count = Column(Integer, default=0)
    used_proxy = Column(String(255), nullable=True)
    used_engine = Column(String(20), nullable=True)  # curl_cffi / playwright
    created_at = Column(DateTime, default=datetime.utcnow)


class DatabaseClient:
    """
    数据库客户端

    提供同步和异步两种会话:
    - async_session: 用于Celery任务中的异步操作
    - sync_session: 用于同步上下文
    """

    def __init__(self, database_url: Optional[str] = None):
        self._settings = get_settings()
        db_url = database_url or self._settings.DATABASE_URL

        # 异步引擎
        self._async_engine = create_async_engine(
            db_url,
            echo=self._settings.DEBUG,
            pool_size=self._settings.DB_POOL_SIZE,
            max_overflow=self._settings.DB_MAX_OVERFLOW,
            pool_timeout=self._settings.DB_POOL_TIMEOUT,
            pool_pre_ping=True,
        )
        self._async_session_factory = async_sessionmaker(
            self._async_engine,
            class_=AsyncSession,
            expire_on_commit=False,
        )

        # 同步引擎 (用于非async上下文)
        sync_url = db_url.replace("+aiosqlite", "")
        if "+aiosqlite" not in db_url:
            sync_url = db_url
        self._sync_engine = create_engine(
            sync_url,
            echo=self._settings.DEBUG,
            pool_size=self._settings.DB_POOL_SIZE,
            max_overflow=self._settings.DB_MAX_OVERFLOW,
        )
        self._sync_session_factory = sessionmaker(
            self._sync_engine,
            class_=Session,
            expire_on_commit=False,
        )

        logger.info("数据库客户端初始化完成: %s", db_url.split("///")[-1])

    async def init_tables(self) -> None:
        """创建所有表 (如果不存在)"""
        async with self._async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("数据库表初始化完成")

    def init_tables_sync(self) -> None:
        """同步创建所有表"""
        Base.metadata.create_all(self._sync_engine)
        logger.info("数据库表初始化完成 (同步)")

    @property
    def async_session(self) -> async_sessionmaker:
        """获取异步会话工厂"""
        return self._async_session_factory

    @property
    def sync_session(self) -> sessionmaker:
        """获取同步会话工厂"""
        return self._sync_session_factory

    async def close(self) -> None:
        """关闭数据库连接"""
        await self._async_engine.dispose()
        self._sync_engine.dispose()
        logger.info("数据库连接已关闭")

    def close_sync(self) -> None:
        """同步关闭"""
        self._sync_engine.dispose()

    # ══════════════════════════════════════════════
# 便捷方法
    # ══════════════════════════════════════════════

    async def create_crawl_stats(self, task_id: str, site_url: str, level: int = 1) -> CrawlStatsModel:
        """创建爬取统计记录"""
        async with self._async_session_factory() as session:
            stats = CrawlStatsModel(
                task_id=task_id,
                site_url=site_url,
                anti_crawl_level=level,
                status="running",
                started_at=datetime.utcnow(),
            )
            session.add(stats)
            await session.commit()
            await session.refresh(stats)
            return stats

    async def update_crawl_stats(self, task_id: str, **kwargs: Any) -> None:
        """更新爬取统计"""
        async with self._async_session_factory() as session:
            from sqlalchemy import update as sa_update
            stmt = (
                sa_update(CrawlStatsModel)
                .where(CrawlStatsModel.task_id == task_id)
                .values(**kwargs)
            )
            await session.execute(stmt)
            await session.commit()

    async def get_crawl_stats(self, task_id: str) -> Optional[Dict[str, Any]]:
        """获取爬取统计"""
        async with self._async_session_factory() as session:
            from sqlalchemy import select
            stmt = select(CrawlStatsModel).where(CrawlStatsModel.task_id == task_id)
            result = await session.execute(stmt)
            stats = result.scalar_one_or_none()
            if stats:
                return {
                    "task_id": stats.task_id,
                    "status": stats.status,
                    "total_chapters": stats.total_chapters,
                    "crawled_chapters": stats.crawled_chapters,
                    "failed_chapters": stats.failed_chapters,
                    "avg_response_ms": stats.avg_response_ms,
                    "captcha_encountered": stats.captcha_encountered,
                    "proxy_rotations": stats.proxy_rotations,
                }
            return None

    async def save_font_mapping(
        self, font_url: str, font_hash: str, mapping_json: str, char_count: int
    ) -> None:
        """保存字体映射"""
        async with self._async_session_factory() as session:
            # 查找是否已存在
            from sqlalchemy import select
            stmt = select(FontMappingModel).where(FontMappingModel.font_hash == font_hash)
            result = await session.execute(stmt)
            existing = result.scalar_one_or_none()

            if existing:
                existing.mapping_json = mapping_json
                existing.char_count = char_count
                existing.font_url = font_url
            else:
                record = FontMappingModel(
                    font_url=font_url,
                    font_hash=font_hash,
                    mapping_json=mapping_json,
                    char_count=char_count,
                )
                session.add(record)

            await session.commit()

    async def log_crawl_chapter(
        self,
        task_id: str,
        chapter_url: str,
        status: str,
        chapter_title: str = "",
        response_ms: float = 0.0,
        error_message: str = "",
        retry_count: int = 0,
        used_proxy: str = "",
        used_engine: str = "",
    ) -> None:
        """记录章节爬取日志"""
        async with self._async_session_factory() as session:
            log = CrawlLogModel(
                task_id=task_id,
                chapter_url=chapter_url,
                chapter_title=chapter_title,
                status=status,
                response_ms=response_ms,
                error_message=error_message,
                retry_count=retry_count,
                used_proxy=used_proxy,
                used_engine=used_engine,
            )
            session.add(log)
            await session.commit()
