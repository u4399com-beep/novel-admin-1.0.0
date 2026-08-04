import os, re

api_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'app', 'api')
api_dir = os.path.normpath(api_dir)
pattern = re.compile(r', detail: msg\}')
fixed_files = 0
fixed_total = 0

for root, dirs, files in os.walk(api_dir):
    for fname in files:
        if fname == 'route.ts':
            fpath = os.path.join(root, fname)
            with open(fpath, 'r') as f:
                content = f.read()
            matches = pattern.findall(content)
            if matches:
                new_content = pattern.sub('}', content)
                with open(fpath, 'w') as f:
                    f.write(new_content)
                fixed_files += 1
                fixed_total += len(matches)
                print(f'  {fpath}: {len(matches)} fixes')

print(f'\nTotal: {fixed_total} fixes in {fixed_files} files')

# Also remove now-unused 'msg' variable declarations where applicable
msg_pattern = re.compile(r'\n\s*const msg = error instanceof Error \? error\.message : String\(error\);\n', re.MULTILINE)
for root, dirs, files in os.walk(api_dir):
    for fname in files:
        if fname == 'route.ts':
            fpath = os.path.join(root, fname)
            with open(fpath, 'r') as f:
                content = f.read()
            if 'detail: msg' not in content and 'const msg = error instanceof' in content:
                # Check if msg is used elsewhere
                uses = len(re.findall(r'\bmsg\b', content)) - 1  # minus the declaration
                if uses <= 0:
                    new_content = msg_pattern.sub('\n', content)
                    if new_content != content:
                        with open(fpath, 'w') as f:
                            f.write(new_content)
                        print(f'  (cleaned dead msg var) {fpath}')
