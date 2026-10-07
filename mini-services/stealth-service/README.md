# stealth-service —— iv8 / CloakBrowser 反检测抓取侧车

R101 新增独立 Python 侧车（端口 **3031** 固定），为 scraper-go 策略链提供两个高对抗
抓取后端。**可选组件**：未安装/未启动时引擎策略自动标记不可用并跳过，主链路零影响。

## 两个能力对比

| | fetch-iv8（iv8） | fetch-cloak（CloakBrowser） |
|---|---|---|
| 本质 | Python 原生 V8 + C++ 模拟 BOM/DOM/CSSOM（无渲染，纯 JS 执行环境） | 真实 Chromium 二进制，C++ 源码级指纹改造（87 处补丁） |
| 强项 | 轻量高并发（每 Context 独立 Isolate，多线程 ~4.7x）、毫秒级执行 | 过 Cloudflare Turnstile / FingerprintJS / BrowserScan 指纹与行为检测 |
| 适用 | 「JS 计算 cookie/参数」类反爬（如 acw_sc__v2 cookie 生成、加密参数） | 强反爬站点整页渲染抓取 |
| 资源 | 极低（无渲染进程，内存 +15MB 级） | 高（完整 Chromium 实例） |
| 合规 | 社区版无内置真实网络传输：页面脚本内 XHR/fetch 不会真实外发 | 真实浏览器行为 |

两者互补：JS 加密参数场景用 iv8，整页反爬场景用 CloakBrowser。

## 接口

- `GET /health` → `{"ok":true,"cloak":bool,"cloakBinary":bool,"iv8":bool}`
- `POST /cloak` `{"url","timeoutMs","proxy","userAgent"}` → `{"ok","html","status","finalUrl","elapsedMs"}`
- `POST /iv8` `{"url","timeoutMs","userAgent","advanceMs"}` → `{"ok","html","cookies","finalUrl","elapsedMs"}`

业务失败一律 HTTP 200 + `ok:false`（引擎按 ok 判定，与引擎策略语义对齐）。

## 部署（国内服务器）

```bash
cd mini-services/stealth-service
python3 -m venv venv
venv/bin/pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
./run.sh   # 前台或 systemd 托管；崩溃自动重启
```

- CloakBrowser 首次启动自动从其官方 CDN 下载 Chromium 二进制（约 100-150MB）；
  若下载失败，`/health` 的 `cloakBinary=false`，fetch-cloak 策略不可用（其余不受影响）。
- iv8 为预编译 wheel（linux-x86_64），pip 直装即用。
- 不需要该能力时整目录可不部署：scraper-go 探测 `SCRAPE_SIDECAR_URL`（默认
  `http://127.0.0.1:3031`）失败即把两个策略置为不可用。

## 实现要点

- cloakbrowser 浏览器实例按 proxy 配置缓存复用（launch 秒级开销摊薄），每请求独立
  page；page 级异常自动重建浏览器重试一次；池上限 4 实例（最旧淘汰）。
- iv8 每请求独立 JSContext（`time_mode="logical"`），`page.load` 执行页面脚本后推进
  事件循环（默认 3000ms，可传 `advanceMs` 覆盖），返回执行后 DOM 与 `document.cookie`。
- 侧车自身只做「取初始 HTML + 本地执行」；真实站点请求永远由 scraper-go 发起
  （域槽限速、AIMD、hosthealth 语义不变）。
