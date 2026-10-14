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
            → {"ok":true,"html","status","finalUrl","elapsedMs"[,"warnings"]}
  POST /iv8    {"url","timeoutMs":20000,"userAgent":"","advanceMs":3000}
            → {"ok":true,"html","cookies","finalUrl","elapsedMs"[,"warnings"]}
  （R116-2：warnings 为可选新增字段——单页 HTML >8MB 截断时给出说明，其余响应不变）
  （R120：/cloak 新增可选 waitSelector/waitSelectorTimeoutMs——JS 慢渲染站的「关键
  选择器」等待。语义：domcontentloaded 后优先 wait_for_selector（命中即提前返回，
  省去整段 networkidle）；未命中再走 networkidle+挑战轮询，收尾补一次短等待；全程
  超时不失败（页面照常返回），响应附 waitSelectorFound 布尔供调用方判定空壳。）

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
import os
import queue
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
# R110：4→2（沙箱实测每 cloak 实例 ~1 棵 node driver + chrome 树，60-100 线程/棵；
# threads-max ~925 的环境里 4 实例 + rebuild 漂移足以把线程配额打穿）
# R111：2→3——R110 实证 2 实例在多站点并发 cloak 请求下频繁淘汰/重建（每章一次
# launch 秒级开销），改成 3 折中：并发站点 ≤3 时零重建，线程预算仍受控
#（3×~100 线程 + janitor 硬上限）。淘汰改为进程树补刀（_kill_tree），杜绝 close() 不
# 彻底导致的漂移累积。
MAX_PROXY_BROWSERS = 3
# R110：直接子进程上限（node run-driver 为主）。browser.close() 偶发不杀 driver →
# rebuild 漂移累积；janitor 每 30s 对超额最老驱动补刀（杀驱动只会使其归属浏览器
# 下次请求走 rebuild 路径自愈，不产生用户可见错误）
# R111：上限 4→3，且 janitor 修复两处漏配：①driver 进程 comm 是 node/MainThread
# 而非 "driver"，旧过滤永不命中（泄漏实证：1 小时堆积 17 driver + 68 chrome）；
# ②chrome 树是 driver 的孙进程，旧实现只扫直接子进程看不到。改为全进程表 ppid 树扫描。
MAX_CHILD_DRIVERS = 3

# ---------- R116-2：内存自保参数 ----------
# 沙箱 4GB 无 swap 实证 OOM：chrome 进程树膨胀 → 内核 OOM killer 击杀本服务 python
# （exit 137）→ run.sh 2s 重启 → crash-loop。三道源头约束：
MEM_GUARD_MIN_AVAILABLE_MB = 500    # janitor 内存水位护栏阈值（MemAvailable 低于即杀最老驱动树）
MAX_HTML_BYTES = 8 * 1024 * 1024    # 单页 HTML 上限（cloak/iv8 超限截断 + warnings 可选字段）
# chromium 降内存启动参数（追加到每次 launch；cloakbrowser launch(args=...) 会与默认
# 隐身参数合并，见其 browser.py）。注意 argv 列表里的 --js-flags 不能带 shell 引号
# （引号是 shell 语法，进程参数中会被当作值的一部分导致 V8 flag 解析失败）。
# iv8 为 Python 原生 V8 库（非浏览器二进制），无 chrome 启动参数位。
CHROME_LOW_MEM_ARGS = (
    "--renderer-process-limit=2",            # 渲染进程上限（默认随站点/iframe 弹性扩张）
    "--js-flags=--max-old-space-size=128",   # 每个 renderer 的 V8 老生代堆上限 128MB
    "--disable-dev-shm-usage",               # /dev/shm 小容量沙箱防崩（改用 /tmp）
)

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
    """Chromium 二进制是否已就绪（download/ensure_binary 不在 /health 里做，避免阻塞）。
    R119 修复：binary_info() 的 binary_path 是「期望路径」而非「已存在路径」——二进制
    缺失时它依然返回非空路径且 installed=false，旧逻辑 bool(binary_path or ...) 恒 true
    → /health 误报 cloakBinary=true（沙箱重置丢二进制后误报一整轮，健康检查全灭但
    health 全绿，排查被带偏）。现以 installed 字段为准，旧字段名兜底时必须
    os.path.isfile 权威复核。"""
    if not HAS_CLOAK:
        return False
    try:
        info = _cloakbrowser.binary_info() or {}
        if info.get("installed"):
            return True
        # 旧字段名兜底（R102 兼容路径）：binary_path/path/exists 均须以文件实际存在为准
        p = info.get("binary_path") or info.get("path") or info.get("exists")
        return bool(p) and os.path.isfile(p)
    except Exception:
        return False


