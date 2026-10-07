#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stealth-service —— iv8 / CloakBrowser 反检测抓取侧车（R101）。

定位：scraper-go 策略链的两个新策略 fetch-cloak / fetch-iv8 的后端执行器。
  - CloakBrowser（PyPI cloakbrowser）：C++ 源码级指纹改造的隐身 Chromium，
    Playwright 兼容 API。整页渲染，过 Cloudflare Turnstile / FingerprintJS 等指纹
    与行为检测。重（完整浏览器）但强。
  - iv8（PyPI iv8）：Python 原生 V8 + C++ 模拟 BOM/DOM/CSSOM 运行时。无头无渲染，
    加载 HTML 后执行站点脚本（补环境），轻量高并发，专治「JS 计算 cookie/参数」类
    反爬（如 acw_sc__v2 cookie 生成）。社区版无内置真实网络传输：页面脚本内的
    XHR/fetch 不会真实外发（符合合规约束——引擎侧真实请求仍走 scraper-go 策略链）。

接口（JSON in/out，业务失败一律 HTTP 200 + ok:false，引擎按 ok 判定）：
  GET  /health → {"ok":true,"service":"stealth-service","cloak":bool,"cloakBinary":bool,
                  "iv8":bool,"version":"1.0.0"}
  POST /cloak  {"url","timeoutMs":45000,"proxy":"","userAgent":""}
            → {"ok":true,"html","status","finalUrl","elapsedMs"}
  POST /iv8    {"url","timeoutMs":20000,"userAgent":"","advanceMs":3000}
            → {"ok":true,"html","cookies","finalUrl","elapsedMs"}

并发与线程安全：
  - ThreadingHTTPServer 每请求一线程；
  - cloakbrowser：浏览器实例按 proxy 配置缓存复用（launch 秒级开销），每请求独立
    page，用完即关；崩溃自动重建；
  - iv8：每请求独立 JSContext（每 Context 独占 V8 Isolate，执行期释放 GIL）。

部署（国内服务器）：python3 -m venv venv && venv/bin/pip install -r requirements.txt
  -i https://pypi.tuna.tsinghua.edu.cn/simple ；CloakBrowser 首次启动自动下载
  Chromium 二进制（约 100-150MB，走其官方 CDN）。任一库安装失败不影响另一能力
  （/health 对应能力=false，引擎策略自动跳过）。
