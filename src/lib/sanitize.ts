/**
 * Sanitize a string for safe storage and display
 */
export function sanitizeString(input: unknown, maxLength: number = 10000): string {
  if (typeof input !== 'string') return '';
  // Remove null bytes and control characters except newline/tab
  let sanitized = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // Remove dangerous Unicode characters: zero-width spaces, bidi overrides, BOM
  sanitized = sanitized.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, '');
  // Trim and limit length
  sanitized = sanitized.trim().slice(0, maxLength);
  return sanitized;
}

/**
 * Validate a URL is safe (SSRF protection).
 * Blocks:
 * - Non-http/https protocols (file://, ftp://, data:, javascript:)
 * - Private/internal IP addresses (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-local addresses (169.254.0.0/16, fe80::/10)
 * - Loopback addresses (::1, localhost)
 * - IPv6 mapped IPv4 (::ffff:127.0.0.1)
 * - 0.0.0.0/8
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block common internal hostnames
    if (['localhost', 'localhost.localdomain'].includes(hostname)) {
      return false;
    }

    // Block metadata endpoints
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return false;
    }

    // Block IP-based URLs - check for private/reserved ranges
    // Use URL parsing to handle IPv6 brackets
    const ipAddress = parseIpAddress(hostname);
    if (ipAddress) {
      return !isPrivateIp(ipAddress);
    }

    // For domain names, resolve and check? No - DNS rebinding makes this unreliable.
    // Just block known-dangerous patterns
    if (hostname === '0.0.0.0' || hostname === '0177.0.0.1' || hostname === '2130706433') {
      return false;
    }

    // Block if hostname looks like an IP (contains only digits and dots)
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
      const ip = hostname;
      return !isPrivateIp(ip);
    }

    // Block octal and hex IP representations
    if (/^0x[0-9a-f]+$/i.test(hostname) || /^0[0-7]+$/i.test(hostname)) {
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
  // Normalize: remove IPv6 prefix
  const normalizedIp = ip.replace(/^::ffff:/i, '');

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

  // IPv6 checks
  const lower = normalizedIp.toLowerCase();
  // Loopback
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped IPv6
  if (lower.startsWith('::ffff:')) return true;
  // Link-local fe80::/10
  if (lower.startsWith('fe80:')) return true;
  // Unique local fc00::/7
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Multicast ff00::/8
  if (lower.startsWith('ff')) return true;

  return false;
}