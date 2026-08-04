"""
Translate micro-service — Flask API on port 3032.

Provides translation endpoints backed by LibreTranslate (when available)
with a built-in dictionary-based fallback for basic novel translation.
"""

import logging
import time

import requests as http_requests
from flask import Flask, jsonify, request
from flask_cors import CORS

import config
from translator import BasicTranslator, translate_html

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("translate-service")

# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
# Backend state
# ---------------------------------------------------------------------------
basic_translator = BasicTranslator()
_libretranslate_available = False
_libretranslate_languages = []
_lt_check_time = 0.0
_LT_CHECK_INTERVAL = 60  # re-check LT availability every 60 s


def _check_libretranslate() -> bool:
    """Check if the local LibreTranslate instance is reachable."""
    global _libretranslate_available, _libretranslate_languages, _lt_check_time
    now = time.time()
    if now - _lt_check_time < _LT_CHECK_INTERVAL:
        return _libretranslate_available
    _lt_check_time = now
    try:
        resp = http_requests.get(
            f"{config.LIBRETRANSLATE_URL}/languages",
            timeout=config.LIBRETRANSLATE_TIMEOUT,
        )
        if resp.status_code == 200:
            _libretranslate_available = True
            _libretranslate_languages = resp.json()
            logger.info("LibreTranslate backend is available at %s", config.LIBRETRANSLATE_URL)
        else:
            _libretranslate_available = False
            logger.warning("LibreTranslate returned status %s", resp.status_code)
    except Exception:
        _libretranslate_available = False
        logger.info("LibreTranslate not available — using built-in fallback")
    return _libretranslate_available


# ---------------------------------------------------------------------------
# LibreTranslate proxy helpers
# ---------------------------------------------------------------------------

def _lt_translate(text: str, source: str, target: str, fmt: str = "text") -> dict:
    """Proxy translation to LibreTranslate."""
    resp = http_requests.post(
        f"{config.LIBRETRANSLATE_URL}/translate",
        json={"q": text, "source": source, "target": target, "format": fmt},
        timeout=config.LIBRETRANSLATE_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    return {
        "translated_text": data.get("translatedText", ""),
        "source": source,
        "target": target,
        "confidence": data.get("confidence", 0.0),
    }


def _lt_detect(text: str) -> dict:
    """Proxy language detection to LibreTranslate."""
    resp = http_requests.post(
        f"{config.LIBRETRANSLATE_URL}/detect",
        json={"q": text},
        timeout=config.LIBRETRANSLATE_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    # LT returns a list; pick the best
    if isinstance(data, list) and len(data) > 0:
        best = max(data, key=lambda x: x.get("confidence", 0))
        return {
            "detected_language": best.get("language", "en"),
            "confidence": best.get("confidence", 0.0),
        }
    return {"detected_language": "en", "confidence": 0.0}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    """Health check — also reports backend status and available languages."""
    lt_up = _check_libretranslate()
    langs = []
    if lt_up:
        langs = _libretranslate_languages
    else:
        langs = basic_translator.get_languages()
    return jsonify({
        "status": "ok",
        "service": "translate-service",
        "port": config.PORT,
        "backend": "libretranslate" if lt_up else "basic-fallback",
        "backend_url": config.LIBRETRANSLATE_URL,
        "languages": langs,
    })


@app.route("/languages", methods=["GET"])
def languages():
    """Return supported language list."""
    lt_up = _check_libretranslate()
    if lt_up:
        return jsonify({"languages": _libretranslate_languages})
    return jsonify({"languages": basic_translator.get_languages()})


@app.route("/translate", methods=["POST"])
def translate():
    """Main translation endpoint.

    Request: {"text": str, "source": str, "target": str, "format": "text"|"html"}
    Response: {"translated_text": str, "source": str, "target": str, "confidence": number}
    """
    body = request.get_json(silent=True) or {}
    text = body.get("text", "")
    source = body.get("source", "en")
    target = body.get("target", "zh")
    fmt = body.get("format", "text")

    if not text:
        return jsonify({"error": "text is required"}), 400

    if len(text) > config.MAX_TEXT_LENGTH:
        return jsonify({"error": f"text exceeds max length of {config.MAX_TEXT_LENGTH}"}), 400

    # Validate source/target
    supported = {"zh", "en", "ja", "ko"}
    if source not in supported:
        return jsonify({"error": f"unsupported source language: {source}"}), 400
    if target not in supported:
        return jsonify({"error": f"unsupported target language: {target}"}), 400

    # Try LibreTranslate first
    lt_up = _check_libretranslate()
    if lt_up:
        try:
            return jsonify(_lt_translate(text, source, target, fmt))
        except Exception as exc:
            logger.warning("LibreTranslate translation failed: %s — falling back", exc)

    # Fallback
    if fmt == "html":
        result = translate_html(text, source, target, basic_translator)
    else:
        result = basic_translator.translate(text, source, target)

    return jsonify(result)


@app.route("/translate/batch", methods=["POST"])
def translate_batch():
    """Batch translate multiple texts.

    Request: {"texts": str[], "source": str, "target": str}
    Response: {"translations": str[], "source": str, "target": str}
    """
    body = request.get_json(silent=True) or {}
    texts = body.get("texts", [])
    source = body.get("source", "en")
    target = body.get("target", "zh")

    if not isinstance(texts, list):
        return jsonify({"error": "texts must be a list"}), 400

    if len(texts) > config.BATCH_MAX_ITEMS:
        return jsonify({"error": f"batch exceeds max of {config.BATCH_MAX_ITEMS} items"}), 400

    for i, t in enumerate(texts):
        if len(t) > config.MAX_TEXT_LENGTH:
            return jsonify({"error": f"text at index {i} exceeds max length"}), 400

    supported = {"zh", "en", "ja", "ko"}
    if source not in supported:
        return jsonify({"error": f"unsupported source language: {source}"}), 400
    if target not in supported:
        return jsonify({"error": f"unsupported target language: {target}"}), 400

    # Try LibreTranslate first (batch via individual calls since LT doesn't have a batch endpoint)
    lt_up = _check_libretranslate()
    translations = []
    if lt_up:
        try:
            for t in texts:
                result = _lt_translate(t, source, target)
                translations.append(result["translated_text"])
            return jsonify({"translations": translations, "source": source, "target": target})
        except Exception as exc:
            logger.warning("LibreTranslate batch failed: %s — falling back", exc)
            translations = []

    # Fallback
    for t in texts:
        result = basic_translator.translate(t, source, target)
        translations.append(result["translated_text"])

    return jsonify({"translations": translations, "source": source, "target": target})


@app.route("/detect", methods=["POST"])
def detect():
    """Language detection.

    Request: {"text": str}
    Response: {"detected_language": str, "confidence": number}
    """
    body = request.get_json(silent=True) or {}
    text = body.get("text", "")

    if not text:
        return jsonify({"error": "text is required"}), 400

    # Try LibreTranslate first
    lt_up = _check_libretranslate()
    if lt_up:
        try:
            return jsonify(_lt_detect(text))
        except Exception as exc:
            logger.warning("LibreTranslate detect failed: %s — falling back", exc)

    # Fallback
    result = basic_translator.detect(text)
    return jsonify(result)


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------

@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "not found"}), 404


@app.errorhandler(500)
def server_error(_e):
    return jsonify({"error": "internal server error"}), 500


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logger.info("Starting translate-service on %s:%d", config.HOST, config.PORT)
    # Check LibreTranslate availability at startup
    _check_libretranslate()
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
