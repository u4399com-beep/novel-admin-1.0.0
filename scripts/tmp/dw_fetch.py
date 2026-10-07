#!/usr/bin/env python3
"""Fetch multiple dwxwc pages in one WAF-validated session.
Usage: dw_fetch.py <outfile1=url1> <outfile2=url2> ... [proxy]
Tries each URL in a single session; solves captcha once if needed.
"""
import re, sys, subprocess, urllib.parse
import requests

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
HDRS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.dwxwc.com/',
}


def ocr(path):
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


def get_retry(s, url, tries=4):
    last = None
    for i in range(tries):
        try:
            return s.get(url, timeout=40)
        except Exception as e:
            last = e
            import time
            time.sleep(3 * (i + 1))
    raise last


def validate(s, url):
    """Ensure session passes WAF; solve captcha if challenged. Returns True if ok."""
    r = get_retry(s, url)
    for attempt in range(8):
        if 'GOEDGE_WAF_CAPTCHA_ID' not in r.text:
            return r
        cid = re.search(r'name="GOEDGE_WAF_CAPTCHA_ID" value="([^"]+)"', r.text).group(1)
        img_url = urllib.parse.urljoin(url, re.search(r'src="(/WAF/[^"]+)"', r.text).group(1))
        ir = get_retry(s, img_url)
        open('/tmp/dw_captcha.png', 'wb').write(ir.content)
        cands = ocr('/tmp/dw_captcha.png')
        print(f'  [waf] attempt {attempt}: cands={cands}', flush=True)
        if not cands:
            r = get_retry(s, url)
            continue
        for code in cands:
            try:
                pr = s.post(url, data={'GOEDGE_WAF_CAPTCHA_ID': cid, 'GOEDGE_WAF_CAPTCHA_CODE': code},
                            timeout=40, allow_redirects=True)
            except Exception:
                import time; time.sleep(3); continue
            if 'GOEDGE_WAF_CAPTCHA_ID' not in pr.text:
                print('  [waf] SOLVED', flush=True)
                return pr
        r = get_retry(s, url)
    raise RuntimeError('WAF captcha not solved')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('proxy')]
    use_proxy = any(a == 'proxy' for a in sys.argv[1:])
    s = requests.Session()
    s.headers.update(HDRS)
    if use_proxy:
        s.proxies.update({'http': 'http://101.206.186.99:8080', 'https': 'http://101.206.186.99:8080'})
    first_url = list(a.split('=', 1)[1] for a in args)[0]
    validate(s, first_url)
    for pair in args:
        out, url = pair.split('=', 1)
        try:
            r = get_retry(s, url)
            if 'GOEDGE_WAF_CAPTCHA_ID' in r.text:
                print(f'  re-challenged on {url}, re-solving', flush=True)
                r = validate(s, url)
            open(out, 'w', encoding='utf-8', errors='replace').write(r.text)
            t = re.search(r'<title>([^<]*)', r.text)
            print(f'{url} -> {out} status={r.status_code} bytes={len(r.text)} title={t.group(1) if t else "?"}', flush=True)
        except Exception as e:
            print(f'{url} -> FAIL {e}', flush=True)
    print('COOKIES=' + urllib.parse.urlencode(dict(s.cookies)))


if __name__ == '__main__':
    main()
