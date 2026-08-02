/**
 * Sanitize a string for safe storage and display
 */
export function sanitizeString(input: unknown, maxLength: number = 10000): string {
  if (typeof input !== 'string') return '';
  // Remove null bytes and control characters except newline/tab
  let sanitized = input.replace(/[\x00-\x08\x0b\x0c\x0d\x0e-\x1f\x7f]/g, '');
  // Remove dangerous Unicode characters: zero-width spaces, bidi overrides, BOM
  sanitized = sanitized.replace(/[\u200B-\u200F\u2060-\u2069\uFEFF\u202A-\u202E]/g, '');
  // Trim and limit length
  sanitized = sanitized.trim().slice(0, maxLength);
  return sanitized;
}

/**
 * Validate a URL is safe (SSRF protection).
 * Blocks:
 * - Non-http/https protocols (file://, ftp://, data:, javascript:)
 * - DNS tunneling services (nip.io, sslip.io, etc.)
 * - Internal hostnames (localhost, .local, .internal)
 * - Private IPv4 ranges (0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16)
 * - IPv4 multicast (224.0.0.0/4)
 * - IPv6 loopback, link-local, ULA, multicast
 * - IPv6-mapped IPv4 (::ffff:x.x.x.x)
 * - Octal/hex/decimal IP representations
 * - Trailing dot in hostnames (e.g., "localhost.")
 * - Numeric IP in hostname (pure digits+dots pattern)
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    // Strip trailing dot (e.g., "example.com." is valid DNS but can bypass checks)
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');

    // Block DNS tunneling services (nip.io, sslip.io, etc.)
    const DNS_TUNNEL_SUFFIXES = [
      '.nip.io', '.sslip.io', '.dns.army', '.dnsdojo.net', '.xip.io',
      '.localtest.me', '.vcap.me', '.lvh.me', '.fuf.me', '.encr.app',
    ];
    if (DNS_TUNNEL_SUFFIXES.some(s => hostname.endsWith(s))) {
      return false;
    }

    // Block common internal hostnames
    if (['localhost', 'localhost.localdomain'].includes(hostname)) {
      return false;
    }

    // Block metadata endpoints
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return false;
    }

    // Block if hostname is a parseable IP address (IPv4 or IPv6)
    const ipAddress = parseIpAddress(hostname);
    if (ipAddress) {
      return !isPrivateIp(ipAddress);
    }

    // Block octal IP representations (e.g., 0177.0.0.1, 077.0.0.x)
    if (/^0[0-7]+(\.|$)/.test(hostname)) {
      return false;
    }

    // Block hex IP representations (e.g., 0x7f.0.0.1, 0xc0a80001)
    if (/^0x[0-9a-f]+(\.|$)/i.test(hostname)) {
      return false;
    }

    // Block decimal IP representations (e.g., 2130706433)
    if (/^\d{7,}$/.test(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Parse hostname to extract IP address (handles IPv6 brackets)
 */
function parseIpAddress(hostname: string): string | null {
  // Handle IPv6 with brackets like [::1]
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }

  // Handle IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return hostname;
  }

  // Handle IPv6 without brackets
  if (hostname.includes(':')) {
    return hostname;
  }

  return null;
}

/**
 * Check if an IP address is private/internal/reserved
 */
function isPrivateIp(ip: string): boolean {
  // Normalize: remove IPv6 prefix and brackets
  let normalizedIp = ip.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');

  // IPv4 checks
  const ipv4Match = normalizedIp.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    // 0.0.0.0/8
    if (a === 0) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local / AWS metadata)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 224.0.0.0/4 (multicast)
    if (a >= 224) return true;
    return false;
  }

  // IPv6 checks — normalize expanded form before comparing
  function expandIPv6(ip: string): string {
    if (!ip.includes('::')) return ip.toLowerCase();
    const halves = ip.split('::', 2);
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const full = [...left, ...Array(missing).fill('0000'), ...right];
    return full.map(s => s.toLowerCase().padStart(4, '0')).join(':');
  }

  const expanded = expandIPv6(normalizedIp);
  // Loopback (::1 and 0:0:0:0:0:0:0:1)
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001' ||
      expanded === '0000:0000:0000:0000:0000:0000:0000:0000') return true;
  // Link-local fe80::/10
  if (expanded.startsWith('fe80:')) return true;
  // Unique local fc00::/7 (fc00-fdff)
  if (expanded.startsWith('fc') || expanded.startsWith('fd')) return true;
  // Multicast ff00::/8
  if (expanded.startsWith('ff')) return true;

  return false;
}