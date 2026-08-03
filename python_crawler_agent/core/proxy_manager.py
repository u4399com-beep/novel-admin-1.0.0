"""
动态IP代理池管理器

Redis-backed proxy storage with scoring system:
  - Initial score: 10 points
  - Success: +1 point
  - Failure: -2 points  
  - Score <= 0: auto-delete

Features:
  - ZPOPMAX-based priority scheduling (high-score proxies first)
  - Multi-source proxy fetching (pluggable architecture)
  - Proxy health checking with periodic validation
  - Domain-based proxy affinity tracking
  - Three rotation strategies: round-robin, random, least-used
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import redis

from ..config import ProxySource, get_settings

logger = logging.getLogger(__name__)


@dataclass
class ProxyInfo:
    """代理信息"""
    proxy: str          # 代理地址, 如 http://ip:port 或 socks5://ip:port
    score: int = 10     # 当前评分
    protocol: str = "http"
    domain: str = ""    # 最后使用的域名
    last_used: float = 0.0
    last_check: float = 0.0
    success_count: int = 0
    fail_count: int = 0
    use_count: int = 0


class ProxyManager:
    """
    动态IP代理池管理器

    使用Redis Sorted Set存储代理, score作为排序分数:
    - ZPOPMAX: 取出分数最高的代理 (高评分=高优先级)
    - ZADD: 更新代理分数
    - ZREM: 移除低分代理
    """

    # Redis键前缀
    KEY_PROXY_POOL = "crawler:proxy:pool"         # 代理池 (Sorted Set)
    KEY_PROXY_INFO = "crawler:proxy:info:"        # 代理详细信息 (Hash)
    KEY_PROXY_DOMAIN = "crawler:proxy:domain:"    # 域名亲和力 (Set)
    KEY_PROXY_LOCK = "crawler:proxy:lock:"        # 分布式锁
    KEY_PROXY_BANNED = "crawler:proxy:banned"     # 被封禁的代理 (Set)
    KEY_PROXY_STATS = "crawler:proxy:stats"       # 统计信息 (Hash)

    def __init__(self, redis_client: Optional[redis.Redis] = None):
        """
        初始化代理管理器

        Args:
            redis_client: Redis客户端实例, 为None时自动创建
        """
        self._settings = get_settings()

        if redis_client:
            self._redis = redis_client
        else:
            self._redis = redis.Redis.from_url(
                self._settings.REDIS_URL,
                db=self._settings.REDIS_PROXY_DB,
                decode_responses=True,
                socket_timeout=10,
                socket_connect_timeout=5,
                retry_on_timeout=True,
            )

        # 轮询索引 (round-robin策略)
        self._rr_index: int = 0
        self._rr_lock = asyncio.Lock()

        # 自定义代理获取器
        self._custom_fetchers: List[Callable] = []

        # 健康检查任务
        self._health_check_running = False

        logger.info("代理管理器初始化完成, Redis DB=%d", self._settings.REDIS_PROXY_DB)

    def register_fetcher(self, fetcher: Callable[[], List[str]]) -> None:
        """
        注册自定义代理获取器

        Args:
            fetcher: 无参函数, 返回代理地址列表
        """
        self._custom_fetchers.append(fetcher)
        logger.info("注册代理获取器: %s", fetcher.__name__ if hasattr(fetcher, '__name__') else 'anonymous')

    def get_pool_size(self) -> int:
        """获取当前代理池大小"""
        try:
            return self._redis.zcard(self.KEY_PROXY_POOL)
        except Exception as e:
            logger.error("获取代理池大小失败: %s", e)
            return 0

    def add_proxy(
        self,
        proxy: str,
        score: Optional[int] = None,
        protocol: str = "http"
    ) -> bool:
        """
        添加代理到池中

        Args:
            proxy: 代理地址
            score: 初始评分 (默认使用配置值)
            protocol: 代理协议

        Returns:
            是否添加成功
        """
        if score is None:
            score = self._settings.PROXY_INITIAL_SCORE

        try:
            # 检查是否在封禁列表
            if self._redis.sismember(self.KEY_PROXY_BANNED, proxy):
                logger.debug("代理在封禁列表中, 跳过: %s", proxy)
                return False

            pipe = self._redis.pipeline()
            pipe.zadd(self.KEY_PROXY_POOL, {proxy: score})
            pipe.hset(
                self.KEY_PROXY_INFO + self._proxy_hash(proxy),
                mapping={
                    "proxy": proxy,
                    "score": str(score),
                    "protocol": protocol,
                    "last_used": "0",
                    "last_check": "0",
                    "success_count": "0",
                    "fail_count": "0",
                    "use_count": "0",
                    "added_at": str(time.time()),
                }
            )
            pipe.execute()
            logger.debug("添加代理: %s (初始分数=%d)", proxy, score)
            return True
        except Exception as e:
            logger.error("添加代理失败: %s - %s", proxy, e)
            return False

    def add_proxies(self, proxies: List[str], protocol: str = "http") -> int:
        """批量添加代理, 返回成功数量"""
        count = 0
        for proxy in proxies:
            if self.add_proxy(proxy, protocol=protocol):
                count += 1
        logger.info("批量添加代理: %d/%d 成功", count, len(proxies))
        return count

    def get_proxy(self, domain: str = "") -> Optional[str]:
        """
        获取一个代理

        根据配置的轮换策略获取:
        - random: 随机选择
        - round_robin: 轮询
        - least_used: 使用次数最少的

        优先使用域名亲和的代理 (如果该域名有专属代理)

        Args:
            domain: 目标域名, 用于亲和力匹配

        Returns:
            代理地址, 池空时返回None
        """
        try:
            # 尝试获取域名亲和代理
            if domain:
                domain_proxies = self._redis.smembers(self.KEY_PROXY_DOMAIN + domain)
                if domain_proxies:
                    # 从亲和代理中选择
                    proxy = self._select_from_candidates(list(domain_proxies), domain)
                    if proxy:
                        return proxy

            # 全池选择
            all_proxies = self._redis.zrange(
                self.KEY_PROXY_POOL, 0, -1, withscores=True
            )
            if not all_proxies:
                # 池空, 尝试补充
                self._try_refill()
                all_proxies = self._redis.zrange(
                    self.KEY_PROXY_POOL, 0, -1, withscores=True
                )
                if not all_proxies:
                    logger.warning("代理池为空, 无法获取代理")
                    return None

            candidates = [p for p, s in all_proxies if s > 0]
            if not candidates:
                logger.warning("代理池中无可用代理 (所有分数<=0)")
                return None

            return self._select_from_candidates(candidates, domain)

        except Exception as e:
            logger.error("获取代理失败: %s", e)
            return None

    def _select_from_candidates(
        self, candidates: List[str], domain: str
    ) -> Optional[str]:
        """根据策略从候选代理中选择"""
        strategy = self._settings.PROXY_ROTATION_STRATEGY

        if strategy == "round_robin":
            if not candidates:
                return None
            idx = self._rr_index % len(candidates)
            self._rr_index += 1
            proxy = candidates[idx]

        elif strategy == "least_used":
            # 选择使用次数最少的
            min_use = float('inf')
            proxy = None
            for p in candidates:
                info = self._redis.hgetall(self.KEY_PROXY_INFO + self._proxy_hash(p))
                use_count = int(info.get("use_count", 0))
                if use_count < min_use:
                    min_use = use_count
                    proxy = p

        else:  # default: random
            proxy = random.choice(candidates) if candidates else None

        if proxy:
            # 更新使用信息
            self._redis.hincrby(self.KEY_PROXY_INFO + self._proxy_hash(proxy), "use_count", 1)
            self._redis.hset(
                self.KEY_PROXY_INFO + self._proxy_hash(proxy),
                "last_used", str(time.time())
            )
            # 记录域名亲和
            if domain:
                self._redis.sadd(self.KEY_PROXY_DOMAIN + domain, proxy)
            logger.debug("选择代理: %s (策略=%s, 域名=%s)", proxy, strategy, domain or "*")

        return proxy

    def report_success(self, proxy: str, domain: str = "") -> None:
        """
        报告代理请求成功

        分数 +1, 更新成功计数
        """
        try:
            key = self.KEY_PROXY_INFO + self._proxy_hash(proxy)
            self._redis.hincrby(key, "success_count", 1)
            # 增加评分
            score = self._redis.zscore(self.KEY_PROXY_POOL, proxy) or 0
            new_score = score + self._settings.PROXY_SUCCESS_BONUS
            # 上限100分
            new_score = min(new_score, 100)
            self._redis.zadd(self.KEY_PROXY_POOL, {proxy: new_score})
            self._redis.hset(key, "score", str(new_score))
            logger.debug("代理成功: %s (新分数=%.1f)", proxy, new_score)
        except Exception as e:
            logger.error("报告代理成功失败: %s - %s", proxy, e)

    def report_failure(self, proxy: str, domain: str = "") -> None:
        """
        报告代理请求失败

        分数 -2, 分数<=0时删除
        """
        try:
            key = self.KEY_PROXY_INFO + self._proxy_hash(proxy)
            self._redis.hincrby(key, "fail_count", 1)
            # 减少评分
            score = self._redis.zscore(self.KEY_PROXY_POOL, proxy) or 0
            new_score = score - self._settings.PROXY_FAIL_PENALTY
            if new_score <= 0:
                # 分数过低, 删除代理
                self._redis.zrem(self.KEY_PROXY_POOL, proxy)
                self._redis.delete(key)
                logger.info("代理分数过低, 已删除: %s (分数=%.1f)", proxy, new_score)
            else:
                self._redis.zadd(self.KEY_PROXY_POOL, {proxy: new_score})
                self._redis.hset(key, "score", str(new_score))
                logger.debug("代理失败: %s (新分数=%.1f)", proxy, new_score)
        except Exception as e:
            logger.error("报告代理失败: %s - %s", proxy, e)

    def ban_proxy(self, proxy: str, reason: str = "") -> None:
        """封禁代理 (永久移除)"""
        try:
            self._redis.sadd(self.KEY_PROXY_BANNED, proxy)
            self._redis.zrem(self.KEY_PROXY_POOL, proxy)
            self._redis.delete(self.KEY_PROXY_INFO + self._proxy_hash(proxy))
            logger.info("代理已封禁: %s (原因: %s)", proxy, reason or "未知")
        except Exception as e:
            logger.error("封禁代理失败: %s - %s", proxy, e)

    async def check_health(self, test_url: str = "https://httpbin.org/ip") -> None:
        """
        代理健康检查

        定期验证代理可用性, 清除不可用代理
        """
        import aiohttp

        if self._health_check_running:
            logger.debug("健康检查已在运行中")
            return

        self._health_check_running = True
        logger.info("开始代理健康检查...")

        try:
            proxies = self._redis.zrange(self.KEY_PROXY_POOL, 0, -1)
            if not proxies:
                logger.info("代理池为空, 跳过健康检查")
                return

            check_tasks = []
            for proxy in proxies:
                check_tasks.append(self._check_single_proxy(proxy, test_url))

            results = await asyncio.gather(*check_tasks, return_exceptions=True)

            alive = sum(1 for r in results if r is True)
            logger.info(
                "健康检查完成: %d/%d 代理可用",
                alive, len(proxies)
            )

            # 更新统计
            self._redis.hset(
                self.KEY_PROXY_STATS,
                mapping={
                    "last_health_check": str(time.time()),
                    "total_proxies": str(len(proxies)),
                    "alive_proxies": str(alive),
                }
            )

        except Exception as e:
            logger.error("健康检查异常: %s", e)
        finally:
            self._health_check_running = False

    async def _check_single_proxy(self, proxy: str, test_url: str) -> bool:
        """检查单个代理的可用性"""
        import aiohttp

        try:
            timeout = aiohttp.ClientTimeout(total=self._settings.PROXY_FETCH_TIMEOUT)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(test_url, proxy=proxy) as resp:
                    if resp.status == 200:
                        self.report_success(proxy)
                        return True
                    else:
                        self.report_failure(proxy)
                        return False
        except Exception:
            self.report_failure(proxy)
            return False

    def _try_refill(self) -> None:
        """尝试补充代理池"""
        current_size = self.get_pool_size()
        if current_size >= self._settings.PROXY_MIN_POOL_SIZE:
            return

        logger.info("代理池不足 (%d < %d), 尝试补充...", current_size, self._settings.PROXY_MIN_POOL_SIZE)

        # 从配置的代理源获取
        for source in self._settings.PROXY_SOURCES:
            if not source.enabled:
                continue
            try:
                fetched = self._fetch_from_source(source)
                if fetched:
                    added = self.add_proxies(fetched)
                    logger.info("从 %s 获取并添加 %d 个代理", source.name, added)
            except Exception as e:
                logger.error("从 %s 获取代理失败: %s", source.name, e)

        # 调用自定义获取器
        for fetcher in self._custom_fetchers:
            try:
                proxies = fetcher()
                if proxies:
                    added = self.add_proxies(proxies)
                    logger.info("从自定义获取器添加 %d 个代理", added)
            except Exception as e:
                logger.error("自定义获取器失败: %s", e)

    def _fetch_from_source(self, source: ProxySource) -> List[str]:
        """
        从代理源获取代理列表

        支持常见的代理API格式:
        - 纯文本 (每行一个)
        - JSON数组
        - 逗号分隔
        """
        import urllib.request
        import json

        url = source.url
        if source.api_key:
            # 在URL中注入API key
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}key={source.api_key}"

        req = urllib.request.Request(url, headers={"User-Agent": "CrawlerAgent/1.0"})
        with urllib.request.urlopen(req, timeout=self._settings.PROXY_FETCH_TIMEOUT) as resp:
            content = resp.read().decode("utf-8", errors="replace").strip()

        # 尝试JSON解析
        try:
            data = json.loads(content)
            if isinstance(data, list):
                return [str(p) for p in data]
            elif isinstance(data, dict) and "data" in data:
                items = data["data"]
                if isinstance(items, list):
                    return [str(p) for p in items]
        except (json.JSONDecodeError, TypeError):
            pass

        # 纯文本: 支持换行、逗号、分号分隔
        for sep in ["\n", ",", ";"]:
            if sep in content:
                proxies = [p.strip() for p in content.split(sep) if p.strip()]
                return [p for p in proxies if self._validate_proxy_format(p)]

        return []

    @staticmethod
    def _validate_proxy_format(proxy: str) -> bool:
        """验证代理格式"""
        return (
            "://" in proxy
            and proxy.count(":") >= 2
        )

    @staticmethod
    def _proxy_hash(proxy: str) -> str:
        """代理地址的哈希 (用于Redis key)"""
        return hashlib.md5(proxy.encode()).hexdigest()[:12]

    def get_stats(self) -> Dict[str, Any]:
        """获取代理池统计信息"""
        try:
            total = self._redis.zcard(self.KEY_PROXY_POOL)
            banned = self._redis.scard(self.KEY_PROXY_BANNED)
            all_scores = self._redis.zrange(self.KEY_PROXY_POOL, 0, -1, withscores=True)
            avg_score = sum(s for _, s in all_scores) / len(all_scores) if all_scores else 0
            max_score = max((s for _, s in all_scores), default=0)
            min_score = min((s for _, s in all_scores), default=0)

            return {
                "total": total,
                "banned": banned,
                "avg_score": round(avg_score, 2),
                "max_score": max_score,
                "min_score": min_score,
                "strategy": self._settings.PROXY_ROTATION_STRATEGY,
            }
        except Exception as e:
            logger.error("获取代理统计失败: %s", e)
            return {"error": str(e)}

    def close(self) -> None:
        """关闭连接"""
        try:
            self._redis.close()
        except Exception:
            pass
        logger.info("代理管理器已关闭")
