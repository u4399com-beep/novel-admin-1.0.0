"""
字体反爬对抗模块

小说网站常见的字体反爬手段:
  - 自定义WOFF/TTF字体, 将常用汉字映射到其他Unicode码位
  - CSS @font-face加载自定义字体
  - 定期更换字体文件, 字符映射关系随之变化

对抗方案:
  1. 下载并解析WOFF/TTF字体文件 (fontTools)
  2. 提取每个字形(glyph)的轮廓 → 渲染为图片
  3. ddddocr OCR识别图片中的真实字符
  4. 建立 Unicode码位 → 真实字符 的映射表
  5. 监控CSS中的字体文件URL, 哈希变化时自动重新解析
  6. 映射表缓存(TTL), 减少重复OCR开销

Fallback链: OCR识别 → 哈希查找 → 手动映射
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import redis
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

from ..config import get_settings

logger = logging.getLogger(__name__)


@dataclass
class FontMapping:
    """字体映射表"""
    font_url: str                         # 字体文件URL
    font_hash: str                        # 字体文件哈希
    mapping: Dict[str, str] = field(default_factory=dict)  # unicode → real_char
    reverse_mapping: Dict[str, str] = field(default_factory=dict)  # real_char → unicode
    created_at: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)


class FontDecoder:
    """
    字体反爬解码器

    流程:
      1. 从CSS中提取@font-face的src URL
      2. 下载字体文件, 计算哈希
      3. 用fontTools解析字体, 遍历cmap表
      4. 对每个字形渲染为图片, OCR识别真实字符
      5. 构建unicode→char映射表
      6. 监控字体变化, 自动更新
    """

    # 常见汉字范围 (用于筛选需要识别的字符)
    COMMON_CJK_RANGES = [
        (0x4E00, 0x9FFF),   # CJK Unified Ideographs
        (0x3400, 0x4DBF),   # CJK Unified Ideographs Extension A
        (0x3000, 0x303F),   # CJK Symbols and Punctuation
        (0xFF00, 0xFFEF),   # Fullwidth Forms
    ]

    # 用于OCR的数字和字母
    COMMON_CHARS = set(
        '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
        '的一是不了人我在有他这为之大来以个中上们到说时地也子就道出会三你要于下得生和去过能那可以对然好于学小都然什么'
    )

    def __init__(self, redis_client: Optional[redis.Redis] = None, fetcher=None):
        """
        初始化字体解码器

        Args:
            redis_client: Redis客户端 (缓存映射表)
            fetcher: 请求引擎 (下载字体文件)
        """
        self._settings = get_settings()

        if redis_client:
            self._redis = redis_client
        else:
            self._redis = redis.Redis.from_url(
                self._settings.REDIS_URL,
                db=self._settings.REDIS_FONT_DB,
                decode_responses=True,
            )

        self._fetcher = fetcher
        self._mappings: Dict[str, FontMapping] = {}  # url → FontMapping
        self._ocr = None
        self._glyph_cache: Dict[str, str] = {}  # glyph_hash → char

        logger.info("字体解码器初始化完成")

    def _init_ocr(self):
        """延迟初始化OCR"""
        if self._ocr is None:
            import ddddocr
            self._ocr = ddddocr.DdddOcr(show_ad=False)
            logger.info("FontDecoder: ddddocr OCR模型加载完成")

    # ══════════════════════════════════════════════
    # 主要接口
    # ══════════════════════════════════════════════

    async def decode_text(self, text: str, font_url: str) -> str:
        """
        解码字体反爬文本

        将文本中的每个字符通过映射表替换为真实字符

        Args:
            text: 包含字体反爬字符的文本
            font_url: 字体文件URL

        Returns:
            解码后的真实文本
        """
        if not text:
            return text

        # 获取或构建映射表
        mapping = await self.get_mapping(font_url)
        if not mapping or not mapping.mapping:
            logger.warning("字体映射表为空, 无法解码: %s", font_url)
            return text

        # 逐字符替换
        result = []
        for char in text:
            real_char = mapping.mapping.get(char, char)
            result.append(real_char)

        decoded = ''.join(result)
        if decoded != text:
            logger.debug("字体解码: 替换了 %d/%d 个字符", sum(1 for c in text if mapping.mapping.get(c) != c), len(text))

        return decoded

    async def get_mapping(self, font_url: str) -> Optional[FontMapping]:
        """
        获取字体映射表

        优先级: 内存 → Redis → 重新下载解析
        """
        # 1. 内存缓存
        if font_url in self._mappings:
            mapping = self._mappings[font_url]
            if time.time() - mapping.created_at < self._settings.FONT_CACHE_TTL:
                mapping.last_used = time.time()
                return mapping

        # 2. Redis缓存
        cached = self._load_from_redis(font_url)
        if cached:
            self._mappings[font_url] = cached
            return cached

        # 3. 重新下载解析
        return await self._build_mapping(font_url)

    # ══════════════════════════════════════════════
    # 字体解析
    # ══════════════════════════════════════════════

    async def _build_mapping(self, font_url: str) -> Optional[FontMapping]:
        """
        下载字体文件并构建映射表

        流程:
          1. 下载字体文件
          2. 计算哈希, 检查是否有缓存
          3. 用fontTools解析字体
          4. 遍历字形, OCR识别
          5. 构建映射表并缓存
        """
        logger.info("开始构建字体映射: %s", font_url)

        # 下载字体文件
        font_data = await self._download_font(font_url)
        if not font_data:
            logger.error("下载字体文件失败: %s", font_url)
            return None

        # 计算哈希
        font_hash = hashlib.md5(font_data).hexdigest()
        logger.info("字体文件哈希: %s (大小: %d bytes)", font_hash, len(font_data))

        # 检查哈希缓存 (同一字体文件可能被不同URL引用)
        hash_cached = self._load_from_redis_by_hash(font_hash)
        if hash_cached:
            hash_cached.font_url = font_url
            self._mappings[font_url] = hash_cached
            logger.info("命中哈希缓存: %s → %s", font_hash, font_url)
            return hash_cached

        # 解析字体
        try:
            mapping = await self._parse_font(font_data, font_url, font_hash)
            if mapping and mapping.mapping:
                # 缓存
                self._save_to_redis(mapping)
                self._mappings[font_url] = mapping
                logger.info(
                    "字体映射构建完成: %d 个字符映射",
                    len(mapping.mapping)
                )
                return mapping
        except Exception as e:
            logger.error("解析字体失败: %s - %s", font_url, e)

        return None

    async def _parse_font(
        self, font_data: bytes, font_url: str, font_hash: str
    ) -> Optional[FontMapping]:
        """
        解析字体文件, 构建unicode→char映射

        使用fontTools读取cmap表获取字形信息,
        将每个字形渲染为图片后用OCR识别真实字符
        """
        self._init_ocr()

        # 加载字体
        font = TTFont(io.BytesIO(font_data))
        cmap = font.getBestCmap()  # unicode → glyph_name

        if not cmap:
            logger.warning("字体无cmap表: %s", font_url)
            return None

        mapping: Dict[str, str] = {}
        reverse_mapping: Dict[str, str] = {}

        # 过滤需要识别的字符 (非ASCII + 在CJK范围内的)
        unicode_to_recognize = []
        for code, glyph_name in cmap.items():
            if self._should_recognize(code):
                unicode_to_recognize.append((code, glyph_name))

        logger.info(
            "字体包含 %d 个字形, 需识别 %d 个",
            len(cmap), len(unicode_to_recognize)
        )

        # 逐个字形渲染并OCR
        for code, glyph_name in unicode_to_recognize:
            char = chr(code)

            # 渲染字形为图片
            glyph_image = self._render_glyph(font, code, glyph_name)
            if glyph_image is None:
                continue

            # OCR识别
            real_char = self._recognize_glyph(glyph_image, code)

            if real_char and real_char != char and len(real_char) == 1:
                mapping[char] = real_char
                reverse_mapping[real_char] = char
                logger.debug("映射: U+%04X '%s' → '%s'", code, char, real_char)

        # Fallback: 尝试基于字形轮廓哈希的映射
        if len(mapping) < len(unicode_to_recognize) * 0.3:
            logger.info("OCR识别率较低, 尝试哈希匹配...")
            self._try_hash_matching(font, unicode_to_recognize, mapping, reverse_mapping)

        font.close()

        return FontMapping(
            font_url=font_url,
            font_hash=font_hash,
            mapping=mapping,
            reverse_mapping=reverse_mapping,
        )

    def _should_recognize(self, code: int) -> bool:
        """判断Unicode码位是否需要OCR识别"""
        # 跳过ASCII字符
        if code < 0x80:
            return False

        # 检查是否在CJK范围内
        for start, end in self.COMMON_CJK_RANGES:
            if start <= code <= end:
                return True

        # 特殊范围
        if 0x2000 <= code <= 0x206F:  # General Punctuation
            return True
        if 0x2100 <= code <= 0x214F:  # Letterlike Symbols
            return True

        return False

    def _render_glyph(
        self, font: TTFont, code: int, glyph_name: str, size: int = 64
    ) -> Optional[Image.Image]:
        """
        将字形渲染为PIL图片

        流程:
          1. 从字体中提取字形轮廓
          2. 用fontTools的glyf表获取坐标点
          3. 渲染到PIL Image上
        """
        try:
            # 尝试获取字形轮廓
            glyph_set = font.getGlyphSet()
            if glyph_name not in glyph_set:
                return None

            glyph = glyph_set[glyph_name]

            # 创建画布
            img = Image.new('L', (size, size), 255)  # 白底
            draw = ImageDraw.Draw(img)

            # 使用PIL的ImageFont渲染
            # 需要将TTFont转为PIL可用的字体
            buf = io.BytesIO()
            font.save(buf)
            buf.seek(0)

            try:
                pil_font = ImageFont.truetype(buf, size - 8)
            except Exception:
                # 某些字体格式可能不兼容, 尝试直接渲染
                pil_font = ImageFont.load_default()

            char = chr(code)
            # 计算字符位置 (居中)
            try:
                bbox = draw.textbbox((0, 0), char, font=pil_font)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
                x = (size - tw) // 2 - bbox[0]
                y = (size - th) // 2 - bbox[1]
            except Exception:
                x, y = 4, 4

            draw.text((x, y), char, fill=0, font=pil_font)

            return img

        except Exception as e:
            logger.debug("渲染字形失败 U+%04X (%s): %s", code, glyph_name, e)
            return None

    def _recognize_glyph(self, image: Image.Image, original_code: int) -> Optional[str]:
        """
        OCR识别字形图片

        Fallback链: OCR → 字形哈希查找
        """
        # 1. OCR识别
        try:
            buf = io.BytesIO()
            image.save(buf, format='PNG')
            img_bytes = buf.getvalue()

            result = self._ocr.classification(img_bytes)
            if result and len(result) == 1:
                return result
            if result and len(result) > 1:
                # 取置信度最高的 (通常是第一个)
                return result[0]
        except Exception as e:
            logger.debug("OCR识别失败 U+%04X: %s", original_code, e)

        # 2. 哈希查找
        glyph_hash = self._compute_image_hash(image)
        if glyph_hash in self._glyph_cache:
            return self._glyph_cache[glyph_hash]

        return None

    def _try_hash_matching(
        self,
        font: TTFont,
        candidates: List[Tuple[int, str]],
        mapping: Dict[str, str],
        reverse_mapping: Dict[str, str],
    ) -> None:
        """基于字形轮廓哈希的映射匹配"""
        glyph_set = font.getGlyphSet()

        for code, glyph_name in candidates:
            char = chr(code)
            if char in mapping:
                continue  # 已有映射

            try:
                glyph = glyph_set[glyph_name]
                # 使用字形的pen来获取轮廓坐标
                from fontTools.pens.recordingPen import RecordingPen
                recorder = RecordingPen()
                glyph.draw(recorder)

                # 将操作序列哈希化
                ops_str = str(recorder.value)
                ops_hash = hashlib.md5(ops_str.encode()).hexdigest()

                # 在全局缓存中查找
                if ops_hash in self._glyph_cache:
                    real_char = self._glyph_cache[ops_hash]
                    mapping[char] = real_char
                    reverse_mapping[real_char] = char
                    logger.debug("哈希匹配: U+%04X '%s' → '%s'", code, char, real_char)

            except Exception:
                continue

    @staticmethod
    def _compute_image_hash(image: Image.Image) -> str:
        """计算图片感知哈希 (简化版)"""
        # 缩小到8x8
        small = image.resize((8, 8), Image.LANCZOS)
        # 转为灰度 (如果还不是)
        if small.mode != 'L':
            small = small.convert('L')
        # 计算均值
        pixels = list(small.getdata())
        avg = sum(pixels) / len(pixels)
        # 生成哈希
        hash_bits = ''.join('1' if p > avg else '0' for p in pixels)
        return hash_bits

    # ══════════════════════════════════════════════
    # 字体监控
    # ══════════════════════════════════════════════

    async def check_font_change(self, url: str) -> bool:
        """
        检查指定URL的字体文件是否发生变化

        通过对比字体文件哈希判断是否需要重新解析

        Returns:
            True表示字体已变化, False表示未变化
        """
        if not self._fetcher:
            logger.warning("无fetcher, 无法检查字体变化")
            return False

        try:
            resp = await self._fetcher.fetch(url, expected_content_types=['font', 'octet-stream'])
            if not resp.is_success:
                return False

            new_hash = hashlib.md5(resp.content).hexdigest()

            # 查找旧哈希
            old_mapping = self._mappings.get(url)
            if old_mapping and old_mapping.font_hash == new_hash:
                return False

            # 字体变化, 重新构建映射
            logger.info("字体文件已变化: %s (旧哈希: %s, 新哈希: %s)", url,
                        old_mapping.font_hash if old_mapping else 'N/A', new_hash)

            # 构建新映射
            new_mapping = await self._build_mapping(url)
            return new_mapping is not None

        except Exception as e:
            logger.error("检查字体变化失败: %s - %s", url, e)
            return False

    def extract_font_urls_from_css(self, css_text: str) -> List[str]:
        """
        从CSS文本中提取@font-face的字体URL

        支持的格式:
          - url('http://example.com/font.woff')
          - url("http://example.com/font.ttf")
          - url(http://example.com/font.woff2)
        """
        pattern = r'@font-face[^}]*?url\([\'"]?([^\'"\)]+\.(?:woff2?|ttf|eot|otf))[\'"]?\)'
        urls = re.findall(pattern, css_text, re.IGNORECASE | re.DOTALL)
        return list(set(urls))  # 去重

    # ══════════════════════════════════════════════
    # 下载辅助
    # ══════════════════════════════════════════════

    async def _download_font(self, font_url: str) -> Optional[bytes]:
        """下载字体文件"""
        if self._fetcher:
            try:
                resp = await self._fetcher.fetch(
                    font_url,
                    expected_content_types=['font', 'octet-stream', 'binary'],
                )
                if resp.is_success and resp.content_length > 100:
                    return resp.content
            except Exception as e:
                logger.error("通过fetcher下载字体失败: %s", e)

        # Fallback: 直接用aiohttp下载
        import aiohttp
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(font_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                    if resp.status == 200:
                        return await resp.read()
        except Exception as e:
            logger.error("直接下载字体失败: %s - %s", font_url, e)

        return None

    # ══════════════════════════════════════════════
    # Redis缓存
    # ══════════════════════════════════════════════

    _REDIS_PREFIX = "crawler:font:"
    _REDIS_HASH_PREFIX = "crawler:font_hash:"

    def _save_to_redis(self, mapping: FontMapping) -> None:
        """保存映射表到Redis"""
        try:
            import json

            key = self._REDIS_PREFIX + hashlib.md5(mapping.font_url.encode()).hexdigest()
            data = {
                "font_url": mapping.font_url,
                "font_hash": mapping.font_hash,
                "mapping": json.dumps(mapping.mapping, ensure_ascii=False),
                "reverse_mapping": json.dumps(mapping.reverse_mapping, ensure_ascii=False),
                "created_at": str(mapping.created_at),
            }

            self._redis.hset(key, mapping=data)
            self._redis.expire(key, self._settings.FONT_CACHE_TTL + 300)

            # 同时按哈希索引
            hash_key = self._REDIS_HASH_PREFIX + mapping.font_hash
            self._redis.hset(hash_key, mapping={"url": mapping.font_url})
            self._redis.expire(hash_key, self._settings.FONT_CACHE_TTL * 24)  # 哈希缓存更久

            logger.debug("映射表已缓存到Redis: %s", key)
        except Exception as e:
            logger.error("保存映射表到Redis失败: %s", e)

    def _load_from_redis(self, font_url: str) -> Optional[FontMapping]:
        """从Redis加载映射表"""
        try:
            import json

            key = self._REDIS_PREFIX + hashlib.md5(font_url.encode()).hexdigest()
            data = self._redis.hgetall(key)

            if not data or not data.get("mapping"):
                return None

            mapping = FontMapping(
                font_url=data["font_url"],
                font_hash=data["font_hash"],
                mapping=json.loads(data["mapping"]),
                reverse_mapping=json.loads(data["reverse_mapping"]),
                created_at=float(data.get("created_at", time.time())),
            )

            # 检查TTL
            if time.time() - mapping.created_at > self._settings.FONT_CACHE_TTL:
                return None

            return mapping
        except Exception as e:
            logger.error("从Redis加载映射表失败: %s", e)
            return None

    def _load_from_redis_by_hash(self, font_hash: str) -> Optional[FontMapping]:
        """通过哈希查找映射表"""
        try:
            hash_key = self._REDIS_HASH_PREFIX + font_hash
            data = self._redis.hgetall(hash_key)

            if not data or "url" not in data:
                return None

            return self._load_from_redis(data["url"])
        except Exception:
            return None

    def close(self) -> None:
        """清理资源"""
        self._mappings.clear()
        self._glyph_cache.clear()
        try:
            self._redis.close()
        except Exception:
            pass
        logger.info("字体解码器已关闭")
