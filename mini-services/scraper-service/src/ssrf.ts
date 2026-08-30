/**
 * Unified SSRF protection for the scraper-service.
 *
 * This is a self-contained copy of the canonical isSafeUrl implementation
 * from src/lib/sanitize.ts (the Next.js project cannot be imported from here
 * since this is a separate bun project).
 *
 * Single source of truth: src/lib/sanitize.ts
 */

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

    // Block common internal hostnames (including IPv6 loopback variants)
    if (['localhost', 'localhost.localdomain', 'localhost6', 'localhost6.localdomain6', 'ip6-localhost', 'ip6-loopback'].includes(hostname)) {
      return false;
    }

    // Block metadata endpoints and reserved TLDs (RFC 6761)
    if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
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

    // Block pure numeric hostnames (e.g., "0", "1" resolve to 0.0.0.0/0.0.0.1 on Linux)
    if (/^\d+$/.test(hostname)) {
      return false;
    }

    // Block short digit-dot patterns that may be parsed as IPs (e.g., "0.0", "127.1")
    if (/^\d(\.\d+)*$/.test(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// TODO: DNS Rebinding Protection
// Current limitation: isSafeUrl() validates the hostname at call time, but DNS rebinding
// attacks use a domain that resolves to a public IP on the first lookup (passing this check)
// then resolves to an internal IP (e.g., 127.0.0.1) on the actual HTTP request.
// A full fix requires resolving the domain to IP AFTER this check passes, then verifying
// the resolved IP is still safe immediately before the HTTP request is made.
// This is non-trivial in this service because: (1) the actual fetch happens in engines
// that may use different DNS resolvers (e.g., system vs Playwright's), and (2) DNS TTL
// caching means the second lookup may return the same result as the first within the TTL window.
// For now, the risk is partially mitigated by: blocking DNS tunneling services, blocking
// numeric hostnames, and the fact that most scraping targets are long-lived domains
// unlikely to be used for DNS rebinding.

/**
 * Parse hostname to extract IP address.
 */
function parseIpAddress(hostname: string): string | null {
  // Handle IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return hostname;
  }

  // Handle IPv6 (with and without IPv4-mapped suffix)
  if (hostname.includes(':')) {
    // IPv4-mapped IPv6 in dotted-decimal: ::ffff:127.0.0.1 or ::127.0.0.1
    // The IPv6 regex below only allows hex+colon, so detect dotted-decimal first
    const v4MappedMatch = hostname.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4MappedMatch) {
      return v4MappedMatch[1]; // Return the IPv4 part for isPrivateIp() check
    }
    if (/^[0-9a-fA-F:]+$/.test(hostname) && (hostname.match(/:/g) || []).length >= 2) {
      return hostname;
    }
    return null;
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
    const [, a, b] = ipv4Match.map(Number) as [never, number, number, number, number];
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
    // 100.64.0.0/10 (CGNAT, RFC 6598)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 224.0.0.0/4 (multicast)
    if (a >= 224) return true;
    return false;
  }

  // IPv6 checks — expand then compare
  const expanded = expandIPv6(normalizedIp.toLowerCase());

  // Check for IPv4-mapped IPv6 (::ffff:x.x.x.x in expanded hex form)
  // e.g., 0000:0000:0000:0000:0000:ffff:7f00:0001 → 127.0.0.1
  const v4Mapped = expanded.match(/^0000:0000:0000:0000:0000:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/);
  if (v4Mapped) {
    const a = parseInt(v4Mapped[1], 16);
    const b = parseInt(v4Mapped[2], 16);
    const octets = [(a >> 8) & 0xff, a & 0xff, (b >> 8) & 0xff, b & 0xff];
    // Re-check as IPv4
    const [oa, ob] = octets;
    if (oa === 0) return true;
    if (oa === 10) return true;
    if (oa === 127) return true;
    if (oa === 169 && ob === 254) return true;
    if (oa === 172 && ob >= 16 && ob <= 31) return true;
    if (oa === 192 && ob === 168) return true;
    // CGNAT 100.64.0.0/10
    if (oa === 100 && ob >= 64 && ob <= 127) return true;
    if (oa >= 224) return true;
    return false;
  }

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

/**
 * Expand a compressed IPv6 address to full 8-group form for comparison.
 * Handles: ::1, ::ffff:127.0.0.1, 7f00:1, fe80::1, full 8-group addresses
 * e.g. "::1" → "0000:0000:0000:0000:0000:0000:0000:0001"
 */
function expandIPv6(ip: string): string {
  // IPv4-mapped IPv6 in hex form after ::ffff: stripping (e.g., "7f00:1")
  // Convert to dotted decimal first, then re-check via IPv4 path
  const groups = ip.split(':');

  if (ip.includes('::')) {
    const halves = ip.split('::', 2);
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const full = [...left, ...Array(missing).fill('0000'), ...right];
    return full.map(s => s.toLowerCase().padStart(4, '0')).join(':');
  }

  // Full 8-group IPv6 (e.g., 2001:0db8:...)
  if (groups.length === 8) {
    return groups.map(s => s.toLowerCase().padStart(4, '0')).join(':');
  }

  // Partial IPv6 without :: (e.g., "7f00:1" after ::ffff: stripping)
  // This can represent an IPv4-mapped address in hex
  if (groups.length >= 1 && groups.length <= 2) {
    // Try to interpret as hex-encoded IPv4
    const hexParts = groups.map(g => parseInt(g, 16));
    if (hexParts.every(n => !isNaN(n) && n >= 0 && n <= 0xffff)) {
      // Convert to 4 octets: pack hex groups into 32-bit, then extract bytes
      let num = 0;
      for (const h of hexParts) {
        num = (num << 16) | h;
      }
      // Normalize to 32-bit unsigned
      num = num >>> 0;
      const a = (num >>> 24) & 0xff;
      const b = (num >>> 16) & 0xff;
      const c = (num >>> 8) & 0xff;
      const d = num & 0xff;
      // Return as IPv4-mapped IPv6 in expanded form (use hex, not decimal!)
      return `0000:0000:0000:0000:0000:ffff:${a.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}:${c.toString(16).padStart(2,'0')}${d.toString(16).padStart(2,'0')}`;
    }
  }

  // Fallback: pad with trailing zeros
  const missing = 8 - groups.length;
  const full = [...groups, ...Array(Math.max(0, missing)).fill('0000')];
  return full.map(s => s.toLowerCase().padStart(4, '0')).join(':');
}