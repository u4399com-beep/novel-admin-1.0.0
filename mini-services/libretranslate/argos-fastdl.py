#!/usr/bin/env python3
"""argos-fastdl.py —— argos 模型 IPFS 网关多路 Range 并行下载（R183）。

背景：argos-net.com 按 IP 聚合限流（R182 坑存档③），本轮实测恶化至 ~4KB/s；
argospm 官方索引提供 IPFS 备用源（ipfs:// CID），gateway.pinata.cloud 实测
206 Range 可用 21.6KB/s/路。本脚本：
  1. 断点继承：现有 /tmp/argosmodel-{name}.argosmodel 前缀（append 链遗产）
     作为 part0；剩余区间切 N 段并行下载（独立分段文件，含段内续传偏移）；
  2. 全段完成 → 合并 → 总尺寸校验 → argostranslate package.install_from_path
     → 索引缓存放开（install-models.sh update_index 语义等价）；
  3. 任一段失败自动回退 argos-net 直链续传；整体 5 次重试。
"""
import json
import os
import sys
import threading
import time
import urllib.request

UA = 'curl/8.5.0'
GW = 'https://gateway.pinata.cloud/ipfs'
INDEX_FILE = os.path.expanduser('~/.local/share/argos-translate/index.json')
FULL_INDEX = '/tmp/argos-index.json'

TASKS = [
    ('en_ja', 'QmQjHs8ZhCU6WTV9RRHQMXgy4cDwyjvLUZ4bBp6J9GMCRb', 120470284,
     'https://argos-net.com/v1/translate-en_ja-1_1.argosmodel'),
    ('en_ko', 'QmWecr5i4tJNnokusm97rTUyQtUqNNPufGF7ake1hJVu6G', 120789009,
     'https://argos-net.com/v1/translate-en_ko-1_1.argosmodel'),
]

PARALLEL = 4


def fetch_range(url, start, end, out_path):
    """Range 拉取 [start, end]（含）追加到 out_path；返回实际追加字节数。"""
    want = end - start + 1
    got = 0
    while got < want:
        off = start + got
        req = urllib.request.Request(url, headers={
            'Range': f'bytes={off}-', 'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            if r.status != 206 and off > start:
                raise IOError(f'no range support: {r.status}')
            with open(out_path, 'ab') as out:
                while True:
                    chunk = r.read(131072)
                    if not chunk:
                        break
                    if got + len(chunk) > want:
                        chunk = chunk[:want - got]
                    out.write(chunk)
                    got += len(chunk)
                    if got >= want:
                        break
    return got


def segs_of(name, total):
    """段清单 [(s, e, path, is_prefix)]：前缀 part0 + 剩余 4 段。"""
    f = f'/tmp/argosmodel-{name}.argosmodel'
    prefix = min(os.path.getsize(f) if os.path.exists(f) else 0, total)
    segs = []
    if prefix > 0:
        segs.append((0, prefix - 1, f, True))
        remain = total - prefix
        step = (remain + PARALLEL - 1) // PARALLEL
        for i in range(PARALLEL):
            s = prefix + i * step
            e = min(total - 1, s + step - 1)
            if s > e:
                break
            segs.append((s, e, f'{f}.seg{i+1}', False))
    else:
        step = (total + PARALLEL - 1) // PARALLEL
        for i in range(PARALLEL):
            s = i * step
            e = min(total - 1, s + step - 1)
            if s > e:
                break
            segs.append((s, e, f'{f}.seg{i+1}', False))
    return segs


def done_bytes(segs):
    return sum(min(os.path.getsize(p), e - s + 1) if os.path.exists(p) else 0
               for s, e, p, _ in segs)


def download_model(name, cid, total, fallback_url):
    f = f'/tmp/argosmodel-{name}.argosmodel'
    segs = segs_of(name, total)
    task_threads = []

    def worker(s, e, path):
        want = e - s + 1
        have = os.path.getsize(path) if os.path.exists(path) else 0
        if have >= want:
            return
        try:
            fetch_range(f'{GW}/{cid}', s + have, e, path)
        except Exception as ex:
            print(f'[{name}] seg {s}-{e} gw FAIL: {str(ex)[:60]} → 回退直链', flush=True)
            have = os.path.getsize(path) if os.path.exists(path) else 0
            if have < want:
                fetch_range(fallback_url, s + have, e, path)

    # R183 实证：pinata 同 IP 并发 Range 强串行（4 路并行段零增长）——
    # 单路顺序逐段下载（21.6KB/s 稳定，5 倍于 argos-net 直连 4KB/s）
    for s, e, path, is_prefix in segs:
        if is_prefix:
            continue
        worker(s, e, path)
        print(f'[{name}] seg {s}-{e} 完成 '
              f'{done_bytes(segs)}/{total} ({done_bytes(segs)*100.0/total:.1f}%)', flush=True)

    # 合并：part0 前缀（truncate 防超界）+ 各段定位写
    prefix = min(os.path.getsize(f) if os.path.exists(f) else 0, total)
    with open(f, 'r+b' if prefix > 0 else 'wb') as out:
        out.truncate(prefix)
        for s, e, path, is_prefix in segs:
            if is_prefix:
                continue
            have = os.path.getsize(path)
            if have < e - s + 1:
                raise IOError(f'seg {s}-{e} incomplete: {have}')
            with open(path, 'rb') as seg:
                out.seek(s)
                while True:
                    chunk = seg.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
    size = os.path.getsize(f)
    if size != total:
        raise IOError(f'size mismatch: {size} != {total}')
    for _, _, path, is_prefix in segs:
        if not is_prefix:
            os.unlink(path)
    print(f'[{name}] 合并完成 {size}B', flush=True)
    return f


def installed_pairs():
    from argostranslate import package
    return {(p.from_code, p.to_code) for p in package.get_installed_packages()}


def update_index(kept_pairs):
    try:
        full = json.load(open(FULL_INDEX))
    except Exception:
        return
    kept = [e for e in full if (e.get('from_code'), e.get('to_code')) in kept_pairs]
    json.dump(kept, open(INDEX_FILE, 'w'))


def main():
    for name, cid, total, fallback in TASKS:
        pair = (name.split('_')[0], name.split('_')[1])  # en_ja -> (en, ja)
        if pair in installed_pairs():
            print(f'[{name}] 已装，跳过', flush=True)
            continue
        done_pairs = {t[0] for t in TASKS if t[0] in installed_pairs()}
        update_index(done_pairs | {pair})
        print(f'[{name}] 并行下载启动（{PARALLEL} 路 Range + 断点继承 {done_bytes(segs_of(name, total))}B）', flush=True)
        attempts = 0
        while True:
            try:
                f = download_model(name, cid, total, fallback)
                break
            except Exception as ex:
                attempts += 1
                print(f'[{name}] attempt {attempts} FAIL: {str(ex)[:120]}', flush=True)
                if attempts >= 5:
                    print(f'[{name}] RESULT: 5 次失败放弃（重跑本脚本续传）', flush=True)
                    sys.exit(1)
                time.sleep(8)
        from argostranslate import package
        package.install_from_path(f)
        os.unlink(f)
        print(f'[{name}] 安装完成', flush=True)
    pkgs = installed_pairs()
    print('[fastdl] 已装:', sorted(pkgs), flush=True)
    update_index(pkgs)
    missing = {t[0] for t in TASKS} - pkgs
    print('[fastdl] RESULT:', 'ALL_DONE' if not missing else f'未完成 {sorted(missing)}', flush=True)


if __name__ == '__main__':
    main()
