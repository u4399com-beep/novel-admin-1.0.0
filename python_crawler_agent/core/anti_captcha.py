"""
验证码自动识别模块

支持多种验证码类型:
  1. 滑块验证码 - OpenCV边缘检测 + 缺口定位 + 拟人拖拽轨迹
  2. 点击/选择验证码 - ddddocr目标检测 + 坐标提取
  3. 算术验证码 - OCR数字识别 + 表达式求值
  4. 限流机制 - 验证码频率激增时自动降低并发
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import math
import random
import re
import time
from collections import deque
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

from ..config import get_settings

logger = logging.getLogger(__name__)


class CaptchaType(Enum):
    """验证码类型"""
    SLIDER = "slider"           # 滑块验证码
    CLICK = "click"             # 点击验证码
    SELECT = "select"           # 选择验证码 (多选)
    ARITHMETIC = "arithmetic"   # 算术验证码
    INPUT = "input"             # 输入验证码 (字符)


@dataclass
class SliderResult:
    """滑块验证码识别结果"""
    gap_x: int              # 缺口X坐标
    gap_y: int              # 缺口Y坐标
    distance: int           # 需要滑动的距离
    trajectory: List[Tuple[int, int]]  # 拟人拖拽轨迹 [(x, y), ...]


@dataclass
class ClickResult:
    """点击验证码识别结果"""
    targets: List[Tuple[int, int]]  # 目标坐标列表 [(x, y), ...]
    labels: List[str]               # 目标标签 (如有)


@dataclass
class ArithmeticResult:
    """算术验证码识别结果"""
    expression: str    # 原始表达式
    answer: int        # 计算结果
    confidence: float  # 置信度


class CaptchaSolver:
    """
    验证码自动识别器

    集成OpenCV(图像处理) + ddddocr(OCR识别):
    - 滑块: Canny边缘检测 → 轮廓查找 → 匹配缺口
    - 点击: ddddocr目标检测 → 坐标提取
    - 算术: ddddocr文字识别 → 表达式求值
    """

    def __init__(self):
        self._settings = get_settings()
        self._ocr = None
        self._det = None  # ddddocr目标检测模型

        # 限流状态
        self._captcha_history: deque = deque(maxlen=100)  # 最近100次验证码时间戳
        self._current_concurrency: int = self._settings.CAPTCHA_MAX_CONCURRENT
        self._last_rate_check: float = 0.0

    def _init_ocr(self):
        """延迟初始化OCR模型"""
        if self._ocr is None:
            import ddddocr
            self._ocr = ddddocr.DdddOcr(show_ad=False)
            logger.info("ddddocr OCR模型加载完成")

    def _init_detector(self):
        """延迟初始化目标检测模型"""
        if self._det is None:
            import ddddocr
            self._det = ddddocr.DdddOcr(det=True, show_ad=False)
            logger.info("ddddocr 检测模型加载完成")

    # ══════════════════════════════════════════════
    # 滑块验证码
    # ══════════════════════════════════════════════

    def solve_slider(
        self,
        bg_image: bytes | np.ndarray | Image.Image,
        slider_image: bytes | np.ndarray | Image.Image,
        slider_width: int = 60,
        slider_height: int = 60,
    ) -> SliderResult:
        """
        识别滑块验证码

        算法:
          1. 将背景图和滑块图转为灰度
          2. Canny边缘检测
          3. 在背景图中查找缺口轮廓
          4. 匹配缺口位置
          5. 生成拟人拖拽轨迹

        Args:
            bg_image: 背景图 (含缺口)
            slider_image: 滑块图
            slider_width: 滑块宽度
            slider_height: 滑块高度

        Returns:
            SliderResult 包含缺口位置和拖拽轨迹
        """
        self._check_rate_limit()

        # 转为numpy数组
        bg = self._to_cv2(bg_image)
        slider = self._to_cv2(slider_image)

        # 查找缺口位置
        gap_x, gap_y = self._detect_gap_position(bg, slider, slider_width, slider_height)

        # 生成拟人拖拽轨迹
        trajectory = self._generate_drag_trajectory(gap_x)

        result = SliderResult(
            gap_x=gap_x,
            gap_y=gap_y,
            distance=gap_x,
            trajectory=trajectory,
        )

        self._record_captcha()
        logger.info("滑块验证码识别: 缺口位置=(%d, %d), 拖动距离=%d", gap_x, gap_y, gap_x)
        return result

    def _detect_gap_position(
        self,
        bg: np.ndarray,
        slider: np.ndarray,
        slider_w: int,
        slider_h: int,
    ) -> Tuple[int, int]:
        """
        检测缺口位置

        方法1: 模板匹配 (cv2.matchTemplate)
        方法2: 边缘差异检测
        """
        bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
        slider_gray = cv2.cvtColor(slider, cv2.COLOR_BGR2GRAY)

        # === 方法1: 模板匹配 ===
        # 对滑块图进行边缘提取
        slider_edge = cv2.Canny(slider_gray, 100, 200)

        # 对背景图进行边缘提取
        bg_edge = cv2.Canny(bg_gray, 100, 200)

        # 模板匹配
        result = cv2.matchTemplate(bg_edge, slider_edge, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)

        if max_val > 0.5:  # 匹配度阈值
            gap_x = max_loc[0] + slider_w // 2
            gap_y = max_loc[1] + slider_h // 2
            return gap_x, gap_y

        # === 方法2: 边缘差异检测 ===
        # 计算两图的绝对差异
        # 先把slider resize到与背景区域匹配
        diff = cv2.absdiff(bg_gray[:slider_h, :], slider_gray)
        _, threshold = cv2.threshold(diff, 50, 255, cv2.THRESH_BINARY)

        # 查找轮廓
        contours, _ = cv2.findContours(threshold, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        if contours:
            # 找到最大的轮廓 (应该是缺口)
            max_contour = max(contours, key=cv2.contourArea)
            x, y, w, h = cv2.boundingRect(max_contour)
            if w > 20 and h > 20:  # 合理的缺口大小
                gap_x = x + w // 2
                gap_y = y + h // 2
                return gap_x, gap_y

        # === 方法3: 基于颜色差异 (缺口通常颜色较暗/不同) ===
        bg_hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
        slider_hsv = cv2.cvtColor(slider, cv2.COLOR_BGR2HSV)

        # 计算背景区域与滑块的平均颜色差异
        slider_mean = np.mean(slider_hsv[:, :, 0])  # Hue通道均值

        bg_h = bg_hsv[:, :, 0]
        diff = np.abs(bg_h.astype(float) - slider_mean)
        _, mask = cv2.threshold(diff.astype(np.uint8), 15, 255, cv2.THRESH_BINARY)

        # 形态学操作去噪
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if contours:
            # 找到最右边的大轮廓 (缺口在右侧)
            valid_contours = [c for c in contours if cv2.contourArea(c) > 500]
            if valid_contours:
                # 按x坐标排序, 取最右侧
                valid_contours.sort(key=lambda c: cv2.boundingRect(c)[0], reverse=True)
                x, y, w, h = cv2.boundingRect(valid_contours[0])
                gap_x = x + w // 2
                gap_y = y + h // 2
                return gap_x, gap_y

        # 所有方法都失败, 返回估计值
        logger.warning("滑块缺口检测失败, 使用估计值")
        h, w = bg_gray.shape
        return w // 2, h // 2

    def _generate_drag_trajectory(self, distance: int) -> List[Tuple[int, int]]:
        """
        生成拟人拖拽轨迹

        特征:
          - 起步加速 (模拟手指按下)
          - 中间匀速
          - 接近目标减速 (模拟人类对准)
          - 微小随机抖动 (手抖)
          - 可能的轻微回弹 (过冲后回调)
        """
        trajectory: List[Tuple[int, int]] = [(0, 0)]

        # 将距离分为三个阶段
        accel_end = distance * 0.3    # 加速阶段结束点
        decel_start = distance * 0.7  # 减速阶段开始点

        current_x = 0
        current_y = 0
        t = 0

        # 加速阶段
        while current_x < accel_end:
            t += 1
            # 二次加速
            speed = min(2 + t * 0.8, 25)
            step = speed + random.uniform(-1, 1)
            current_x = min(current_x + step, distance)
            current_y += random.uniform(-0.5, 0.5)  # 微小Y抖动
            trajectory.append((int(current_x), int(current_y)))

        # 匀速阶段
        while current_x < decel_start:
            speed = random.uniform(15, 25)
            step = speed + random.uniform(-2, 2)
            current_x = min(current_x + step, distance)
            current_y += random.uniform(-0.3, 0.3)
            trajectory.append((int(current_x), int(current_y)))

        # 减速阶段
        while current_x < distance:
            remaining = distance - current_x
            # 越接近目标越慢
            speed = max(remaining * 0.3, 2)
            step = speed + random.uniform(-0.5, 0.5)
            current_x = min(current_x + step, distance)
            current_y += random.uniform(-0.2, 0.2)
            trajectory.append((int(current_x), int(current_y)))

        # 添加微小回弹 (模拟过冲)
        if random.random() > 0.3:  # 70%概率有回弹
            overshoot = random.randint(2, 8)
            trajectory.append((distance + overshoot, int(current_y)))
            # 回弹
            for _ in range(random.randint(1, 3)):
                current_x -= random.uniform(1, 3)
                current_x = max(current_x, distance - 2)
                trajectory.append((int(current_x), int(current_y)))
            # 最终对准
            trajectory.append((distance, int(current_y)))

        return trajectory

    # ══════════════════════════════════════════════
    # 点击/选择验证码
    # ══════════════════════════════════════════════

    def solve_click(
        self,
        image: bytes | np.ndarray | Image.Image,
        target_text: str = "",
    ) -> ClickResult:
        """
        识别点击验证码

        使用ddddocr目标检测模型找到图片中所有目标的位置,
        如果指定了target_text则进行OCR文字匹配

        Args:
            image: 验证码图片
            target_text: 需要点击的目标文字 (可选)

        Returns:
            ClickResult 包含目标坐标
        """
        self._check_rate_limit()
        self._init_detector()

        img_bytes = self._to_bytes(image)

        # 目标检测
        poses = self._det.detection(img_bytes)

        if not poses:
            self._record_captcha()
            raise ValueError("未检测到任何目标")

        targets: List[Tuple[int, int]] = []
        labels: List[str] = []

        # 每个检测到的目标的中心点
        for box in poses:
            x1, y1, x2, y2 = box
            center_x = (x1 + x2) // 2
            center_y = (y1 + y2) // 2
            targets.append((center_x, center_y))

        # 如果需要文字匹配, 对每个目标区域做OCR
        if target_text and self._ocr is None:
            self._init_ocr()

        if target_text and self._ocr:
            img_np = self._to_cv2(image)
            matched_targets = []
            matched_labels = []

            for i, box in enumerate(poses):
                x1, y1, x2, y2 = box
                # 裁剪目标区域
                roi = img_np[y1:y2, x1:x2]
                roi_bytes = cv2.imencode('.png', roi)[1].tobytes()

                # OCR识别
                try:
                    text = self._ocr.classification(roi_bytes)
                    if target_text in text:
                        matched_targets.append(targets[i])
                        matched_labels.append(text)
                except Exception as e:
                    logger.debug("目标区域OCR失败: %s", e)

            if matched_targets:
                targets = matched_targets
                labels = matched_labels

        self._record_captcha()
        logger.info(
            "点击验证码识别: 检测到%d个目标, 匹配%d个",
            len(poses), len(targets)
        )
        return ClickResult(targets=targets, labels=labels)

    # ══════════════════════════════════════════════
    # 算术验证码
    # ══════════════════════════════════════════════

    def solve_arithmetic(
        self,
        image: bytes | np.ndarray | Image.Image,
    ) -> ArithmeticResult:
        """
        识别算术验证码

        流程:
          1. OCR识别图片中的文字
          2. 提取数字和运算符
          3. 构造数学表达式并求值

        Args:
            image: 验证码图片

        Returns:
            ArithmeticResult 包含表达式和答案
        """
        self._check_rate_limit()
        self._init_ocr()

        img_bytes = self._to_bytes(image)

        # OCR识别
        text = self._ocr.classification(img_bytes)
        logger.info("算术验证码OCR结果: '%s'", text)

        # 提取数学表达式
        expression, answer = self._parse_arithmetic(text)

        self._record_captcha()

        if answer is not None:
            return ArithmeticResult(
                expression=expression,
                answer=answer,
                confidence=0.85,
            )
        else:
            # OCR可能识别错误, 尝试图片预处理后重新识别
            result = self._retry_arithmetic_with_preprocess(image)
            if result:
                return result
            raise ValueError(f"无法解析算术表达式: '{text}'")

    def _parse_arithmetic(self, text: str) -> Tuple[str, Optional[int]]:
        """
        从OCR文本中提取算术表达式

        支持的格式:
          - "3 + 5 = ?"
          - "12-7"
          - "3x5" (x当作乘号)
          - "二十三加十五" (中文数字, 基础支持)
        """
        # 清理文本
        text = text.strip().replace(" ", "").replace("＝", "=").replace("？", "?")

        # 替换常见的OCR混淆字符
        text = text.replace("x", "*").replace("×", "*").replace("÷", "/")
        text = text.replace("O", "0").replace("o", "0").replace("l", "1").replace("I", "1")
        text = text.replace("S", "5").replace("B", "8").replace("Z", "2")

        # 提取表达式 (去掉=和?后面的部分)
        expr_match = re.match(r'^([\d+\-*/().]+)=?\??', text)
        if expr_match:
            expr = expr_match.group(1)
            try:
                # 安全求值 (只允许数字和运算符)
                if re.match(r'^[\d+\-*/().]+$', expr):
                    answer = int(eval(expr))  # noqa: S307 - 已验证只含数字和运算符
                    return expr, answer
            except Exception:
                pass

        # 尝试提取数字间的运算
        nums = re.findall(r'\d+', text)
        ops = re.findall(r'[+\-*/]', text)

        if len(nums) >= 2 and ops:
            expr = nums[0] + ops[0] + nums[1]
            try:
                answer = int(eval(expr))  # noqa: S307
                return expr, answer
            except Exception:
                pass

        return text, None

    def _retry_arithmetic_with_preprocess(
        self, image: bytes | np.ndarray | Image.Image
    ) -> Optional[ArithmeticResult]:
        """图片预处理后重试算术识别"""
        img = self._to_cv2(image)

        # 尝试多种预处理
        preprocess_methods = [
            # 灰度 + 二值化
            lambda i: cv2.threshold(
                cv2.cvtColor(i, cv2.COLOR_BGR2GRAY), 127, 255, cv2.THRESH_BINARY
            )[1],
            # 灰度 + 自适应二值化
            lambda i: cv2.adaptiveThreshold(
                cv2.cvtColor(i, cv2.COLOR_BGR2GRAY), 255,
                cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2
            ),
            # 放大2倍
            lambda i: cv2.resize(i, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC),
            # 降噪
            lambda i: cv2.fastNlMeansDenoisingColored(i, None, 10, 10, 7, 21),
        ]

        for method in preprocess_methods:
            try:
                processed = method(img)
                processed_bytes = cv2.imencode('.png', processed)[1].tobytes()
                text = self._ocr.classification(processed_bytes)
                expression, answer = self._parse_arithmetic(text)
                if answer is not None:
                    logger.info("预处理后识别成功: '%s' = %d", expression, answer)
                    return ArithmeticResult(
                        expression=expression,
                        answer=answer,
                        confidence=0.6,
                    )
            except Exception as e:
                logger.debug("预处理重试失败: %s", e)
                continue

        return None

    # ══════════════════════════════════════════════
    # 通用输入验证码
    # ══════════════════════════════════════════════

    def solve_input(self, image: bytes | np.ndarray | Image.Image) -> str:
        """
        识别通用输入验证码 (字母数字混合)

        Args:
            image: 验证码图片

        Returns:
            识别的文字
        """
        self._check_rate_limit()
        self._init_ocr()

        # 尝试直接识别
        img_bytes = self._to_bytes(image)
        text = self._ocr.classification(img_bytes)

        # 如果结果太短, 尝试预处理
        if len(text) < 3:
            result = self._retry_arithmetic_with_preprocess(image)
            if result:
                text = result.expression

        self._record_captcha()
        logger.info("输入验证码识别: '%s'", text)
        return text.strip()

    # ══════════════════════════════════════════════
    # 限流机制
    # ══════════════════════════════════════════════

    def _check_rate_limit(self) -> None:
        """
        检查验证码频率, 必要时降低并发

        当每分钟验证码次数超过阈值时, 自动降低并发数
        """
        now = time.time()
        one_minute_ago = now - 60

        # 清理过期记录
        while self._captcha_history and self._captcha_history[0] < one_minute_ago:
            self._captcha_history.popleft()

        rate = len(self._captcha_history)

        if rate > self._settings.CAPTCHA_RATE_LIMIT_THRESHOLD:
            # 计算新的并发数
            new_concurrency = max(
                1,
                int(self._settings.CAPTCHA_MAX_CONCURRENT / (rate / self._settings.CAPTCHA_RATE_LIMIT_THRESHOLD))
            )
            if new_concurrency < self._current_concurrency:
                self._current_concurrency = new_concurrency
                logger.warning(
                    "验证码频率过高 (%d次/分钟), 并发降至 %d",
                    rate, new_concurrency
                )

        # 频率检查间隔
        if now - self._last_rate_check > 30:
            self._last_rate_check = now
            # 如果频率恢复正常, 逐步恢复并发
            if rate < self._settings.CAPTCHA_RATE_LIMIT_THRESHOLD // 2:
                self._current_concurrency = min(
                    self._current_concurrency + 1,
                    self._settings.CAPTCHA_MAX_CONCURRENT
                )

    def _record_captcha(self) -> None:
        """记录一次验证码识别"""
        self._captcha_history.append(time.time())

    @property
    def current_concurrency(self) -> int:
        """当前允许的并发数"""
        return self._current_concurrency

    # ══════════════════════════════════════════════
    # 工具方法
    # ══════════════════════════════════════════════

    @staticmethod
    def _to_cv2(image: bytes | np.ndarray | Image.Image) -> np.ndarray:
        """统一转为OpenCV格式 (BGR numpy数组)"""
        if isinstance(image, np.ndarray):
            return image
        if isinstance(image, Image.Image):
            return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
        if isinstance(image, bytes):
            nparr = np.frombuffer(image, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if img is None:
                raise ValueError("无法解码图片")
            return img
        raise TypeError(f"不支持的图片类型: {type(image)}")

    @staticmethod
    def _to_bytes(image: bytes | np.ndarray | Image.Image) -> bytes:
        """统一转为bytes"""
        if isinstance(image, bytes):
            return image
        if isinstance(image, np.ndarray):
            return cv2.imencode('.png', image)[1].tobytes()
        if isinstance(image, Image.Image):
            buf = io.BytesIO()
            image.save(buf, format='PNG')
            return buf.getvalue()
        raise TypeError(f"不支持的图片类型: {type(image)}")