# ---------- R119：CloakBrowser 子进程隔离渲染（线程亲和 + asyncio loop 双陷阱根修） ----------
# playwright sync API 两重死结（2026-10-14 实证）：
#   ①线程亲和：sync browser（greenlet）绑定创建线程，跨线程使用必炸
#     Cannot switch to a different thread / TargetClosedError；
#   ②loop 永驻：sync_playwright().start() 的 event loop「pumps events until the
#     end of times」——同线程第二次 launch 时 get_running_loop() 命中永驻 loop →
#     「Sync API inside the asyncio loop」。即 CloakPool 的跨请求/跨线程池复用
#     架构在本进程内根本不可行（旧架构靠 page 失败→rebuild 慢自愈，每请求多付
#     一次 launch 成本且并发下随机炸三种错误形态）。
# 根修：每次 /cloak 渲染 spawn 独立解释器子进程（multiprocessing spawn——绕开
# fork-safety 与父进程线程状态复制），子进程内首启即唯一一次 launch（陷阱不触发），
# 渲染完退出，chrome 树随进程消失——泄漏/内存护栏/OOM 链路天然消解。
# 跨请求语义保留：①过盾 cookie 由主进程按 host 记忆并注入子进程（R110 快通道
# 语义），②networkidle 上限按 host 成功渲染次数自适应（R108 语义）。

_CLOAK_COOKIE_MEM: dict = {}   # host -> 最近一次过盾 cookies（page.context.cookies 形态，可直接 add_cookies）
_CLOAK_SERVED: dict = {}       # host -> 累计成功渲染次数（networkidle 自适应依据）
_MEM_LOCK = threading.Lock()   # R120：两份 host 记忆的并发保护（cloak_fetch 在请求线程并发读写）

# ---------- R120：cloak 会话记忆落盘（遗留③，同 backend cookie jar 先例） ----------
# 旧况：_CLOAK_COOKIE_MEM/_CLOAK_SERVED 纯内存——侧车重启（run.sh 崩溃自愈/watchdog
# 兜底/沙箱重置）即「失忆」：过盾 cookie 全丢 → 每个站点首访重新扛挑战（8s networkidle
# + 20s 挑战轮询整段重付），_CLOAK_SERVED 清零还把所有站点打回首次慢等待档。
# 现以脏标记 + 20s 周期线程原子落盘（tmp+rename），启动时恢复（过期 cookie 剔除）。
_MEM_PATH = os.environ.get("STEALTH_MEM_PATH") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "cloak-mem.json")
_MEM_SAVE_INTERVAL_S = 20.0
_MEM_DIRTY = threading.Event()


def _cookie_alive(c: dict) -> bool:
    """cookie 是否仍有效（expires=-1 会话 cookie 保留——过期与否则由站点重新挑战兜底）。"""
    try:
        exp = float(c.get("expires", -1))
        return exp == -1 or exp > time.time()
    except Exception:
        return True


def _mem_load() -> None:
    """启动恢复：读落盘文件，剔除已过期 cookie 后并入内存记忆。任何异常静默跳过
    （落盘是加速路径不是正确性依赖——丢了无非重新过一次挑战）。"""
    try:
        with open(_MEM_PATH, "rb") as f:
            data = json.loads(f.read().decode("utf-8"))
        cookies = data.get("cookies") or {}
        served = data.get("served") or {}
        with _MEM_LOCK:
            for host, arr in cookies.items():
                if not isinstance(arr, list):
                    continue
                alive = [c for c in arr if isinstance(c, dict) and _cookie_alive(c)]
                if alive:
                    _CLOAK_COOKIE_MEM[host] = alive
            for host, n in served.items():
                try:
                    _CLOAK_SERVED[host] = max(0, int(n))
                except Exception:
                    continue
        print(f"[stealth-service] 会话记忆恢复：cookie host={len(_CLOAK_COOKIE_MEM)} "
              f"served host={len(_CLOAK_SERVED)}（{_MEM_PATH}）", flush=True)
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[stealth-service] 会话记忆恢复失败（忽略）: {e}", flush=True)


