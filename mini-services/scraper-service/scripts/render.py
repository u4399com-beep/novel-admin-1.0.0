#!/usr/bin/env python3
"""browser 策略渲染助手（scraper-service 专用）。

用法: python3 render.py <url> <timeoutMs> <userAgent>
环境变量（可选，Task 23-a）: SCRAPER_COOKIES="k=v; k2=v2" 引擎 cookie 会话注入、SCRAPER_REFERER=<url> 来路
输出: stdout 单行 JSON {status, html, cookies?, error?}

仅做通用渲染取 HTML：
- 不注入任何登录态/凭证，只回放引擎 cookie 会话中目标站自己下发的公开访问 cookie，
  不处理任何验证码；
- 屏蔽图片/媒体/字体资源以降低带宽与耗时；
- 渲染期 SSRF 守卫：入口 URL 与页面发起的每个子请求/跳转都做内网地址校验
  （尽力而为：IP 字面量直接判定 + 主机名经 getaddrinfo 解析后判定，结果缓存）；
- SIGALRM 看门狗保证在超时后必然输出 JSON（绝不卡死上层策略链）。
"""
import ipaddress
import json
import os
import signal
import socket
import sys
from urllib.parse import urlparse

MAX_HTML_BYTES = 8 * 1024 * 1024  # 与主服务 MAX_BYTES 一致

# Task 10-d 渲染层 stealth 加固：context 级 init script（每次导航、页面脚本执行前注入）。
# 对齐 playwright-stealth/puppeteer-extra-stealth 最小有效子集：webdriver 摘除、window.chrome 伪造、
# permissions.query 修复、plugins/languages 伪造、WebGL vendor/renderer 伪装。
# 每段独立 try/catch：单项失败不影响其余项，更不影响渲染主流程。与 argv/stdin/输出协议无关。
STEALTH_INIT_SCRIPT = """
try {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
} catch (e) {}
try {
  if (!window.chrome) {
    window.chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
    };
  }
} catch (e) {}
try {
  const origQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (origQuery) {
    window.navigator.permissions.query = function (p) {
      if (p && p.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(p);
    };
  }
} catch (e) {}
try {
  Object.defineProperty(navigator, 'plugins', {
    get: function () {
      const arr = [
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
      ];
      arr.item = function (i) { return this[i] || null; };
      arr.namedItem = function (n) { for (const p of this) { if (p.name === n) return p; } return null; };
      arr.refresh = function () {};
      return arr;
    },
  });
} catch (e) {}
try {
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'] });
} catch (e) {}
try {
  const patchWebGL = (proto) => {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === 37445) return 'Google Inc. (Intel)';  // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'ANGLE (Intel, Mesa Intel(R) UHD Graphics (CML GT2), OpenGL 4.6)';  // UNMASKED_RENDERER_WEBGL
      return orig.call(this, param);
    };
  };
  if (window.WebGLRenderingContext) patchWebGL(WebGLRenderingContext.prototype);
  if (window.WebGL2RenderingContext) patchWebGL(WebGL2RenderingContext.prototype);
} catch (e) {}
"""

DEFAULT_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# SSRF 守卫：host -> 是否拦截（True=拦截）。渲染单次进程内缓存，避免每子请求做 DNS。
_GUARD_CACHE = {}
_GUARD_CACHE_MAX = 256

# 允许发出的请求协议：blob:/data:/about: 属于页面内部资源；file/ftp/ws 等可达本机或内网的一律拦截
_ALLOWED_SCHEMES = ("http", "https", "blob", "data", "about")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def _ip_is_local(ip) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _host_is_private(host: str) -> bool:
    """尽力判断 host 是否指向内网/本机。fail-closed：解析失败视为内网（渲染策略宁可不抓）。"""
    try:
        ip = ipaddress.ip_address(host)  # IP 字面量（::1、fe80::1、十进制整数不在此列，走 getaddrinfo）
    except ValueError:
        pass
    else:
        return _ip_is_local(ip)
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return True
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr.split("%")[0])  # 去掉 IPv6 zone id
        except ValueError:
            return True
        if _ip_is_local(ip):
            return True
    return False


def _guarded(host: str) -> bool:
    """True = 该 host 的请求应被拦截。结果缓存。"""
    if host in _GUARD_CACHE:
        return _GUARD_CACHE[host]
    result = _host_is_private(host)
    if len(_GUARD_CACHE) >= _GUARD_CACHE_MAX:
        _GUARD_CACHE.clear()
    _GUARD_CACHE[host] = result
    return result


def _url_blocked(req_url: str) -> bool:
    """渲染期请求（导航/子请求/跳转）统一入口：协议白名单 + 内网 host 校验。"""
    try:
        parsed = urlparse(req_url)
    except Exception:
        return True
    if (parsed.scheme or "").lower() not in _ALLOWED_SCHEMES:
        return True
    if parsed.scheme.lower() not in ("http", "https"):
        return False  # 内部资源协议，无网络可达性
    host = (parsed.hostname or "").lower()
    if not host:
        return True
    return _guarded(host)


def _env_cookies(url: str):
    """引擎 cookie 会话（SCRAPER_COOKIES="k=v; k2=v2"）→ Playwright add_cookies 入参；无则返回 None。"""
    raw = os.environ.get("SCRAPER_COOKIES", "").strip()
    if not raw:
        return None
    cookies = []
    for pair in raw.split(";"):
        pair = pair.strip()
        if "=" not in pair:
            continue
        name, _, value = pair.partition("=")
        name = name.strip()
        value = value.strip()
        if not name or len(name) > 128 or len(value) > 2048:
            continue
        cookies.append({"name": name, "value": value, "url": url, "expires": -1})
    return cookies or None


