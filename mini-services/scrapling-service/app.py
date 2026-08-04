"""
Scrapling Python micro-service – a Flask bridge that exposes scrapling's
anti-bot-detection HTTP fetcher as a JSON API.

Port 3031  |  Endpoints: GET /health, POST /fetch
"""

from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlparse

from flask import Flask, jsonify, request
from flask_cors import CORS
from scrapling import Fetcher

from config import (
    BLOCKED_DNS_SUFFIXES,
    BLOCKED_HOSTNAME_SUFFIXES,
    BLOCKED_HOSTNAMES,
    DEFAULT_TIMEOUT,
    DEBUG,
    HOST,
    MAX_RESPONSE_SIZE,
    MAX_TIMEOUT,
    PORT,
)

# Pre-create fetcher instance at import time (avoids C-level issues with
# lazy import inside request handlers).
_fetcher = Fetcher()

app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
# SSRF protection  (mirrors scraper-service/src/ssrf.ts)
# ---------------------------------------------------------------------------


def _parse_ip(hostname: str) -> ipaddress._BaseAddress | None:
    """Try to parse *hostname* as an IPv4 or IPv6 address."""
    # Strip IPv6 brackets
    if hostname.startswith("[") and hostname.endswith("]"):
        hostname = hostname[1:-1]
    try:
        return ipaddress.ip_address(hostname)
    except ValueError:
        return None


def _is_private_ip(ip: ipaddress._BaseAddress) -> bool:
    """Return True for private / loopback / link-local / ULA / multicast."""
    # IPv4 private ranges
    ipv4_private = [
        ipaddress.IPv4Network("0.0.0.0/8"),
        ipaddress.IPv4Network("10.0.0.0/8"),
        ipaddress.IPv4Network("127.0.0.0/8"),
        ipaddress.IPv4Network("169.254.0.0/16"),
        ipaddress.IPv4Network("172.16.0.0/12"),
        ipaddress.IPv4Network("192.168.0.0/16"),
        ipaddress.IPv4Network("224.0.0.0/4"),
    ]
    for net in ipv4_private:
        if isinstance(ip, ipaddress.IPv4Address) and ip in net:
            return True

    # IPv6 checks
    if isinstance(ip, ipaddress.IPv6Address):
        addr_str = str(ip).lower()
        if addr_str in ("::1", "::"):
            return True
        if addr_str.startswith("fe80:"):
            return True
        if addr_str.startswith("fc") or addr_str.startswith("fd"):
            return True
        if addr_str.startswith("ff"):
            return True
        # IPv4-mapped IPv6  ::ffff:x.x.x.x
        if addr_str.startswith("::ffff:"):
            mapped = addr_str[7:]
            try:
                v4 = ipaddress.IPv4Address(mapped)
                return _is_private_ip(v4)
            except ValueError:
                pass

    return False


def is_safe_url(url: str) -> tuple[bool, str]:
    """Validate URL against SSRF vectors. Returns (safe, reason)."""
    try:
        parsed = urlparse(url)
    except Exception:
        return False, "invalid URL"

    if parsed.scheme not in ("http", "https"):
        return False, f"unsupported scheme: {parsed.scheme}"

    hostname = parsed.hostname
    if not hostname:
        return False, "missing hostname"

    hostname = hostname.lower().rstrip(".")

    # Block DNS-rebinding services
    for suffix in BLOCKED_DNS_SUFFIXES:
        if hostname.endswith(suffix):
            return False, f"blocked DNS suffix: {suffix}"

    # Block internal hostnames
    if hostname in BLOCKED_HOSTNAMES:
        return False, f"blocked hostname: {hostname}"
    for suffix in BLOCKED_HOSTNAME_SUFFIXES:
        if hostname.endswith(suffix):
            return False, f"blocked hostname suffix: {suffix}"

    # Block octal / hex / pure-decimal IP representations
    if re.match(r"^0[0-7]+(\.|$)", hostname):
        return False, "octal IP notation blocked"
    if re.match(r"^0x[0-9a-f]+(\.|$)", hostname, re.IGNORECASE):
        return False, "hex IP notation blocked"
    if re.match(r"^\d{8,}$", hostname):
        return False, "decimal IP notation blocked"

    # If hostname is a literal IP, check ranges
    ip = _parse_ip(hostname)
    if ip is not None:
        if _is_private_ip(ip):
            return False, "private/reserved IP address"

    # DNS resolution check for non-IP hostnames
    if ip is None:
        try:
            resolved = socket.getaddrinfo(hostname, None)
            for family, _, _, _, sockaddr in resolved:
                addr_str = sockaddr[0]
                try:
                    resolved_ip = ipaddress.ip_address(addr_str)
                    if _is_private_ip(resolved_ip):
                        return False, f"DNS resolves to private IP: {addr_str}"
                except ValueError:
                    continue
        except socket.gaierror:
            return False, "DNS resolution failed"

    return True, ""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "engine": "scrapling"})


@app.route("/fetch", methods=["POST"])
def fetch():
    # --- Parse body ---------------------------------------------------------
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "request body must be a JSON object"}), 400

    url = body.get("url")
    if not isinstance(url, str) or not url.strip():
        return jsonify({"error": "'url' is required and must be a non-empty string"}), 400

    url = url.strip()

    # Timeout validation
    timeout = body.get("timeout", DEFAULT_TIMEOUT)
    if not isinstance(timeout, (int, float)):
        return jsonify({"error": "'timeout' must be a number"}), 400
    timeout = int(timeout)
    if timeout < 1:
        timeout = 1
    if timeout > MAX_TIMEOUT:
        timeout = MAX_TIMEOUT

    # wait_selector (optional, not used by Fetcher but accepted for API compat)
    wait_selector = body.get("wait_selector")
    if wait_selector is not None and not isinstance(wait_selector, str):
        return jsonify({"error": "'wait_selector' must be a string"}), 400

    # Stealth flag (default True)
    stealth = body.get("stealth", True)
    if not isinstance(stealth, bool):
        return jsonify({"error": "'stealth' must be a boolean"}), 400

    # --- SSRF check ---------------------------------------------------------
    safe, reason = is_safe_url(url)
    if not safe:
        return jsonify({"error": f"SSRF blocked: {reason}"}), 403

    # --- Fetch via scrapling -------------------------------------------------
    try:
        kwargs = {
            "timeout": timeout,
            "stealthy_headers": stealth,
            "follow_redirects": True,
            "verify": True,
        }
        if stealth:
            kwargs["impersonate"] = "chrome"

        resp = _fetcher.get(url, **kwargs)

        html = str(resp.html_content)

        # Cap response size
        if len(html.encode("utf-8")) > MAX_RESPONSE_SIZE:
            html = html[:MAX_RESPONSE_SIZE]

        return jsonify({
            "html": html,
            "final_url": resp.url,
            "status_code": resp.status,
            "engine": "scrapling",
        })

    except Exception as exc:
        app.logger.error("scrapling fetch failed: %s", exc)
        return jsonify({"error": f"fetch failed: {str(exc)}"}), 502


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=DEBUG)
