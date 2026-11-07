#!/usr/bin/env python3
"""分析书海阁页面结构：输出 body 骨架（去 script/style），供主题复刻参考"""
import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/washai-home.html'
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 6000
html = open(path, encoding='utf-8', errors='ignore').read()
i = html.find('<body')
body = html[i:] if i >= 0 else html
body = re.sub(r'<script[^>]*>.*?</script>', '', body, flags=re.S)
body = re.sub(r'<style[^>]*>.*?</style>', '', body, flags=re.S)
body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
body = re.sub(r'\n\s*\n+', '\n', body)
print(body[:limit])
