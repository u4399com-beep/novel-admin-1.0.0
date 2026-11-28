#!/usr/bin/env bash
# install-models.sh —— Argos 四模型幂等安装（R173 LibreTranslate-only 栈物料，R182 固化）。
# 模型面（R173 契约）：zh→en 直翻 + en→zh + en→ja/en→ko（ja/ko 经 en auto-pivot 双跳）；
# zh-Hant/zh-HK 不经本服务（OpenCC 快通道）。
#
# R182 网络实证坑（勿回退）：
# ① argos-net.com 对 Python-urllib UA 反盗链 403（curl UA 放行）——下载必须带 curl UA 头；
# ② 服务器 Range 支持不稳定期会返回 200 全量 → curl -C - 会截断重下——必须 python
#    append 模式（'ab' 永不截断）+ 206 校验 + 尺流重试；
# ③ 被墙网络下 LibreTranslate 启动期自动补装缺失 pair 会黑洞阻塞绑定——索引缓存
#    （~/.local/share/argos-translate/index.json）按已装 pair 收缩（本脚本同步维护），
#    模型装齐一个、索引放开一个，服务重启即扩宽（run.sh --load-only 动态计算）；
# ④ minisbd 句界模型损坏（启动期被墙下载残留）→ 从 GitHub release 经 ghfast 镜像重下
#    （https://ghfast.top/https://github.com/LibreTranslate/MiniSBD/releases/download/v0.0.1/）。
# 模型落盘 ~/.local/share/argos-translate（仓库外，~250MB 不入库）。幂等：按已装跳过。
set -u
cd "$(dirname "$0")"
PY="venv/bin/python3"
[ -x "$PY" ] || PY="python3"

INDEX_FILE="$HOME/.local/share/argos-translate/index.json"
FULL_INDEX=/tmp/argos-index.json

# ---------- minisbd 句界模型完整性自愈（GitHub release 经 ghfast） ----------
fix_minisbd() {
  local dir="$HOME/.local/share/argos-translate/minisbd"
  mkdir -p "$dir"
  # ONNX 头校验：protobuf 模型以 0x08 开头；损坏残留（HTML/截断）即重下
  for m in zh-hans en ja ko; do
    f="$dir/$m.onnx"
    if [ -f "$f" ] && [ "$(head -c 1 "$f" | od -An -tx1 | tr -d ' \n')" = "08" ]; then
      continue
    fi
    echo "[models] minisbd $m.onnx 缺失/损坏 → ghfast 重下"
    curl -sL --max-time 60 -o "$f" \
      "https://ghfast.top/https://github.com/LibreTranslate/MiniSBD/releases/download/v0.0.1/$m.onnx" \
      || echo "[models] minisbd $m.onnx 下载失败（非致命，:5000 对应语种句界降级）"
  done
}
fix_minisbd

# ---------- 全量索引缓存（模型直链来源，ghfast/直链均可取） ----------
if [ ! -s "$FULL_INDEX" ]; then
  curl -sL --max-time 60 -o "$FULL_INDEX" \
    "https://ghfast.top/https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json" \
    || curl -sL --max-time 60 -o "$FULL_INDEX" \
    "https://raw.githubusercontent.com/argosopentech/argospm-index/main/index.json"
fi

# ---------- 逐模型下载+安装（UA 头 + append 续传 + 尺流重试 + 索引逐步放开） ----------
"$PY" - <<'PYEOF'
import urllib.request, os, time, json

UA = 'curl/8.5.0'
INDEX_FILE = os.path.expanduser('~/.local/share/argos-translate/index.json')
FULL_INDEX = '/tmp/argos-index.json'
TASKS = [
    (('zh', 'en'), 'https://argos-net.com/v1/translate-zh_en-1_9.argosmodel', 74481402, 'translate-zh_en-1_9'),
    (('en', 'zh'), 'https://argos-net.com/v1/translate-en_zh-1_9.argosmodel', 70743021, 'translate-en_zh-1_9'),
    (('en', 'ja'), 'https://argos-net.com/v1/translate-en_ja-1_1.argosmodel', 120470284, 'translate-en_ja-1_1'),
    (('en', 'ko'), 'https://argos-net.com/v1/translate-en_ko-1_1.argosmodel', 120789009, 'translate-en_ko-1_1'),
]

def installed_pairs():
    from argostranslate import package
    return {(p.from_code, p.to_code) for p in package.get_installed_packages()}

def update_index(kept_pairs):
    """索引缓存收缩/放开：仅含 kept_pairs（LibreTranslate 启动期只补装索引内缺失 pair）"""
    try:
        full = json.load(open(FULL_INDEX))
    except Exception:
        return
    kept = [e for e in full if (e.get('from_code'), e.get('to_code')) in kept_pairs]
    json.dump(kept, open(INDEX_FILE, 'w'))

def download(pair, url, total):
    frm, to = pair
    f = f'/tmp/argosmodel-{frm}_{to}.argosmodel'
    while (os.path.getsize(f) if os.path.exists(f) else 0) < total:
        off = os.path.getsize(f) if os.path.exists(f) else 0
        try:
            req = urllib.request.Request(url, headers={'Range': f'bytes={off}-', 'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status != 206 and off > 0:
                    time.sleep(5); continue
                with open(f, 'ab') as out:  # append 永不截断（坑②）
                    while True:
                        chunk = r.read(131072)
                        if not chunk: break
                        out.write(chunk)
        except Exception as e:
            print(f'[models] {frm}->{to} chunk err: {str(e)[:50]} off={off}', flush=True)
            time.sleep(8)
    return f

for pair, url, total, _name in TASKS:
    frm, to = pair
    if pair in installed_pairs():
        print(f'[models] {frm}->{to} 已装，跳过', flush=True)
        continue
    # 索引放开本 pair（防其他缺失 pair 阻塞启动；本 pair 交给本脚本下载而非 :5000 启动器）
    done_pairs = {t[0] for t in TASKS if t[0] in installed_pairs()}
    update_index(done_pairs | {pair})
    print(f'[models] 下载 {frm}->{to}（append 续传，总 {total}B）', flush=True)
    f = download(pair, url, total)
    from argostranslate import package
    package.install_from_path(f)
    os.unlink(f)
    print(f'[models] {frm}->{to} 安装完成', flush=True)

pkgs = installed_pairs()
print('[models] 已装:', sorted(pkgs), flush=True)
update_index(pkgs)  # 终态：索引=已装集合（:5000 零下载秒绑）
missing = {t[0] for t in TASKS} - pkgs
print('[models] RESULT:', 'ALL_DONE' if not missing else f'未完成 {sorted(missing)}（重跑本脚本续传）', flush=True)
PYEOF
