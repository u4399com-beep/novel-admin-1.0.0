"""
人类行为模拟器

模拟真实用户的浏览行为模式:
  1. 泊松分布随机延迟 - 模拟阅读/操作间隔
  2. 鼠标移动轨迹生成 - 贝塞尔曲线
  3. 滚动模拟 - 非匀速滚动
  4. 阅读速度模拟 - 基于中文字符的WPM变化
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np

from ..config import get_settings

logger = logging.getLogger(__name__)


@dataclass
class MousePoint:
    """鼠标轨迹点"""
    x: float
    y: float
    timestamp: float  # 毫秒


class HumanBehavior:
    """
    人类行为模拟器

    所有延迟和轨迹都基于概率分布生成,
    而非固定值, 以避免被统计特征检测
    """

    def __init__(self):
        self._settings = get_settings()

    # ══════════════════════════════════════════════
    # 延迟模拟
    # ══════════════════════════════════════════════

    def poisson_delay(self, lam: Optional[float] = None) -> float:
        """
        泊松分布随机延迟

        真实用户的操作间隔近似泊松分布.
        lambda越大, 平均延迟越大.

        Args:
            lam: 泊松分布参数 (秒), 为None时使用配置值

        Returns:
            延迟秒数
        """
        if lam is None:
            lam = self._settings.BEHAVIOR_READING_WPM_MIN / 60000  # 基于最小阅读速度
            lam = max(lam, 0.5)

        # 泊松分布生成 (确保至少0.1秒)
        delay = max(float(np.random.poisson(lam)), 0.1)
        # 添加少量正态噪声
        noise = float(np.random.normal(0, lam * 0.1))
        delay = max(delay + noise, 0.05)
        return delay

    async def async_delay(self, lam: Optional[float] = None) -> None:
        """异步等待泊松延迟"""
        delay = self.poisson_delay(lam)
        await asyncio.sleep(delay)

    def reading_delay(self, char_count: int) -> float:
        """
        基于内容长度的阅读延迟

        根据阅读速度(WPM)计算阅读时间, 加上随机波动

        Args:
            char_count: 中文字符数

        Returns:
            阅读延迟 (秒)
        """
        # 中文字符大约每个字需要 60/WPM 秒 (WPM按字计)
        wpm = random.randint(
            self._settings.BEHAVIOR_READING_WPM_MIN,
            self._settings.BEHAVIOR_READING_WPM_MAX,
        )
        # 每分钟WPM个字, 每个字 60/WPM 秒
        base_delay = (char_count / wpm) * 60

        # 添加随机波动 (±30%)
        factor = float(np.random.normal(1.0, 0.15))
        factor = max(0.5, min(factor, 1.8))

        delay = base_delay * factor

        # 最小2秒, 最大30秒
        return max(2.0, min(delay, 30.0))

    async def async_reading_delay(self, char_count: int) -> None:
        """异步阅读延迟"""
        delay = self.reading_delay(char_count)
        await asyncio.sleep(delay)

    def page_transition_delay(self) -> float:
        """
        页面切换延迟

        模拟用户在不同页面间的切换间隔,
        通常比阅读延迟短, 但有较大的方差
        """
        # 1-4秒, 带右偏分布
        base = random.uniform(1.0, 3.0)
        extra = float(np.random.exponential(0.5))
        return base + min(extra, 5.0)

    async def async_page_transition(self) -> None:
        """异步页面切换延迟"""
        delay = self.page_transition_delay()
        await asyncio.sleep(delay)

    # ══════════════════════════════════════════════
    # 鼠标移动轨迹
    # ══════════════════════════════════════════════

    def generate_mouse_trajectory(
        self,
        start: Tuple[float, float],
        end: Tuple[float, float],
        steps: Optional[int] = None,
    ) -> List[MousePoint]:
        """
        生成拟人鼠标移动轨迹

        使用贝塞尔曲线 + 随机偏移,
        产生自然的人类鼠标移动轨迹.

        特征:
          - 起点和终点有小幅随机偏移
          - 轨迹有1-2个随机控制点 (贝塞尔曲线)
          - 速度不均匀 (起点慢 → 加速 → 接近目标减速)
          - 有轻微抖动

        Args:
            start: 起点 (x, y)
            end: 终点 (x, y)
            steps: 轨迹步数 (None=自动计算)

        Returns:
            轨迹点列表
        """
        sx, sy = start
        ex, ey = end

        # 起点小幅随机偏移
        sx += float(np.random.normal(0, 3))
        sy += float(np.random.normal(0, 3))

        # 计算步数 (基于距离)
        distance = math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2)
        if steps is None:
            steps = max(int(distance / 5), 10)
            steps = min(steps, 100)

        # 生成1-2个随机控制点 (用于贝塞尔曲线)
        num_control = random.randint(1, 2)
        control_points = []
        for i in range(num_control):
            t = (i + 1) / (num_control + 1)
            cx = sx + (ex - sx) * t + float(np.random.normal(0, distance * 0.15))
            cy = sy + (ey - sy) * t + float(np.random.normal(0, distance * 0.15))
            control_points.append((cx, cy))

        # 生成贝塞尔曲线上的点
        trajectory: List[MousePoint] = []
        all_points = [(sx, sy)] + control_points + [(ex, ey)]

        for step in range(steps + 1):
            t = step / steps
            # 二次/三次贝塞尔插值
            if len(all_points) == 3:
                # 二次贝塞尔
                x = self._quadratic_bezier(all_points[0], all_points[1], all_points[2], t)
                y = self._quadratic_bezier(
                    (all_points[0][1], all_points[0][0]),
                    (all_points[1][1], all_points[1][0]),
                    (all_points[2][1], all_points[2][0]),
                    t
                )
                # 注意这里x和y的映射需要修正
                x, y = self._bezier_point(all_points, t)
            else:
                x, y = self._bezier_point(all_points, t)

            # 添加微抖动
            x += float(np.random.normal(0, 0.8))
            y += float(np.random.normal(0, 0.8))

            # 时间戳 (非匀速: 两端慢, 中间快)
            speed_factor = self._ease_in_out(t)
            base_time = step * (distance / steps) / self._settings.BEHAVIOR_MOUSE_SPEED_MAX
            timestamp = base_time / speed_factor if speed_factor > 0.01 else base_time / 0.01

            trajectory.append(MousePoint(x=x, y=y, timestamp=timestamp))

        # 确保最后一个点精确到终点
        trajectory[-1].x = ex
        trajectory[-1].y = ey

        return trajectory

    @staticmethod
    def _bezier_point(points: List[Tuple[float, float]], t: float) -> Tuple[float, float]:
        """
        N阶贝塞尔曲线插值

        Args:
            points: 控制点列表
            t: 参数 [0, 1]

        Returns:
            (x, y)
        """
        if len(points) == 1:
            return points[0]

        new_points = []
        for i in range(len(points) - 1):
            x = points[i][0] * (1 - t) + points[i + 1][0] * t
            y = points[i][1] * (1 - t) + points[i + 1][1] * t
            new_points.append((x, y))

        return HumanBehavior._bezier_point(new_points, t)

    @staticmethod
    def _quadratic_bezier(p0, p1, p2, t):
        """二次贝塞尔曲线 (简化)"""
        return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2

    @staticmethod
    def _ease_in_out(t: float) -> float:
        """
        缓入缓出函数

        两端速度低, 中间速度高, 模拟人类鼠标加减速
        """
        # 使用sin函数生成平滑的加减速曲线
        return 0.5 * (1 - math.cos(math.pi * t))

    # ══════════════════════════════════════════════
    # 滚动模拟
    # ══════════════════════════════════════════════

    def generate_scroll_pattern(
        self,
        page_height: int,
        viewport_height: int = 1080,
    ) -> List[Tuple[int, float]]:
        """
        生成阅读滚动模式

        模拟用户阅读页面时的滚动行为:
          - 快速滚过不感兴趣的部分
          - 慢速滚动阅读重点内容
          - 偶尔回滚查看之前的内容
          - 在页面底部停留 (查看评论等)

        Args:
            page_height: 页面总高度 (像素)
            viewport_height: 视口高度

        Returns:
            [(scroll_y, delay_ms), ...] 滚动位置和停留时间列表
        """
        if page_height <= viewport_height:
            return [(0, 3000)]  # 页面不需要滚动

        max_scroll = page_height - viewport_height
        pattern: List[Tuple[int, float]] = []

        current_y = 0
        while current_y < max_scroll:
            # 随机滚动步长
            step = random.randint(
                self._settings.BEHAVIOR_SCROLL_STEP_MIN,
                self._settings.BEHAVIOR_SCROLL_STEP_MAX,
            )

            # 接近底部时减小步长
            remaining = max_scroll - current_y
            if remaining < step * 2:
                step = max(remaining // 2, 50)

            current_y = min(current_y + step, max_scroll)

            # 停留时间 (阅读延迟)
            # 随机模拟"快速浏览"和"仔细阅读"
            if random.random() > 0.7:  # 30%概率仔细阅读
                delay = random.uniform(2000, 5000)  # 2-5秒
            else:  # 70%快速浏览
                delay = random.uniform(300, 1500)  # 0.3-1.5秒

            pattern.append((current_y, delay))

            # 偶尔回滚 (10%概率)
            if random.random() < 0.1 and len(pattern) > 2:
                back_step = random.randint(100, 300)
                back_y = max(current_y - back_step, 0)
                pattern.append((back_y, random.uniform(500, 1500)))
                current_y = back_y

        # 底部停留
        pattern.append((max_scroll, random.uniform(1000, 3000)))

        return pattern

    # ══════════════════════════════════════════════
    # 阅读路径模拟
    # ══════════════════════════════════════════════

    def generate_viewport_size(self) -> Dict[str, int]:
        """
        生成随机视口大小

        模拟真实设备的视口尺寸,
        偏向常见的桌面分辨率
        """
        # 常见分辨率权重
        resolutions = [
            (1920, 1080, 0.35),  # Full HD
            (1366, 768, 0.20),   # 常见笔记本
            (1536, 864, 0.15),   # 缩放后
            (1440, 900, 0.10),   # MacBook
            (2560, 1440, 0.08),  # QHD
            (1280, 720, 0.07),   # HD
            (1600, 900, 0.05),   # HD+
        ]

        # 加权随机选择
        weights = [w for _, _, w in resolutions]
        chosen = random.choices(resolutions, weights=weights, k=1)[0]
        width, height, _ = chosen

        # 添加±50像素的随机偏移
        width += random.randint(-50, 50)
        height += random.randint(-50, 50)

        return {"width": width, "height": height}
