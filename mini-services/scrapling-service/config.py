"""
Configuration for the Scrapling micro-service.
"""

import os

# Server
HOST = os.environ.get("SCRAPLING_HOST", "0.0.0.0")
PORT = int(os.environ.get("SCRAPLING_PORT", "3031"))
DEBUG = os.environ.get("SCRAPLING_DEBUG", "false").lower() == "true"

# Fetch defaults
DEFAULT_TIMEOUT = 30  # seconds
MAX_TIMEOUT = 120  # seconds
MAX_RESPONSE_SIZE = 10 * 1024 * 1024  # 10 MB

# SSRF: blocked DNS-rebinding domains
BLOCKED_DNS_SUFFIXES = (
    ".nip.io",
    ".sslip.io",
    ".dns.army",
    ".dnsdojo.net",
    ".xip.io",
    ".localtest.me",
    ".vcap.me",
    ".lvh.me",
    ".fuf.me",
    ".encr.app",
)

# SSRF: blocked internal hostnames
BLOCKED_HOSTNAMES = ("localhost", "localhost.localdomain")

# SSRF: blocked hostname suffixes
BLOCKED_HOSTNAME_SUFFIXES = (".local", ".internal")
