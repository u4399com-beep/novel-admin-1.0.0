/**
 * Proxy Connection Tester
 * Tests proxy connectivity by making a real HTTP request through the proxy
 * to a test endpoint (httpbin.org/ip by default).
 *
 * Supports HTTP, HTTPS, SOCKS5 proxies.
 * SOCKS4 is not supported (no compatible agent available).
 */

import { getProxyDispatcher } from './proxy-manager';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Dispatcher } from 'undici';

// ==================== Types ====================

export interface ProxyTestResult {
  url: string;
  protocol: string;
  host: string;
  port: number;
  reachable: boolean;
  responseTime: number;    // ms, 0 if unreachable
  statusCode?: number;
  error?: string;
  testUrl: string;
  testTimestamp: number;
}

// ==================== Implementation ====================

const DEFAULT_TEST_URL = 'http://httpbin.org/ip';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Test a single proxy connection by making an HTTP request through it.
 *
 * @param proxyUrl - Full proxy URL (e.g. "http://user:pass@host:port" or "socks5://host:port")
 * @param testUrl - URL to fetch through the proxy (default: httpbin.org/ip)
 * @param timeoutMs - Request timeout in ms (default: 10000)
 */
export async function testProxyConnection(
  proxyUrl: string,
  testUrl?: string,
  timeoutMs?: number,
): Promise<ProxyTestResult> {
  const resolvedTestUrl = testUrl || DEFAULT_TEST_URL;
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const timestamp = Date.now();

  // Parse the proxy URL to extract protocol/host/port
  let urlStr = proxyUrl.trim();
  let protocol = 'http';

  if (urlStr.startsWith('socks5://')) {
    protocol = 'socks5';
  } else if (urlStr.startsWith('socks4://')) {
    protocol = 'socks4';
  } else if (urlStr.startsWith('https://')) {
    protocol = 'https';
  } else if (urlStr.startsWith('http://')) {
    protocol = 'http';
  } else {
    urlStr = 'http://' + urlStr;
    protocol = 'http';
  }

  // Extract host and port
  let host = '';
  let port = 0;
  try {
    const parsed = new URL(urlStr);
    host = parsed.hostname;
    port = parseInt(parsed.port, 10) || (protocol === 'https' ? 443 : protocol === 'http' ? 80 : 1080);
  } catch {
    return {
      url: proxyUrl,
      protocol,
      host: '',
      port: 0,
      reachable: false,
      responseTime: 0,
      error: `Invalid proxy URL: ${proxyUrl}`,
      testUrl: resolvedTestUrl,
      testTimestamp: timestamp,
    };
  }

  // SOCKS4 is not supported
  if (protocol === 'socks4') {
    return {
      url: proxyUrl,
      protocol,
      host,
      port,
      reachable: false,
      responseTime: 0,
      error: 'SOCKS4 not supported',
      testUrl: resolvedTestUrl,
      testTimestamp: timestamp,
    };
  }

  // Get the appropriate dispatcher/agent for the proxy
  let dispatcher: Dispatcher | null = null;

  try {
    if (protocol === 'socks5') {
      // Use socks-proxy-agent directly for SOCKS5
      const agent = new SocksProxyAgent(urlStr);
      dispatcher = agent as unknown as Dispatcher;
    } else {
      // HTTP/HTTPS: use the proxy-manager's cached dispatcher
      dispatcher = getProxyDispatcher(proxyUrl);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      url: proxyUrl,
      protocol,
      host,
      port,
      reachable: false,
      responseTime: 0,
      error: `Failed to create proxy agent: ${errMsg}`,
      testUrl: resolvedTestUrl,
      testTimestamp: timestamp,
    };
  }

  if (!dispatcher) {
    return {
      url: proxyUrl,
      protocol,
      host,
      port,
      reachable: false,
      responseTime: 0,
      error: 'Could not create dispatcher for proxy',
      testUrl: resolvedTestUrl,
      testTimestamp: timestamp,
    };
  }

  // Perform the test request
  const startTime = Date.now();
  try {
    const response = await fetch(resolvedTestUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
      // @ts-expect-error - Bun supports dispatcher option
      dispatcher,
    });

    const elapsed = Date.now() - startTime;
    const body = await response.text();

    // Check if the response is valid JSON (expected from httpbin.org/ip)
    let isValid = response.ok;
    try {
      const parsed = JSON.parse(body);
      // httpbin.org/ip returns { origin: "ip" }
      if (parsed.origin && typeof parsed.origin === 'string') {
        isValid = true;
      }
    } catch {
      // Not JSON, but if status is 200 it's still "reachable"
      if (response.ok) isValid = true;
    }

    return {
      url: proxyUrl,
      protocol,
      host,
      port,
      reachable: isValid,
      responseTime: elapsed,
      statusCode: response.status,
      testUrl: resolvedTestUrl,
      testTimestamp: timestamp,
    };
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);

    // Common errors
    let errorDetail = errMsg;
    if (errMsg.includes('timed out') || errMsg.includes('Timeout')) {
      errorDetail = 'Connection timed out';
    } else if (errMsg.includes('ECONNREFUSED') || errMsg.includes('Connection refused')) {
      errorDetail = 'Connection refused';
    } else if (errMsg.includes('ENETUNREACH') || errMsg.includes('Network unreachable')) {
      errorDetail = 'Network unreachable';
    } else if (errMsg.includes('SOCKS') || errMsg.includes('socks')) {
      errorDetail = `SOCKS proxy error: ${errMsg}`;
    } else if (errMsg.includes('407') || errMsg.includes('Proxy Authentication')) {
      errorDetail = 'Proxy authentication required';
    }

    return {
      url: proxyUrl,
      protocol,
      host,
      port,
      reachable: false,
      responseTime: elapsed,
      error: errorDetail,
      testUrl: resolvedTestUrl,
      testTimestamp: timestamp,
    };
  }
}

/**
 * Test multiple proxies in parallel with concurrency control.
 *
 * @param proxyUrls - Array of proxy URLs to test
 * @param testUrl - URL to fetch through each proxy
 * @param timeoutMs - Per-request timeout in ms
 * @param maxConcurrent - Max parallel tests (default: 5)
 */
export async function testMultipleProxies(
  proxyUrls: string[],
  testUrl?: string,
  timeoutMs?: number,
  maxConcurrent: number = 5,
): Promise<ProxyTestResult[]> {
  const results: ProxyTestResult[] = [];

  // Process in batches
  for (let i = 0; i < proxyUrls.length; i += maxConcurrent) {
    const batch = proxyUrls.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(
      batch.map(url => testProxyConnection(url, testUrl, timeoutMs)),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        // Should not happen since testProxyConnection catches all errors,
        // but handle it just in case
        results.push({
          url: 'unknown',
          protocol: 'unknown',
          host: '',
          port: 0,
          reachable: false,
          responseTime: 0,
          error: result.reason?.message || 'Unknown error',
          testUrl: testUrl || DEFAULT_TEST_URL,
          testTimestamp: Date.now(),
        });
      }
    }
  }

  return results;
}