"""

import json
import threading
import time
import urllib.request
import urllib.error
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.0"
LISTEN_PORT = 3031
DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
MAX_TIMEOUT_MS = 120_000
MAX_PROXY_BROWSERS = 4

# ---------- 能力探测（import 失败不崩，优雅降级） ----------

try:
    import cloakbrowser as _cloakbrowser
    HAS_CLOAK = True
except Exception as _e:  # pragma: no cover
    _cloakbrowser = None
    HAS_CLOAK = False
    print(f"[stealth-service] cloakbrowser 不可用: {_e}", flush=True)

try:
    import iv8 as _iv8
    HAS_IV8 = True
except Exception as _e:  # pragma: no cover
    _iv8 = None
    HAS_IV8 = False
    print(f"[stealth-service] iv8 不可用: {_e}", flush=True)


def _cloak_binary_ready() -> bool:
    """Chromium 二进制是否已就绪（download/ensure_binary 不在 /health 里做，避免阻塞）。"""
    if not HAS_CLOAK:
        return False
    try:
        info = _cloakbrowser.binary_info() or {}
        # R102 修复：cloakbrowser 0.5.12 实际字段是 binary_path/installed（R101 旧代码
        # 误写 path/exists → cloakBinary 恒 false → 引擎 fetch-cloak 探测恒不可用）；
        # 旧字段名保留兜底兼容
        return bool(info.get("binary_path") or info.get("installed")
                    or info.get("path") or info.get("exists"))
    except Exception:
        return False


# ---------- CloakBrowser 浏览器池（按 proxy 配置缓存复用） ----------

class CloakPool:
    """proxy 字符串 → 已启动浏览器实例。每请求独立 page。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._browsers = {}      # key -> browser
        self._broken = {}        # key -> 失败冷却截止时间戳

    def _launch(self, proxy: str, user_agent: str):
        kwargs = {"headless": True}
        if proxy:
            kwargs["proxy"] = proxy
        if user_agent:
            kwargs["args"] = [f"--user-agent={user_agent}"]
        return _cloakbrowser.launch(**kwargs)

    def acquire(self, proxy: str, user_agent: str):
        key = f"{proxy}|{user_agent}"
        with self._lock:
            b = self._browsers.get(key)
            if b is not None:
                try:
                    # 探活：cloaked browser 无轻量 ping，直接复用（page 级失败走 rebuild）
                    return b
                except Exception:
                    self._browsers.pop(key, None)
            now = time.time()
            if now < self._broken.get(key, 0):
                raise RuntimeError("cloakbrowser 启动失败冷却中（上次 launch 失败）")
            try:
                b = self._launch(proxy, user_agent)
            except Exception as e:
                self._broken[key] = now + 30.0
                raise RuntimeError(f"cloakbrowser launch 失败: {e}") from e
            # 容量上限：最旧实例淘汰
            if len(self._browsers) >= MAX_PROXY_BROWSERS:
                old_key = next(iter(self._browsers))
                try:
                    self._browsers.pop(old_key).close()
                except Exception:
                    pass
            self._browsers[key] = b
            return b

    def rebuild(self, proxy: str, user_agent: str):
        key = f"{proxy}|{user_agent}"
        with self._lock:
            try:
                old = self._browsers.pop(key, None)
                if old is not None:
                    old.close()
            except Exception:
                pass
            self._broken.pop(key, None)
        return self.acquire(proxy, user_agent)


_CLOAK_POOL = CloakPool()


def cloak_fetch(url: str, timeout_ms: int, proxy: str, user_agent: str) -> dict:
    """CloakBrowser 整页渲染。单次请求内 page 级异常重建浏览器重试一次。"""
    t0 = time.time()
    timeout_s = max(3.0, min(timeout_ms, MAX_TIMEOUT_MS) / 1000.0)
    last_err = None
    for attempt in (0, 1):
        browser = _CLOAK_POOL.acquire(proxy, user_agent) if attempt == 0 \
            else _CLOAK_POOL.rebuild(proxy, user_agent)
        page = None
        try:
            page = browser.new_page()
            resp = page.goto(url, timeout=int(timeout_s * 1000), wait_until="domcontentloaded")
            # 尽力等待网络空闲（反爬页常有二次跳转/JS 挑战），超时不算失败
            try:
                page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass
            html = page.content()
            status = 0
            final_url = url
            try:
                if resp is not None:
                    status = int(resp.status or 0)
                    final_url = resp.url or page.url
                else:
                    final_url = page.url
            except Exception:
                pass
            return {
                "ok": True, "html": html, "status": status, "finalUrl": final_url,
                "elapsedMs": int((time.time() - t0) * 1000),
            }
        except Exception as e:
            last_err = e
            if attempt == 1:
                break
        finally:
            if page is not None:
                try:
                    page.close()
                except Exception:
                    pass
    return {"ok": False, "error": f"cloak 渲染失败: {last_err}",
            "elapsedMs": int((time.time() - t0) * 1000)}


# ---------- iv8 补环境执行 ----------

_SSL_CTX = ssl.create_default_context()


