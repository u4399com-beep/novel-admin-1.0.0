"""
Configuration for the Translate micro-service.
"""

import os

# Server
HOST = os.environ.get("TRANSLATE_HOST", "0.0.0.0")
PORT = int(os.environ.get("TRANSLATE_PORT", "3032"))
DEBUG = os.environ.get("TRANSLATE_DEBUG", "false").lower() == "true"

# LibreTranslate backend
LIBRETRANSLATE_URL = os.environ.get(
    "LIBRETRANSLATE_URL", "http://127.0.0.1:5674"
)
LIBRETRANSLATE_TIMEOUT = int(os.environ.get("LIBRETRANSLATE_TIMEOUT", "30"))

# Fallback settings
FALLBACK_ENABLED = True  # Always enable built-in fallback
MAX_TEXT_LENGTH = 50_000  # Max characters per translation request
BATCH_MAX_ITEMS = 50  # Max items in batch request