def _mem_save() -> None:
    """原子落盘（tmp + os.replace；快照在锁内取、写盘在锁外做，不阻塞渲染请求）。"""
    with _MEM_LOCK:
        snap_cookies = {h: list(v) for h, v in _CLOAK_COOKIE_MEM.items()}
        snap_served = dict(_CLOAK_SERVED)
    tmp = _MEM_PATH + ".tmp"
    os.makedirs(os.path.dirname(_MEM_PATH), exist_ok=True)
    payload = json.dumps({"version": 1, "savedAt": int(time.time()),
                          "cookies": snap_cookies, "served": snap_served},
                         ensure_ascii=False)
    with open(tmp, "wb") as f:
        f.write(payload.encode("utf-8"))
    os.replace(tmp, _MEM_PATH)


def _mem_save_loop() -> None:
    """脏标记 + 周期落盘（零常态 I/O：没有新渲染就不写盘）。"""
    while True:
        time.sleep(_MEM_SAVE_INTERVAL_S)
        if _MEM_DIRTY.is_set():
            _MEM_DIRTY.clear()
            try:
                _mem_save()
            except Exception as e:
                print(f"[stealth-service] 会话记忆落盘失败（下轮重试）: {e}", flush=True)


def _cloak_url_host(url: str) -> str:
    try:
        from urllib.parse import urlparse
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return url[:64]


def _looks_like_challenge(html: str) -> bool:
    """挑战页特征判定（对齐引擎 serverChallenge 语义的轻量版）：
    小页面 + 挑战平台脚本/常见盾特征词。大页面（>100KB）视为真实内容不再轮询。"""
    if not html or len(html) > 100_000:
        return False
    low = html.lower()
    return ("challenge-platform" in low or "/cdn-cgi/challenge" in low
            or "cf-chl" in low or "jsd/main.js" in low
            or ("just a moment" in low) or ("checking your browser" in low))


def _cloak_launch(proxy: str, user_agent: str):
    """子进程内启动 cloakbrowser（本进程唯一一次 launch）。R116-2 降内存参数保留。"""
    import cloakbrowser as _cb
    kwargs = {"headless": True, "timeout": 90_000, "args": list(CHROME_LOW_MEM_ARGS)}
    if proxy:
        kwargs["proxy"] = proxy
    if user_agent:
        kwargs["args"] = [f"--user-agent={user_agent}"] + kwargs["args"]
    return _cb.launch(**kwargs)


