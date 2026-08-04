import sys, os, re

src = 'src/components/novel/NovelListView.tsx'

with open(src, 'rb') as f:
    orig = f.read()

lines = orig.split(chr(10))
print(f'Lines: {len(lines)}')

for i, line in enumerate(lines, 1):
    print(f'L{i+1}: {line.rstrip()[:80]}')