def _http_get(url: str, timeout_s: float, user_agent: str):
    """侧车侧真实 HTTP（仅取初始 HTML 供 page.load 解析；后续真实请求仍由引擎发起）。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": user_agent or DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=timeout_s, context=_SSL_CTX) as resp:
        body = resp.read()
        return resp.status, resp.geturl(), body


def iv8_fetch(url: str, timeout_ms: int, user_agent: str, advance_ms: int) -> dict:
    """iv8 补环境：取初始 HTML → page.load（脚本执行）→ 推进事件循环 →
    返回执行后 DOM 与 document.cookie（供引擎带 cookie 复抓或直接用渲染结果）。"""
    t0 = time.time()
    timeout_s = max(3.0, min(timeout_ms, MAX_TIMEOUT_MS) / 1000.0)
    try:
        status, final_url, body = _http_get(url, timeout_s, user_agent)
    except urllib.error.HTTPError as e:
        # 403/503 挑战页同样值得进 iv8 跑（正文可能就是 JS 挑战脚本）
        try:
            body = e.read()
            status, final_url = int(e.code or 0), url
        except Exception:
            return {"ok": False, "error": f"iv8 取源失败: {e}",
                    "elapsedMs": int((time.time() - t0) * 1000)}
    except Exception as e:
        return {"ok": False, "error": f"iv8 取源失败: {e}",
                "elapsedMs": int((time.time() - t0) * 1000)}
    try:
        html_text = body.decode("utf-8", errors="replace")
    except Exception:
        html_text = ""
    if not html_text.strip():
        return {"ok": False, "error": "iv8 取源失败: 空响应",
                "elapsedMs": int((time.time() - t0) * 1000)}
    try:
        advance_ms = int(advance_ms or 3000)
        with _iv8.JSContext(time_mode="logical") as ctx:
            load_payload = json.dumps({"baseURL": final_url, "html": html_text}, ensure_ascii=False)
            # JSON 字面量内嵌安全（ensure_ascii + json 转义，无 </script> 注入面：
            # payload 作为 JS 字符串字面量参数而非 HTML 文档一部分）
            ctx.eval(f"window.__iv8__.page.load({load_payload});")
            try:
                ctx.eval(f"window.__iv8__.eventLoop.advance({int(advance_ms)});")
            except Exception:
                pass  # 事件循环推进失败不致命（部分脚本同步完成）
            out_html = ctx.eval("document.documentElement.outerHTML") or ""
            cookies = ctx.eval("document.cookie") or ""
            return {
                "ok": True, "html": out_html, "cookies": cookies,
                "finalUrl": final_url, "status": status,
                "elapsedMs": int((time.time() - t0) * 1000),
            }
    except Exception as e:
        return {"ok": False, "error": f"iv8 执行失败: {e}",
                "elapsedMs": int((time.time() - t0) * 1000)}


# ---------- HTTP 服务 ----------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 统一时间戳日志
        print(f"[stealth-service] {self.address_string()} {fmt % args}", flush=True)

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health"):
            self._json(200, {
                "ok": True, "service": "stealth-service", "version": VERSION,
                "cloak": HAS_CLOAK, "cloakBinary": _cloak_binary_ready(),
                "iv8": HAS_IV8,
            })
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            self._json(200, {"ok": False, "error": f"请求体解析失败: {e}"})
            return
        url = str(req.get("url") or "").strip()
        timeout_ms = int(req.get("timeoutMs") or 45000)
        proxy = str(req.get("proxy") or "").strip()
        user_agent = str(req.get("userAgent") or "").strip()
        if not url or not (url.startswith("http://") or url.startswith("https://")):
            self._json(200, {"ok": False, "error": "url 必须为 http(s) 绝对地址"})
            return
        if self.path.rstrip("/") == "/cloak":
            if not HAS_CLOAK:
                self._json(200, {"ok": False, "error": "cloakbrowser 未安装"})
                return
            self._json(200, cloak_fetch(url, timeout_ms, proxy, user_agent))
            return
        if self.path.rstrip("/") == "/iv8":
            if not HAS_IV8:
                self._json(200, {"ok": False, "error": "iv8 未安装"})
                return
            self._json(200, iv8_fetch(url, timeout_ms, user_agent,
                                      int(req.get("advanceMs") or 3000)))
            return
        self._json(404, {"ok": False, "error": "not found"})


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler)
    srv.daemon_threads = True
    print(f"[stealth-service] v{VERSION} listening on http://127.0.0.1:{LISTEN_PORT} "
          f"(cloak={HAS_CLOAK} cloakBinary={_cloak_binary_ready()} iv8={HAS_IV8})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