def main() -> int:
    url = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        timeout_ms = max(1000, int(sys.argv[2])) if len(sys.argv) > 2 else 20000
    except ValueError:
        timeout_ms = 20000
    ua = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_UA

    if not url:
        emit({"status": 0, "html": "", "error": "missing url"})
        return 0

    # 上层 execFile 超时兜底信号：收到 SIGTERM 也要输出结构化 JSON（否则上层拿到空 stdout 只能报桥接失败）
    def _sigterm(_signum, _frame):
        emit({"status": 0, "html": "", "error": "render terminated by SIGTERM"})
        os._exit(0)

    try:
        signal.signal(signal.SIGTERM, _sigterm)
    except (ValueError, OSError):
        pass  # 非主线程等场景无法注册，依赖上层 execFile 超时兜底

    # 看门狗：timeout + 3s 余量后强制退出并以 JSON 报错，保证上层永不解析失败；
    # 余量必须小于上层 execFile 超时（timeout + 4s），否则会拖突破策略链 55s 预算
    def _watchdog(_signum, _frame):
        emit({"status": 0, "html": "", "error": f"render watchdog fired after {timeout_ms + 3000}ms"})
        # os._exit 立即退出：playwright 清理路径（browser.close 等）在超时场景可能挂死，
        # 驱动子进程检测到 stdin 关闭后会自行回收浏览器，僵尸风险由该级联兜住
        os._exit(0)

    try:
        signal.signal(signal.SIGALRM, _watchdog)
        signal.alarm(max(1, (timeout_ms + 3000) // 1000))
    except (ValueError, AttributeError, OSError):
        pass  # 非 Unix 环境无 SIGALRM，依赖上层 execFile 超时兜底

    # 渲染入口 URL 的 SSRF 守卫（主服务已校验一次；这里覆盖渲染器内部的跳转与子请求）
    if _url_blocked(url):
        emit({"status": 0, "html": "", "error": f"ssrf-guard: target host blocked ({urlparse(url).hostname or 'unknown'})"})
        return 0

    try:
        from playwright.sync_api import sync_playwright

        # 站点级出口代理（规则配置，SCRAPER_PROXY=http://host:port 或 socks5://host:port）
        proxy_server = os.environ.get("SCRAPER_PROXY", "").strip() or None
        launch_kwargs = dict(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
            # Task 10-d stealth：不注入 Playwright 默认追加的 --enable-automation
            # （该开关会暴露 navigator.automation 相关 CDP 行为特征，真实用户浏览器不带它）
            ignore_default_args=["--enable-automation"],
        )
        if proxy_server:
            launch_kwargs["proxy"] = {"server": proxy_server}

        with sync_playwright() as p:
            browser = p.chromium.launch(**launch_kwargs)
            try:
                context = browser.new_context(
                    user_agent=ua,
                    locale="zh-CN",
                    viewport={"width": 1366, "height": 900},
                )
                # Task 10-d stealth 脚本注入：注册在 context 上（覆盖其后创建的所有页面），
                # 每次导航在页面脚本前执行；失败不阻塞渲染
                try:
                    context.add_init_script(STEALTH_INIT_SCRIPT)
                except Exception:
                    pass
                # 引擎 cookie 会话注入（仅目标站自己下发的 cookie；失败不阻塞渲染）
                cookies = _env_cookies(url)
                if cookies:
                    try:
                        context.add_cookies(cookies)
                    except Exception:
                        pass
                page = context.new_page()
                page.on("dialog", lambda d: d.dismiss())

                def _route(route):
                    try:
                        if _url_blocked(route.request.url):
                            route.abort()
                            return
                        if route.request.resource_type in ("image", "media", "font"):
                            route.abort()
                        else:
                            route.continue_()
                    except Exception:
                        pass

                try:
                    page.route("**/*", _route)
                except Exception:
                    pass

                referer = os.environ.get("SCRAPER_REFERER", "").strip() or None
                if referer:
                    resp = page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded", referer=referer)
                else:
                    resp = page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
                try:
                    page.wait_for_timeout(400)  # 让首屏 XHR 有机会落 DOM
                except Exception:
                    pass
                html = page.content()
                status = resp.status if resp else 0
                if len(html.encode("utf-8", errors="ignore")) > MAX_HTML_BYTES:
                    html = html[: MAX_HTML_BYTES // 3]  # 防止超大 DOM 撑爆 stdout 管道
                # 渲染会话 cookie 回传引擎 jar（仅精简字段，防 payload 过大）
                try:
                    back = [
                        {
                            "name": c.get("name"),
                            "value": c.get("value"),
                            "expires": c.get("expires", -1),
                            "secure": c.get("secure", False),
                        }
                        for c in context.cookies()[:50]
                    ]
                except Exception:
                    back = []
                emit({"status": status, "html": html, "cookies": back})
            finally:
                try:
                    browser.close()
                except Exception:
                    pass
    except Exception as e:  # noqa: BLE001 —— 任何异常都以 JSON 返回，不让上层解析失败
        emit({"status": 0, "html": "", "error": str(e)[:500]})
    finally:
        try:
            signal.alarm(0)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
