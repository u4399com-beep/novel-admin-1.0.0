#!/usr/bin/env python3
"""browser 策略渲染助手（scraper-service 专用）。

用法: python3 render.py <url> <timeoutMs> <userAgent>
输出: stdout 单行 JSON {status, html, error?}

仅做通用渲染取 HTML：
- 不注入任何登录态/Cookie，不处理任何验证码；
- 屏蔽图片/媒体/字体资源以降低带宽与耗时；
- SIGALRM 看门狗保证在超时后必然输出 JSON（绝不卡死上层策略链）。
"""
import json
import signal
import sys

MAX_HTML_BYTES = 8 * 1024 * 1024  # 与主服务 MAX_BYTES 一致

DEFAULT_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


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

    # 看门狗：timeout + 3s 余量后强制退出并以 JSON 报错，保证上层永不解析失败；
    # 余量必须小于上层 execFile 超时（timeout + 4s），否则会拖突破策略链 55s 预算
    def _watchdog(_signum, _frame):
        emit({"status": 0, "html": "", "error": f"render watchdog fired after {timeout_ms + 3000}ms"})
        sys.stdout.flush()
        sys.exit(0)

    try:
        signal.signal(signal.SIGALRM, _watchdog)
        signal.alarm(max(1, (timeout_ms + 3000) // 1000))
    except (ValueError, AttributeError, OSError):
        pass  # 非 Unix 环境无 SIGALRM，依赖上层 execFile 超时兜底

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            try:
                context = browser.new_context(
                    user_agent=ua,
                    locale="zh-CN",
                    viewport={"width": 1366, "height": 900},
                )
                page = context.new_page()
                page.on("dialog", lambda d: d.dismiss())

                def _route(route):
                    try:
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

                resp = page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
                try:
                    page.wait_for_timeout(400)  # 让首屏 XHR 有机会落 DOM
                except Exception:
                    pass
                html = page.content()
                status = resp.status if resp else 0
                if len(html.encode("utf-8", errors="ignore")) > MAX_HTML_BYTES:
                    html = html[: MAX_HTML_BYTES // 3]  # 防止超大 DOM 撑爆 stdout 管道
                emit({"status": status, "html": html})
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