def _cloak_child_main(url: str, timeout_s: float, proxy: str, user_agent: str,
                      networkidle_ms: int, initial_cookies: list, out_q,
                      wait_selector: str = "", ws_timeout_ms: int = 15000) -> None:
    """子进程入口：launch → page 生命周期 → 结果入队 → 进程自然退出。
    R110 cookie 回传/R111 context 级清理/R116-2 大页护栏语义全保留。
    R120 waitSelector（遗留①）：JS 慢渲染站的「关键选择器」等待——
      ①goto 后若页面非挑战壳，先 wait_for_selector（命中即提前收尾，省整段
        networkidle—— cloak 首访 8s 档的最常见浪费）；
      ②未命中再走 networkidle+挑战轮询既有路径，收尾补一次短等待（挑战放行后
        SPA 才开始拉数据的形态：rank 列表在 networkidle 后 2-10s 才渲染）；
      ③全程超时不失败（页面照常返回），waitSelectorFound 布尔随响应透出供调用方
        判定空壳——「200 空壳抢跑」从静默假成功变为可观测、可被链层继续复核。"""
    t0 = time.time()
    ws = (wait_selector or "").strip()
    ws_ms = max(2000, min(int(ws_timeout_ms or 15000), 30000))
    try:
        browser = _cloak_launch(proxy, user_agent)
        page = browser.new_page()
        if initial_cookies:
            try:
                page.context.add_cookies(initial_cookies)
            except Exception:
                pass
        resp = page.goto(url, timeout=int(timeout_s * 1000), wait_until="domcontentloaded")
        ws_found = False
        # R120①：关键选择器优先等待（挑战壳不用等——选择器永远不会出现在盾页上）
        if ws and not _looks_like_challenge(page.content()):
            try:
                page.wait_for_selector(ws, timeout=ws_ms, state="attached")
                ws_found = True
            except Exception:
                ws_found = False
        if not ws_found:
            try:
                page.wait_for_load_state("networkidle", timeout=networkidle_ms)
            except Exception:
                pass  # 超时不算失败（与原语义一致）
        html = page.content()
        # R119：挑战页完成等待——CF 等盾页 domcontentloaded+networkidle 常早于挑战
        # JS 跑完（初始 403 即返回），旧路径此时取 content 只拿到挑战页壳。检测到
        # 挑战特征后轮询等待其消失（页面自动刷新跳转/放行），上限 20s。
        for _ in range(10):
            if not _looks_like_challenge(html) or len(html) > 100_000:
                break
            try:
                page.wait_for_timeout(2000)
                html = page.content()
            except Exception:
                break
        # R120③：收尾补等待——挑战轮询放行/SPA 拉数据后再给关键选择器一次机会
        #（短窗 2.5s；仍未命中不强等，html 照常返回 + waitSelectorFound=false）
        if ws and not ws_found and not _looks_like_challenge(html):
            try:
                page.wait_for_selector(ws, timeout=2500, state="attached")
                ws_found = True
            except Exception:
                pass
        if ws_found:
            page.wait_for_timeout(300)  # 命中后短暂沉降：等选择器同批的相邻节点写完 DOM
            html = page.content()
        html_warnings = []
        if ws and not ws_found:
            html_warnings.append(
                f"waitSelector 未命中（等待后关键选择器仍未出现：JS 慢渲染/选择器失效/空壳）: {ws}")
        if len(html) > MAX_HTML_BYTES:
            html_warnings.append(
                f"HTML 超过 {MAX_HTML_BYTES // (1024 * 1024)}MB 已截断（防异常大页滞留内存）")
            html = html[:MAX_HTML_BYTES]
        status, final_url = 0, url
        try:
            if resp is not None:
                status = int(resp.status or 0)
                final_url = resp.url or page.url
            else:
                final_url = page.url
        except Exception:
            pass
        cookies_out = []
        try:
            for c in (page.context.cookies(final_url) or []):
                cookies_out.append({
                    "name": c.get("name") or "", "value": c.get("value") or "",
                    "expires": c.get("expires") or -1, "secure": bool(c.get("secure")),
                })
        except Exception:
            pass
        try:  # R111：先关 context 再关 page，防 context 堆积
            page.context.close()
        except Exception:
            pass
        try:
            page.close()
        except Exception:
            pass
        out_q.put({"ok": True, "html": html, "status": status, "finalUrl": final_url,
                   "cookies": cookies_out, "elapsedMs": int((time.time() - t0) * 1000),
                   **({"waitSelectorFound": bool(ws_found)} if ws else {}),
                   **({"warnings": html_warnings} if html_warnings else {})})
    except Exception as e:
        try:
            out_q.put({"ok": False, "error": f"cloak 渲染失败: {e}",
                       "elapsedMs": int((time.time() - t0) * 1000)})
        except Exception:
            pass


def _kill_proc_tree(pid: int) -> None:
    """击杀子进程及其完整 chrome 树（防 terminate 后 chrome 孤儿挂 PPID 1）。"""
    import signal as _signal
    subtree = _subtree_pids(pid, snapshot=_proc_snapshot())
    for p in subtree:
        try:
            import os as _os
            _os.kill(p, _signal.SIGKILL)
        except Exception:
            pass


def _proc_snapshot():
    """R111：全进程表快照 {pid: (ppid, comm, starttime)}（读 /proc，无外部依赖）。"""
    import os as _os
    out = {}
    for pid in _os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat", "rb") as f:
                stat = f.read().decode("utf-8", "replace")
            i = stat.index("(")
            comm = stat[i + 1:stat.rindex(")")]
            after = stat[stat.rindex(")") + 2:].split()
            out[int(pid)] = (int(after[1]), comm, int(after[19]))
        except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
            continue
        except Exception:
            continue
    return out


def _subtree_pids(root_pid, snapshot=None, exclude_pids=None):
    """R111：root_pid 的完整后代进程集合（含自身；BFS ppid 树扫描，子孙任意深度）。"""
    if snapshot is None:
        snapshot = _proc_snapshot()
    kids = {}
    for pid, (ppid, _comm, _st) in snapshot.items():
        kids.setdefault(ppid, []).append(pid)
    seen = set()
    stack = [root_pid]
    exclude = exclude_pids or set()
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        stack.extend(kids.get(p, ()))
    return seen - exclude


def _kill_tree(pids, reason=""):
    """R111：SIGKILL 进程集合（异常逐个吞——best-effort 清理，不产生用户可见错误）。"""
    import os as _os
    import signal as _signal
    for p in pids:
        try:
            _os.kill(p, _signal.SIGKILL)
        except Exception:
            pass
    if pids:
        print(f"[stealth-service] kill_tree({reason})：击杀 {len(pids)} 个进程", flush=True)


