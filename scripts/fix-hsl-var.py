import re

with open('/home/z/my-project/src/app/globals.css', 'r') as f:
    content = f.read()

def replace_hsl_var(m):
    full = m.group(0)
    var_name = m.group(1)
    opacity_part = m.group(2)  # e.g. ' / 0.3' or None
    
    if opacity_part is None:
        return f'var({var_name})'
    
    op_str = opacity_part.replace('/', '').strip()
    try:
        op = float(op_str)
    except ValueError:
        return full
    
    pct = int(op * 100)
    if pct == 0:
        return 'transparent'
    if pct >= 100:
        return f'var({var_name})'
    
    return f'color-mix(in srgb, var({var_name}) {pct}%, transparent)'

# Match hsl(var(--xxx)) and hsl(var(--xxx) / 0.N)
pattern = r'hsl\(var\((--[\w-]+)\)\s*(/\s*[\d.]+)?\)'
result = re.sub(pattern, replace_hsl_var, content)

with open('/home/z/my-project/src/app/globals.css', 'w') as f:
    f.write(result)

print(f'Done. Remaining hsl(var(: {result.count("hsl(var(")}')