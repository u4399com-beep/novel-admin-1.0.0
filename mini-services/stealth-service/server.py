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
        self._pages_served = {}  # R108: key -> 已服务页数（networkidle 自适应：首页长等，后续短等）

    def _launch(self, proxy: str, user_agent: str):
        kwargs = {"headless": True}
        if proxy:
            kwargs["proxy"] = proxy
        # R116-2：追加降内存 chromium 启动参数（在既有参数基础上追加，不删除任何默认
        # 隐身参数——cloakbrowser launch(args=...) 将其与默认 stealth 参数合并）
        args = list(CHROME_LOW_MEM_ARGS)
        if user_agent:
            args.insert(0, f"--user-agent={user_agent}")
        kwargs["args"] = args
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
            # 容量上限：最旧实例淘汰（close）。泄漏残余（close 偶发不杀 driver/chrome
            # 树）由修复后的 janitor（全后代树扫描，30s 周期，硬上限 MAX_CHILD_DRIVERS）
            # 补刀收敛——差集法会误伤在用的其他池实例，弃用。
            while len(self._browsers) >= MAX_PROXY_BROWSERS:
                old_key = next(iter(self._browsers))
                old_b = self._browsers.pop(old_key)
                try:
                    old_b.close()
                except Exception:
                    pass
            self._browsers[key] = b
            return b

    def note_page_served(self, proxy: str, user_agent: str):
        """R108: 页面渲染成功后计数（networkidle 自适应依据：实例已热则短等）。"""
        key = f"{proxy}|{user_agent}"
        with self._lock:
            self._pages_served[key] = self._pages_served.get(key, 0) + 1

    def networkidle_ms(self, proxy: str, user_agent: str) -> int:
        """R108: networkidle 等待上限自适应。
        首页（实例冷/新 key）给足 8s——挑战页常有二次跳转/JS 挑战；实例已成功服务过页面后
        说明挑战已过、会话已热，章节正文页 DOMContentLoaded 即含正文，白等网络空闲只会
        拖慢每个请求（实测 browser 站 2.4s/章 里相当部分是 networkidle 尾巴）。后续页 2.5s。
        超时不算失败（与原语义一致）。"""
        key = f"{proxy}|{user_agent}"
        with self._lock:
            served = self._pages_served.get(key, 0)
        return 8000 if served == 0 else 2500

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


def _child_procs():
    """枚举本进程的直接子进程 [(pid, comm, etime)]（读 /proc，无外部依赖；R111 保留兼容）。"""
    import os as _os
    me = _os.getpid()
    out = []
    for pid in _os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/stat", "rb") as f:
                stat = f.read().decode("utf-8", "replace")
            i = stat.index("(")
            comm = stat[i + 1:stat.rindex(")")]
            after = stat[stat.rindex(")") + 2:].split()
            if int(after[1]) != me:
                continue
            # stat field 22 = starttime（clock ticks）：after 里下标 19
            out.append((int(pid), comm, int(after[19])))
        except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
            continue
        except Exception:
            continue
    return out


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


def cloak_fetch(url: str, timeout_ms: int, proxy: str, user_agent: str) -> dict:
    """CloakBrowser 整页渲染。单次请求内 page 级异常重建浏览器重试一次。"""
    t0 = time.time()
    timeout_s = max(3.0, min(timeout_ms, MAX_TIMEOUT_MS) / 1000.0)
    last_err = None
    cookies_out = []  # R110: cloak cookie 回存快通道（会话热判据之一）
    served_ok = False  # R108: 成功渲染才计数（网络热标记）；失败页不推进自适应
    for attempt in (0, 1):
        browser = _CLOAK_POOL.acquire(proxy, user_agent) if attempt == 0 \
            else _CLOAK_POOL.rebuild(proxy, user_agent)
        page = None
        try:
            page = browser.new_page()
            resp = page.goto(url, timeout=int(timeout_s * 1000), wait_until="domcontentloaded")
            # 尽力等待网络空闲（反爬页常有二次跳转/JS 挑战），超时不算失败。
            # R108: 上限自适应——实例已成功服务过页面（会话热）后短等 2.5s，
            # 避免章节正文页白等网络空闲拖慢每个请求（首页仍 8s 保挑战页体验）。
            try:
                page.wait_for_load_state("networkidle", timeout=_CLOAK_POOL.networkidle_ms(proxy, user_agent))
            except Exception:
                pass
            html = page.content()
            # R116-2：大页护栏——单页 HTML 超过 8MB 截断（防异常大页滞留内存/撑爆 JSON
            # 响应序列化），截断事实通过新增可选字段 warnings 回传（引擎端未知字段自动忽略）。
            html_warnings = []
            if len(html) > MAX_HTML_BYTES:
                html_warnings.append(
                    f"HTML 超过 {MAX_HTML_BYTES // (1024 * 1024)}MB 已截断（防异常大页滞留内存）")
                print(f"[stealth-service] cloak 大页护栏：截断 {len(html)}B → "
                      f"{MAX_HTML_BYTES}B url={url}", flush=True)
                html = html[:MAX_HTML_BYTES]
            served_ok = True  # R108: 渲染成功，标记网络热（finally 中计数）
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
            # R110：会话 cookie 回传——挑战型站点（Cloudflare cf_clearance 等）浏览器
            # 过盾后 cookie 落在 context 里，不回传则引擎每章都重打挑战（慢 10 倍）。
            # 与 browser 桥接（renderPayload.Cookies）/iv8（document.cookie）同语义。
            try:
                for c in (page.context.cookies(final_url) or []):
                    cookies_out.append({
                        "name": c.get("name") or "",
                        "value": c.get("value") or "",
                        "expires": c.get("expires") or -1,
                        "secure": bool(c.get("secure")),
                    })
            except Exception:
                pass
            out = {
                "ok": True, "html": html, "status": status, "finalUrl": final_url,
                "cookies": cookies_out,
                "elapsedMs": int((time.time() - t0) * 1000),
            }
            if html_warnings:
                out["warnings"] = html_warnings
            return out
        except Exception as e:
            last_err = e
            if attempt == 1:
                break
        finally:
            if page is not None:
                try:
                    cookies_out = []
                    for c in (page.context.cookies() or []):
                        cookies_out.append({
                            "name": c.get("name") or "",
                            "value": c.get("value") or "",
                            "expires": c.get("expires") or -1,
                            "secure": bool(c.get("secure")),
                        })
                except Exception:
                    pass
                # R111：new_page() 每次创建独立 BrowserContext（cookie/存储隔离）。
                # 只 page.close() 在部分版本不级联关 context → context 堆积（cookie 泄漏
                # 跨请求串味风险 + 内存增长）。显式先关 context 再关 page，双保险。
                try:
                    page.context.close()
                except Exception:
                    pass
                try:
                    page.close()
                except Exception:
                    pass
                if served_ok:
                    _CLOAK_POOL.note_page_served(proxy, user_agent)
    return {"ok": False, "error": f"cloak 渲染失败: {last_err}",
            "cookies": cookies_out,
            "elapsedMs": int((time.time() - t0) * 1000)}


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
    threading.Thread(target=_driver_janitor, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler)
    srv.daemon_threads = True
    print(f"[stealth-service] v{VERSION} listening on http://127.0.0.1:{LISTEN_PORT} "
          f"(cloak={HAS_CLOAK} cloakBinary={_cloak_binary_ready()} iv8={HAS_IV8})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