def _proc_cmdline(pid):
    """R116-2：读 /proc/{pid}/cmdline（NUL → 空格），失败返回空串。"""
    import os as _os
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().decode("utf-8", "replace").replace("\x00", " ")
    except Exception:
        return ""


def _is_browser_service(pid, comm, cmdline=""):
    """R116-2：判定是否浏览器服务进程（playwright driver / chrome 系）。

    comm 判据不可靠的实证（R116-2）：playwright driver 的 comm 既不是 'driver' 也不是
    'node'，而是 'MainThread'（node 运行时改写主线程名）——R111 的 'node' in comm 对
    真实 driver 永不命中，实测 26 分钟泄漏 17 个 driver（每次 launch 一棵）。
    node 系 comm（node/MainThread）一律以 cmdline 权威复核：driver 特征 = cmdline 含
    'playwright' 或 'run-driver'；chrome 系仍按 comm 快路径。"""
    comm = (comm or "").lower()
    if "chrome" in comm or "chromium" in comm or "headless" in comm:
        return True
    if "node" in comm or "mainthread" in comm:
        cmd = cmdline or _proc_cmdline(pid)
        return ("playwright" in cmd) or ("run-driver" in cmd)
    return False


def _browser_service_pids(snapshot=None):
    """R111：本 python 的全部浏览器服务进程（任意深度后代中 node/chrome 系）。

    R116-2 识别修正：node 系 comm（含实测 'MainThread'）走 cmdline 复核（见
    _is_browser_service）；chrome 系按 comm。返回 [(pid, comm, starttime)]。"""
    import os as _os
    me = _os.getpid()
    snap = snapshot or _proc_snapshot()
    descendants = _subtree_pids(me, snapshot=snap, exclude_pids={me})
    out = []
    for p in descendants:
        info = snap.get(p)
        if info is None:
            continue
        if _is_browser_service(p, info[1]):
            out.append((p, info[1], info[2]))
    return out


def _browser_tree_roots(snapshot=None):
    """R116-2：本 python 后代中的浏览器「驱动树根」列表（starttime 升序 = 最老在前）。

    树根 = 浏览器服务进程中、父进程不是浏览器服务进程者。典型形态：1 个 driver 根 +
    其下挂 N 个 chrome 子进程 = 1 棵树。旧 janitor 把每个 chrome 子进程各计 1 个实例：
    单实例 6-11 进程恒超 MAX_CHILD_DRIVERS=3 → 每 30s 谋杀活浏览器 chrome 树
    （/tmp/stealth.log 累计 612 次），launch/kill 风暴即内存尖峰与每请求重付 launch
    开销的源头；同时 driver 因 comm 判据失效全部漏判泄漏。改按树根计数后上限 3 = 3 棵
    完整驱动树（与池容量 MAX_PROXY_BROWSERS=3 对齐），泄漏 driver 亦能被识别补刀。"""
    snap = snapshot or _proc_snapshot()
    svc = {}
    for p, comm, st in _browser_service_pids(snap):
        svc[p] = (snap[p][0], comm, st)  # (ppid, comm, starttime)
    svc_pids = set(svc.keys())
    roots = []
    for p, (ppid, comm, st) in svc.items():
        if ppid in svc_pids:
            continue  # 父进程也是浏览器服务进程（chrome 挂在 driver 下）→ 非根
        if "crashpad" in comm.lower():
            continue  # crashpad 守护被收养时不作树根候选（体量小，忽略）
        roots.append((p, comm, st))
    roots.sort(key=lambda r: r[2])
    return roots



def _janitor_kill_trees(roots, log_prefix):
    """R116-2：击杀一批驱动树根及其完整子树（R111 树补刀语义抽公共实现）。

    先对快照做全子树收集再统一 SIGKILL（杀 driver 不杀其 chrome 树会留孤儿）。"""
    import os as _os
    import signal as _signal
    snap = _proc_snapshot()
    all_pids = set()
    for pid, _comm, _st in roots:
        all_pids |= _subtree_pids(pid, snapshot=snap)
    for pid, comm, _st in roots:
        try:
            _os.kill(pid, _signal.SIGKILL)
            print(f"[stealth-service] {log_prefix} {pid} ({comm})", flush=True)
        except Exception:
            pass
    for p in all_pids - {x[0] for x in roots}:
        try:
            _os.kill(p, _signal.SIGKILL)
        except Exception:
            pass


