#!/usr/bin/env python3
"""Solve GoEdge WAF captcha on dwxwc.com and fetch a page with validated session.
Usage: dw_solve.py <url> <outfile> [proxy]
On success prints 'COOKIES=...' line (validated session cookie for curl reuse).
"""
import re, sys, subprocess, urllib.parse
import requests

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
HDRS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}
PROXIES = None
if len(sys.argv) > 3 and sys.argv[3] == 'proxy':
    PROXIES = {'http': 'http://101.206.186.99:8080', 'https': 'http://101.206.186.99:8080'}


def ocr(path):
    """Try tesseract with several preprocessing/psm combos."""
    from PIL import Image
    img = Image.open(path).convert('L')
    w, h = img.size
    img = img.resize((w * 3, h * 3), Image.LANCZOS)
    big = '/tmp/dw_captcha_big.png'
    img.save(big)
    cands = []
    for psm in (7, 8, 13, 6):
        for src in (big, path):
            try:
                out = subprocess.run(
                    ['tesseract', src, 'stdout', '--psm', str(psm),
                     '-c', 'tessedit_char_whitelist=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
                    capture_output=True, text=True, timeout=20)
                t = re.sub(r'[^0-9A-Za-z]', '', out.stdout)
                if 4 <= len(t) <= 6:
                    cands.append(t)
            except Exception:
                pass
    return list(dict.fromkeys(cands))


def solve_and_fetch(url, out):
    s = requests.Session()
    s.headers.update(HDRS)
    if PROXIES:
        s.proxies.update(PROXIES)
    for attempt in range(8):
        r = s.get(url, timeout=30)
        if 'GOEDGE_WAF_CAPTCHA_ID' not in r.text:
            open(out, 'w', encoding='utf-8', errors='replace').write(r.text)
            t = re.search(r'<title>([^<]*)', r.text)
            print(f'OK after {attempt} captcha attempts; status={r.status_code} bytes={len(r.text)} title={t.group(1) if t else "?"}')
            return True
        cid = re.search(r'name="GOEDGE_WAF_CAPTCHA_ID" value="([^"]+)"', r.text).group(1)
        img_url = urllib.parse.urljoin(url, re.search(r'src="(/WAF/[^"]+)"', r.text).group(1))
        ir = s.get(img_url, timeout=30)
        open('/tmp/dw_captcha.png', 'wb').write(ir.content)
        cands = ocr('/tmp/dw_captcha.png')
        print(f'attempt {attempt}: captcha_id={cid} ocr_cands={cands}', flush=True)
        if not cands:
            continue
        for code in cands:
            pr = s.post(url, data={'GOEDGE_WAF_CAPTCHA_ID': cid, 'GOEDGE_WAF_CAPTCHA_CODE': code},
                        timeout=30, allow_redirects=True)
            if 'GOEDGE_WAF_CAPTCHA_ID' not in pr.text:
                open(out, 'w', encoding='utf-8', errors='replace').write(pr.text)
                print(f'SOLVED with code={code}; status={pr.status_code} bytes={len(pr.text)}')
                print('COOKIES=' + urllib.parse.urlencode(dict(s.cookies)))
                return True
            print(f'  code={code} rejected', flush=True)
    return False


if __name__ == '__main__':
    sys.exit(0 if solve_and_fetch(sys.argv[1], sys.argv[2]) else 1)
