#!/usr/bin/env python3
"""通用文件片段打印：print_file.py <path> [start_marker] [offset] [length]"""
import sys

path = sys.argv[1]
marker = sys.argv[2] if len(sys.argv) > 2 else None
offset = int(sys.argv[3]) if len(sys.argv) > 3 else 0
length = int(sys.argv[4]) if len(sys.argv) > 4 else 5000

html = open(path, encoding='utf-8', errors='ignore').read()
if marker:
    i = html.find(marker)
    if i < 0:
        print(f'MARKER NOT FOUND: {marker}')
        sys.exit(0)
    html = html[i:]
print(html[offset:offset + length])