def _mem_available_mb():
    """R116-2：读 /proc/meminfo 的 MemAvailable（kB → MB）；读取失败返回 None。"""
    try:
        with open("/proc/meminfo", "rb") as f:
            for line in f:
                if line.startswith(b"MemAvailable:"):
                    return int(line.split()[1]) / 1024.0
    except Exception:
        pass
    return None


def _memory_guard():
    """R116-2：内存水位护栏——MemAvailable < 阈值时按最老优先击杀浏览器驱动树。

    OOM 实证（R116 主代理）：4GB 无 swap 沙箱里 chrome 进程树膨胀 → 内核 OOM killer
    击杀本服务 python（exit 137）→ run.sh 2s 重启 → crash-loop，并顺带拖垮 backend-go。
    护栏语义：只杀到水位恢复或只剩 1 棵驱动树为止（绝不全杀，保留最后一棵给在途
    请求与自愈路径）；被杀池条目下次请求走既有 rebuild 路径重建。"""
    avail = _mem_available_mb()
    if avail is None or avail >= MEM_GUARD_MIN_AVAILABLE_MB:
        return
    # 迭代上限硬护栏：正常情况下击杀后进程消失/水位回升即退出；防进程不可杀
    # （D-state 等病理形态）时护栏循环自身活锁（每次巡检至多杀 8 棵，池容量仅 3）
    for _round in range(8):
        avail = _mem_available_mb()
        if avail is None or avail >= MEM_GUARD_MIN_AVAILABLE_MB:
            break
        roots = _browser_tree_roots()
        if len(roots) <= 1:
            break  # 保留最少 1 棵，不全杀
        victim = roots[0]  # 已按 starttime 升序，最老在前
        _janitor_kill_trees([victim], "janitor 内存护栏击杀最老浏览器驱动树")
        print(f"[janitor] 内存护栏：MemAvailable {avail:.0f}MB，"
              f"击杀最老浏览器驱动树 pid={victim[0]}", flush=True)
        time.sleep(2.0)  # 给内核回收时间再复测水位


def _driver_janitor():
    """R110/R111：后台每 30s 巡检后代进程树，超额最老驱动树补刀 + 内存水位护栏。

    R116-2 三处修正：
      ①识别：driver comm 实测为 'MainThread'（node 改写主线程名），R111 的
        'node' in comm 对真实 driver 永不命中 → driver 泄漏（实证 26 分钟 17 个）；
        现 node 系 comm 走 cmdline 复核（_is_browser_service）。
      ②计数口径：按「驱动树根」而非进程个体——旧口径把单实例 6-11 个 chrome 子进程
        各计 1 实例，健康单池即恒超上限 → 每 30s 谋杀活浏览器 chrome 树（累计 612 次），
        launch/kill 风暴即内存尖峰与每请求重付 launch 秒级开销的源头。
      ③新增内存水位护栏（第②步，先超额补刀后护栏）。

    杀掉后其归属池条目在下次请求时按既有 rebuild 路径重建，服务自愈。"""
    while True:
        time.sleep(30)
        # ① 超额补刀（R110/R111 原有机制，R116-2 修正识别与计数口径：树根制）
        try:
            roots = _browser_tree_roots()
            if len(roots) > MAX_CHILD_DRIVERS:
                excess = roots[:len(roots) - MAX_CHILD_DRIVERS]  # 最老在前
                _janitor_kill_trees(excess, "janitor 击杀超额浏览器驱动树")
        except Exception:
            pass
        # ② 内存水位护栏（R116-2 新增：全机优先，牺牲多余浏览器树换 OOM 豁免）
        try:
            _memory_guard()
        except Exception:
            pass


