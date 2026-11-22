# libretranslate 侧车（R168）

开源可本地部署的神经机器翻译服务（LibreTranslate + Argos Translate 引擎，
ctranslate2 CPU 推理，**无 torch 依赖**——LibreTranslate 官方 fork
`argos-translate-lt` 已移除 stanza/torch，纯 CPU 秒级推理）。

## 定位（与 LLM 的关系）

| 维度 | LLM（z-ai SDK） | LibreTranslate（本服务） |
|------|----------------|------------------------|
| 质量 | 文学级（首选） | 通用级（zh→ja 经 pivot 两跳会失真） |
| 速度 | 30-90s/批，受 429 配额 | 0.6-2s/段，无限量 |
| 成本 | 上游配额 | 零（本地 CPU） |
| 角色 | **主引擎** | **兜底 + 加速**：LLM 失败段垫底，保证翻译永不空白 |

## 端口与暴露面

- `127.0.0.1:5000`（仅内网；同 translate-service :3032，不经网关暴露公网）
- API 为 LibreTranslate 标准协议，translate-service 之外的第三方工具
  （浏览器插件、写作软件）只要指向本实例即可复用。

## 部署

```bash
# 1) Python 包（阿里云镜像优先；清华镜像索引可读但包文件 403）
pip install libretranslate -i https://mirrors.aliyun.com/pypi/simple/

# 2) 模型（~370MB：zh_en/en_zh/en_ja/en_ko + 句切 onnx，断点续传幂等）
bash install-models.sh

# 3) 常驻（flock 单实例 + 崩溃自动重启）
nohup bash run.sh > /tmp/libretranslate-run.log 2>&1 &

# 4) 验证
curl -s http://127.0.0.1:5000/languages
curl -s -X POST http://127.0.0.1:5000/translate -H 'Content-Type: application/json' \
  -d '{"q":"你好世界","source":"zh-Hans","target":"en","format":"text"}'
```

## 模型通道备忘（2026-11 实测）

- argos 模型：`argos-net.com`（直连可达）。**旧 argosopentech S3 bucket 已废弃**
  （NoSuchBucket），网上旧教程的 S3 链接全部失效。
- minisbd 句切模型：GitHub Releases（直连失败走 `ghfast.top` 代理）。
- 语言对覆盖：zh↔en、en↔ja、en↔ko 为直接对；**zh→ja/ko 无直接模型，
  LibreTranslate 1.9.6 内置 auto-pivot（API 直发 zh-Hans→ja，内部经 en 中转）**。
- zh-Hant 不走本引擎：站内繁体由 OpenCC 词典转换（质量更高、零推理成本）。

## 质量观测（R168 实测，翻译源文本为修仙小说句）

- zh→en：`他被家族长辈看不起` → "He was despised by his elders"（可用）
- zh→ja（pivot）：`他被家族长辈看不起` → 「彼は彼の長老によって決まっていた」（失真——
  pivot 两跳的固有损耗，故 libre 仅作兜底不作为 ja/ko 主引擎）
