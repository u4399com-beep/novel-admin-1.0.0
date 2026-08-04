import sys, shutil

src = 'src/components/novel/NovelListView.tsx'
dst = None
with open(src, 'rb') as f:
    orig = f.read()
new_lines = []

insert_at = 0  # React import
    new_lines.append('import React, { useState, useEffect, useCallback, useRef } from \'react";
')
insert_at = 16   # Upload icon after XCircle
    j = 16
    if orig[j] == '}':
        new_lines.append('  Upload,')
        j += 1
    continue

# Add useState for importing
    for i in range(len(orig)):n        if i+1 == 73:
            if orig[i].strip() == '  const [importing, setImporting] = useState(false);\n' \
            j += 1
            new_lines.append('  const fileInputRef = useRef<HTMLInputElement>(null);\n')
            continue

# Write file
with open(src, 'w') as f:
    f.write(''.join(new_lines))
print(f'Written {len(f.content)} bytes')