def cloak_fetch(url: str, timeout_ms: int, proxy: str, user_agent: str,
                wait_selector: str = "", ws_timeout_ms: int = 15000) -> dict:
    """CloakBrowser 整页渲染（R119：子进程隔离——spawn 独立解释器渲染，主进程只
    等 Queue 结果并兜底超时杀树）。跨请求 cookie 会话（R110）与 networkidle 自适应
    （R108）在主进程按 host 记忆，随参数注入子进程。
    R120：waitSelector 透传子进程（关键选择器等待，超时不失败）；host 记忆读写加锁
    （ThreadingHTTPServer 并发请求线程）+ 落盘脏标记（重启不失忆）。"""
    import multiprocessing as _mp
    t0 = time.time()
    timeout_s = max(3.0, min(timeout_ms, MAX_TIMEOUT_MS) / 1000.0)
    host = _cloak_url_host(url)
    ws = (wait_selector or "").strip()
    with _MEM_LOCK:
        nid_ms = 8000 if _CLOAK_SERVED.get(host, 0) == 0 else 2500
        initial_cookies = list(_CLOAK_COOKIE_MEM.get(host) or [])
    # 预算：page timeout + launch(≤90s，实测冷启 1-25s) + 挑战轮询 20s + ws 等待 30s 上限 + import 余量
    budget = timeout_s + 150.0
    proc, out = None, None
    try:
        ctx = _mp.get_context("spawn")
        out_q = ctx.Queue()
        proc = ctx.Process(target=_cloak_child_main,
                           args=(url, timeout_s, proxy, user_agent, nid_ms,
                                 initial_cookies, out_q, ws, ws_timeout_ms),
                           daemon=True)
        proc.start()
        try:
            out = out_q.get(timeout=budget)
        except Exception:
            out = None
    except Exception as e:
        return {"ok": False, "error": f"cloak 子进程启动失败: {e}",
                "elapsedMs": int((time.time() - t0) * 1000)}
    finally:
        if proc is not None and proc.is_alive():
            try:
                _kill_proc_tree(proc.pid)
            except Exception:
                pass
            proc.join(3)
            if proc.is_alive():
                try:
                    proc.kill()
                except Exception:
                    pass
                proc.join(3)
    if out is None:
        return {"ok": False, "error": f"cloak 渲染超时（预算 {int(budget)}s）",
                "elapsedMs": int((time.time() - t0) * 1000)}
    if out.get("ok"):
        with _MEM_LOCK:
            _CLOAK_SERVED[host] = _CLOAK_SERVED.get(host, 0) + 1
            if out.get("cookies"):
                _CLOAK_COOKIE_MEM[host] = out["cookies"]  # R110 快通道：过盾 cookie 供下次注入
            else:
                _CLOAK_COOKIE_MEM.pop(host, None)
        _MEM_DIRTY.set()  # R120：20s 周期线程异步落盘
    if out.get("warnings"):
        for w in out["warnings"]:
            print(f"[stealth-service] cloak 大页护栏：{w} url={url}", flush=True)
    return out


# ---------- iv8 补环境执行 ----------

_SSL_CTX = ssl.create_default_context()


