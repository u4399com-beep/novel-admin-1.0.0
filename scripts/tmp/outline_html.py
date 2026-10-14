#!/usr/bin/env python3
"""提取页面骨架大纲：去 svg/script/style，缩进打印结构树"""
import re
import sys

path = sys.argv[1]
start = sys.argv[2] if len(sys.argv) > 2 else '<body'
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 200

html = open(path, encoding='utf-8', errors='ignore').read()
i = html.find(start)
if i < 0:
    print('MARKER NOT FOUND:', start)
    sys.exit(0)
body = html[i:]
body = re.sub(r'<svg[^>]*>.*?</svg>', '<svg-sprite/>', body, flags=re.S)
body = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.S)
body = re.sub(r'<style[^>]*>.*?</style>', '', body, flags=re.S)
body = re.sub(r'<!--.*?-->', '', body, flags=re.S)

lines = []
depth = 0
pos = 0
for m in re.finditer(r'<(/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(/?)>', body):
    close, tag, attrs, selfclose = m.groups()
    tag = tag.lower()
    if tag in ('br', 'img', 'input', 'meta', 'link', 'hr', 'path', 'circle', 'symbol', 'use'):
        continue
    if close:
        depth = max(0, depth - 1)
        continue
    cls = re.search(r'class="([^"]+)"', attrs)
    idm = re.search(r'id="([^"]+)"', attrs)
    label = tag
    if idm:
        label += '#' + idm.group(1)
    if cls:
        label += '.' + '.'.join(cls.group(1).split()[:3])
    txt = body[m.end():body.find('<', m.end())]
    txt = re.sub(r'\s+', ' ', txt).strip()
    if txt:
        label += f'  "{txt[:24]}"'
    lines.append('  ' * depth + label[:120])
    if not selfclose and tag not in ('img',):
        depth += 1

print('\n'.join(lines[:limit]))