def _http_get(url: str, timeout_s: float, user_agent: str):
    """侧车侧真实 HTTP（仅取初始 HTML 供 page.load 解析；后续真实请求仍由引擎发起）。
    R116-2：读入上限 MAX_HTML_BYTES+1——超大响应体（误配二进制/巨型列表页等）不再
    全量读入内存；超限时返回 oversized=True 供上层截断并附 warnings。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": user_agent or DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=timeout_s, context=_SSL_CTX) as resp:
        body = resp.read(MAX_HTML_BYTES + 1)
        oversized = len(body) > MAX_HTML_BYTES
        if oversized:
            body = body[:MAX_HTML_BYTES]
        return resp.status, resp.geturl(), body, oversized


def iv8_fetch(url: str, timeout_ms: int, user_agent: str, advance_ms: int) -> dict:
    """iv8 补环境：取初始 HTML → page.load（脚本执行）→ 推进事件循环 →
    返回执行后 DOM 与 document.cookie（供引擎带 cookie 复抓或直接用渲染结果）。"""
    t0 = time.time()
    timeout_s = max(3.0, min(timeout_ms, MAX_TIMEOUT_MS) / 1000.0)
    src_oversized = False  # R116-2：源响应体超限标记
    try:
        status, final_url, body, src_oversized = _http_get(url, timeout_s, user_agent)
    except urllib.error.HTTPError as e:
        # 403/503 挑战页同样值得进 iv8 跑（正文可能就是 JS 挑战脚本）
        try:
            body = e.read(MAX_HTML_BYTES + 1)  # R116-2：读入上限
            status, final_url = int(e.code or 0), url
        except Exception:
            return {"ok": False, "error": f"iv8 取源失败: {e}",
                    "elapsedMs": int((time.time() - t0) * 1000)}
        src_oversized = len(body) > MAX_HTML_BYTES
        if src_oversized:
            body = body[:MAX_HTML_BYTES]
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
            # R116-2：大页护栏（源响应体 + 渲染产物双检查点，防异常大页滞留内存）
            warnings = []
            if src_oversized:
                warnings.append("源响应体超过 8MB 已截断（防异常大页滞留内存）")
            if len(out_html) > MAX_HTML_BYTES:
                warnings.append(
                    f"渲染后 HTML 超过 {MAX_HTML_BYTES // (1024 * 1024)}MB 已截断（防异常大页滞留内存）")
                print(f"[stealth-service] iv8 大页护栏：截断 {len(out_html)}B → "
                      f"{MAX_HTML_BYTES}B url={url}", flush=True)
                out_html = out_html[:MAX_HTML_BYTES]
            out = {
                "ok": True, "html": out_html, "cookies": cookies,
                "finalUrl": final_url, "status": status,
                "elapsedMs": int((time.time() - t0) * 1000),
            }
            if warnings:
                out["warnings"] = warnings
            return out
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
            # R120：waitSelector/waitSelectorTimeoutMs 可选——JS 慢渲染站的关键选择器
            # 等待（backend 规则提取选择器透传链：engine opts → /cloak → 子进程
            # wait_for_selector；超时不失败，waitSelectorFound 随响应透出）
            self._json(200, cloak_fetch(
                url, timeout_ms, proxy, user_agent,
                wait_selector=str(req.get("waitSelector") or "").strip()[:256],
                ws_timeout_ms=int(req.get("waitSelectorTimeoutMs") or 15000)))
            return
        if self.path.rstrip("/") == "/iv8":
            if not HAS_IV8:
                self._json(200, {"ok": False, "error": "iv8 未安装"})
                return
            self._json(200, iv8_fetch(url, timeout_ms, user_agent,
                                      int(req.get("advanceMs") or 3000)))
            return
        self._json(404, {"ok": False, "error": "not found"})


def _sweep_orphan_chromium():
    """R110：清扫孤儿（父进程已死、被 init 收养 PPID==1）的 chrome 与 playwright driver。

    R116-2 扩展：driver comm 实为 'MainThread'（node 改写主线程名），旧 comm 判据
    看不见 → 重启后 driver 孤儿残留累积。现对 PPID==1 且 cmdline 含 playwright
    run-driver 特征的进程一并补刀。

    泄漏链：scraper-go browser 策略超时只杀 render.py 直接子进程（R110 已在 Go 侧
    改进程组击杀根修），历史积压与任何残余路径的 chrome 树会挂 PPID 1——每棵树
    60-100 线程，沙箱 threads-max ~925 很快被吃满，pthread_create EAGAIN 连锁
    browser/cloak 全灭。本侧车重启时（run.sh 崩溃自动重启会频发）顺带清扫：
    只杀「PPID==1 且 comm 含 chrome」的进程——活的池内实例父进程是本 python，
    不会误伤。"""
    import os as _os
    import signal as _signal
    me = _os.getpid()
    killed = 0
    for pid in _os.listdir("/proc"):
        if not pid.isdigit():
            continue
        p = int(pid)
        if p == me:
            continue
        try:
            with open(f"/proc/{pid}/stat", "rb") as f:
                stat = f.read().decode("utf-8", "replace")
            # comm 可能含空格/括号：取最后一个 ')' 之后的字段（state=第3字段，ppid=第4字段）
            after = stat[stat.rindex(")") + 2:].split()
            comm_end = stat.rindex(")")
            comm = stat[stat.index("(") + 1:comm_end]
            ppid = int(after[1])
            if ppid != 1:
                continue
            comm_l = comm.lower()
            if "chrome" not in comm_l:
                # R116-2：孤儿 playwright driver 补刀（comm='MainThread'，需 cmdline
                # 权威复核防误伤未知 node 进程）
                cmd = _proc_cmdline(p)
                if not (("mainthread" in comm_l or "node" in comm_l)
                        and ("playwright" in cmd or "run-driver" in cmd)):
                    continue
            _os.kill(p, _signal.SIGKILL)
            killed += 1
        except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
            continue
        except Exception:
            continue
    if killed:
        print(f"[stealth-service] 启动清扫：击杀 {killed} 个孤儿浏览器进程（chrome/driver）", flush=True)


def main():
    _sweep_orphan_chromium()
    _mem_load()
    threading.Thread(target=_driver_janitor, daemon=True).start()
    threading.Thread(target=_mem_save_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler)
    srv.daemon_threads = True
    print(f"[stealth-service] v{VERSION} listening on http://127.0.0.1:{LISTEN_PORT} "
          f"(cloak={HAS_CLOAK} cloakBinary={_cloak_binary_ready()} iv8={HAS_IV8})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
