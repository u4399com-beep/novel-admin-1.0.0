/**
 * Fingerprint Test Module - Playwright & Obscura stealth quality assessment
 *
 * Evaluates browser fingerprints against comprehensive detection checks to measure
 * how well each engine evades bot/fingerprinting services. Each check is isolated
 * in its own try-catch so a single failure doesn't break the entire test.
 */

// ==================== Type Definitions ====================

export interface FingerprintCheck {
  category: string;
  name: string;
  passed: boolean;
  value: string;
  expected: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface FingerprintTestResult {
  testUrl: string;
  engine: string;
  timestamp: string;
  checks: FingerprintCheck[];
  overallScore: number; // 0-100, 100 = fully stealthy
  issues: string[];
}

// ==================== Constants ====================

/** Default test URL — navigated to before evaluation. Falls back to about:blank. */
const DEFAULT_TEST_URL = 'about:blank';

/**
 * Weighted scoring buckets.
 * Each category gets its own point pool; a category's score is (passedChecks / totalChecks) * maxPoints.
 * Sum of all maxPoints = 100.
 */
const CATEGORY_WEIGHTS: Record<string, number> = {
  webdriver: 20,
  webgl: 15,
  chrome_object: 10,
  navigator: 15,
  screen: 10,
  canvas: 10,
  audio: 5,
  webrtc: 5,
  headless_indicators: 10,
};

const TOTAL_POINTS = Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0); // 100

// ==================== Detection Script (evaluated inside browser) ====================

/**
 * Comprehensive fingerprint detection script. Returns an array of raw check objects.
 * Every check is wrapped in try-catch to ensure isolation.
 */
const FINGERPRINT_DETECTION_SCRIPT = `
(() => {
  const results = [];

  // Helper: push a check result
  function add(category, name, passed, value, expected, severity) {
    results.push({ category, name, passed, value: String(value), expected: String(expected), severity });
  }

  // ===================== NAVIGATOR =====================
  try {
    const ua = navigator.userAgent;
    const hasChromeInUA = /Chrome\//.test(ua) && !/HeadlessChrome/.test(ua);
    add('navigator', 'userAgent consistency', hasChromeInUA, ua, 'Contains Chrome (not HeadlessChrome)', 'high');
  } catch (e) { add('navigator', 'userAgent consistency', false, 'Error: ' + e.message, 'Valid Chrome UA string', 'high'); }

  try {
    const plat = navigator.platform || '';
    const ua = navigator.userAgent || '';
    let consistent = false;
    if (/Win/.test(plat) && /Windows/.test(ua)) consistent = true;
    if (/Mac/.test(plat) && /Macintosh/.test(ua)) consistent = true;
    if (/Linux/.test(plat) && /Linux/.test(ua) && !/Android/.test(ua)) consistent = true;
    add('navigator', 'platform/UA consistency', consistent, plat + ' (UA: ' + (navigator.userAgent||'').substring(0,60) + ')', 'Platform matches UA OS', 'high');
  } catch (e) { add('navigator', 'platform/UA consistency', false, 'Error: ' + e.message, 'Consistent platform', 'high'); }

  try {
    const lang = navigator.language;
    const langs = navigator.languages;
    const hasLang = typeof lang === 'string' && lang.length >= 2;
    const hasLangs = Array.isArray(langs) && langs.length > 0;
    add('navigator', 'language', hasLang && hasLangs, lang + ' / ' + JSON.stringify(langs), 'Non-empty language + languages array', 'medium');
  } catch (e) { add('navigator', 'language', false, 'Error: ' + e.message, 'Valid language strings', 'medium'); }

  try {
    const hc = navigator.hardwareConcurrency;
    const valid = typeof hc === 'number' && hc >= 2 && hc <= 128;
    add('navigator', 'hardwareConcurrency', valid, String(hc), '2-128 (realistic CPU core count)', 'medium');
  } catch (e) { add('navigator', 'hardwareConcurrency', false, 'Error: ' + e.message, 'Realistic core count', 'medium'); }

  try {
    const dm = navigator.deviceMemory;
    const valid = dm === undefined || (typeof dm === 'number' && dm >= 2 && dm <= 32);
    add('navigator', 'deviceMemory', valid, String(dm), '2-32 GB or undefined', 'low');
  } catch (e) { add('navigator', 'deviceMemory', false, 'Error: ' + e.message, 'Realistic memory value', 'low'); }

  try {
    const mt = navigator.maxTouchPoints;
    const valid = typeof mt === 'number' && mt >= 0;
    add('navigator', 'maxTouchPoints', valid, String(mt), 'Non-negative number', 'low');
  } catch (e) { add('navigator', 'maxTouchPoints', false, 'Error: ' + e.message, 'Valid touch points', 'low'); }

  try {
    const plugins = navigator.plugins;
    const count = plugins ? plugins.length : 0;
    // Real Chrome typically has 5 plugins (PDF Viewer, etc.)
    const pass = count === 5;
    add('navigator', 'plugins count', pass, String(count), '5 plugins', 'high');
  } catch (e) { add('navigator', 'plugins count', false, 'Error: ' + e.message, '5 plugins', 'high'); }

  try {
    const plugins = navigator.plugins;
    const hasPDF = plugins && (() => { for (let i = 0; i < plugins.length; i++) { if (plugins[i].name.includes('PDF')) return true; } return false; })();
    add('navigator', 'plugins PDF Viewer', !!hasPDF, String(hasPDF), 'PDF Viewer plugin present', 'medium');
  } catch (e) { add('navigator', 'plugins PDF Viewer', false, 'Error: ' + e.message, 'PDF Viewer plugin', 'medium'); }

  try {
    const mimes = navigator.mimeTypes;
    const count = mimes ? mimes.length : 0;
    const valid = count >= 10;
    add('navigator', 'mimeTypes count', valid, String(count), '>= 10 mimeTypes', 'medium');
  } catch (e) { add('navigator', 'mimeTypes count', false, 'Error: ' + e.message, '>= 10 mimeTypes', 'medium'); }

  // ===================== WEBDRIVER =====================
  try {
    const wd = navigator.webdriver;
    const pass = wd === undefined || wd === false;
    add('webdriver', 'navigator.webdriver', pass, String(wd), 'undefined or false', 'critical');
  } catch (e) { add('webdriver', 'navigator.webdriver', false, 'Error: ' + e.message, 'undefined or false', 'critical'); }

  // ===================== SCREEN =====================
  try {
    const sw = screen.width;
    const sh = screen.height;
    const aw = screen.availWidth;
    const ah = screen.availHeight;
    const consistent = sw >= aw && sh >= ah && sw > 0 && sh > 0;
    add('screen', 'screen dimensions', consistent, sw + 'x' + sh + ' (avail: ' + aw + 'x' + ah + ')', 'availWidth <= width, availHeight <= height', 'high');
  } catch (e) { add('screen', 'screen dimensions', false, 'Error: ' + e.message, 'Consistent screen dimensions', 'high'); }

  try {
    const cd = screen.colorDepth;
    const pd = screen.pixelDepth;
    const valid = cd === 24 && pd === 24;
    add('screen', 'colorDepth/pixelDepth', valid, cd + '/' + pd, '24/24 (typical)', 'medium');
  } catch (e) { add('screen', 'colorDepth/pixelDepth', false, 'Error: ' + e.message, '24/24', 'medium'); }

  try {
    const ow = window.outerWidth;
    const oh = window.outerHeight;
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    const reasonable = ow >= iw && oh >= ih && ow > 0 && oh > 0 && iw > 0 && ih > 0;
    add('screen', 'outer/inner dimensions', reasonable, 'outer: ' + ow + 'x' + oh + ' inner: ' + iw + 'x' + ih, 'outer >= inner, all positive', 'medium');
  } catch (e) { add('screen', 'outer/inner dimensions', false, 'Error: ' + e.message, 'Consistent window dimensions', 'medium'); }

  // ===================== WEBGL =====================
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      add('webgl', 'WebGL support', false, 'No WebGL context', 'WebGL context available', 'high');
    } else {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const isSwiftShader = /SwiftShader/i.test(renderer);
      const isGoogleInc = vendor === 'Google Inc.' && isSwiftShader;
      add('webgl', 'vendor/renderer (not SwiftShader)', !isSwiftShader, vendor + ' / ' + renderer, 'Real GPU (not SwiftShader)', 'critical');
    }
  } catch (e) { add('webgl', 'vendor/renderer (not SwiftShader)', false, 'Error: ' + e.message, 'Real GPU renderer', 'critical'); }

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      add('webgl', 'WebGL2 support', false, 'No WebGL2 context', 'WebGL2 context available', 'medium');
    } else {
      add('webgl', 'WebGL2 support', true, 'available', 'WebGL2 context available', 'medium');
    }
  } catch (e) { add('webgl', 'WebGL2 support', false, 'Error: ' + e.message, 'WebGL2 context available', 'medium'); }

  // ===================== CANVAS =====================
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(50, 0, 100, 50);
    ctx.fillStyle = '#069';
    ctx.fillText('Fingerprint test 🧪', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('Fingerprint test 🧪', 4, 17);
    const fp1 = canvas.toDataURL();
    const fp2 = canvas.toDataURL();
    const nonEmpty = fp1.length > 100;
    const consistent = fp1 === fp2;
    add('canvas', 'toDataURL non-empty', nonEmpty, fp1.substring(0, 80) + '...', 'Non-empty data URL (>100 chars)', 'high');
    add('canvas', 'toDataURL consistency', consistent && nonEmpty, consistent ? 'match' : 'mismatch', 'Identical across calls', 'high');
  } catch (e) { add('canvas', 'toDataURL non-empty', false, 'Error: ' + e.message, 'Non-empty data URL', 'high'); }

  // ===================== AUDIO =====================
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      add('audio', 'AudioContext creation', false, 'AudioContext not available', 'AudioContext available', 'medium');
    } else {
      const actx = new AudioCtx();
      const analyser = actx.createAnalyser();
      const bufLen = analyser.frequencyBinCount;
      const data = new Float32Array(bufLen);
      // Create a short oscillator to generate audio data
      const osc = actx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      const gain = actx.createGain();
      gain.gain.value = 0; // silent
      osc.connect(gain);
      gain.connect(analyser);
      osc.start();
      // Let it run briefly, then capture
      osc.stop(actx.currentTime + 0.05);
      add('audio', 'AudioContext creation', true, 'AudioContext created', 'AudioContext available', 'medium');
    }
  } catch (e) { add('audio', 'AudioContext creation', false, 'Error: ' + e.message, 'AudioContext available', 'medium'); }

  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      add('audio', 'AudioContext getFloatFrequencyData', false, 'AudioContext not available', 'Non-zero frequency data', 'low');
    } else {
      const actx = new AudioCtx();
      const analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      const bufLen = analyser.frequencyBinCount;
      const data = new Float32Array(bufLen);
      const osc = actx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      const gain = actx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(analyser);
      analyser.connect(actx.destination);
      osc.start();
      setTimeout(() => { osc.stop(); actx.close(); }, 100);
      analyser.getFloatFrequencyData(data);
      const hasNonZero = data.some(v => v !== 0 && !isNaN(v));
      add('audio', 'AudioContext getFloatFrequencyData', hasNonZero, 'nonZero: ' + hasNonZero, 'Non-zero frequency data values', 'low');
    }
  } catch (e) { add('audio', 'AudioContext getFloatFrequencyData', false, 'Error: ' + e.message, 'Non-zero frequency data', 'low'); }

  // ===================== WEBRTC =====================
  try {
    if (!window.RTCPeerConnection) {
      add('webrtc', 'WebRTC local IP leak', true, 'RTCPeerConnection not available', 'No internal IP leak (N/A)', 'medium');
    } else {
      // Attempt to create an RTCPeerConnection and check for local candidates
      // In headless, we can't actually get IPs, but we check the API exists and doesn't leak
      const pc = new RTCPeerConnection({ iceServers: [] });
      let leakedIps = [];
      pc.createDataChannel('');
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          const parts = e.candidate.candidate.split(' ');
          const ip = parts[4];
          if (ip && /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(ip)) {
            leakedIps.push(ip);
          }
        }
      };
      pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => {});
      // We can't easily await ICE candidates synchronously, so just check the API shape
      const hasCreateOffer = typeof pc.createOffer === 'function';
      const hasCreateDataChannel = typeof pc.createDataChannel === 'function';
      const apiOk = hasCreateOffer && hasCreateDataChannel;
      add('webrtc', 'WebRTC API available', apiOk, 'RTCPeerConnection API intact', 'RTCPeerConnection API functional', 'low');
      pc.close();
    }
  } catch (e) { add('webrtc', 'WebRTC API available', false, 'Error: ' + e.message, 'RTCPeerConnection API functional', 'low'); }

  // ===================== CHROME OBJECT =====================
  try {
    const hasChrome = !!window.chrome;
    const hasRuntime = hasChrome && !!window.chrome.runtime;
    const hasCsi = hasChrome && typeof window.chrome.csi === 'function';
    const hasLoadTimes = hasChrome && typeof window.chrome.loadTimes === 'function';
    const pass = hasChrome && hasRuntime;
    add('chrome_object', 'window.chrome exists', hasChrome, String(hasChrome), 'true', 'high');
    add('chrome_object', 'window.chrome.runtime', hasRuntime, String(hasRuntime), 'true', 'critical');
    add('chrome_object', 'window.chrome.csi', hasCsi, String(hasCsi), 'function', 'medium');
    add('chrome_object', 'window.chrome.loadTimes', hasLoadTimes, String(hasLoadTimes), 'function', 'medium');
  } catch (e) { add('chrome_object', 'window.chrome exists', false, 'Error: ' + e.message, 'true', 'high'); }

  // ===================== PERMISSIONS =====================
  try {
    if (!navigator.permissions) {
      add('navigator', 'permissions API', false, 'navigator.permissions not available', 'permissions API available', 'medium');
    } else {
      const result = navigator.permissions.query({ name: 'notifications' });
      if (result && typeof result.then === 'function') {
        result.then(() => {
          add('navigator', 'permissions query (notifications)', true, 'resolved', 'Resolves (not rejects)', 'medium');
        }).catch(() => {
          add('navigator', 'permissions query (notifications)', false, 'rejected', 'Resolves (not rejects)', 'medium');
        });
      } else {
        add('navigator', 'permissions query (notifications)', false, 'Not a Promise', 'Returns a Promise', 'medium');
      }
    }
  } catch (e) { add('navigator', 'permissions query (notifications)', false, 'Error: ' + e.message, 'Resolves (not rejects)', 'medium'); }

  try {
    if (!navigator.permissions) {
      // already reported above
    } else {
      const result = navigator.permissions.query({ name: 'geolocation' });
      if (result && typeof result.then === 'function') {
        result.then(() => {
          add('navigator', 'permissions query (geolocation)', true, 'resolved', 'Resolves (not rejects)', 'medium');
        }).catch(() => {
          add('navigator', 'permissions query (geolocation)', false, 'rejected', 'Resolves (not rejects)', 'medium');
        });
      }
    }
  } catch (e) { /* already captured */ }

  // ===================== HEADLESS INDICATORS =====================
  try {
    const nightmare = !!window.__nightmare;
    add('headless_indicators', 'window.__nightmare', !nightmare, String(nightmare), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.__nightmare', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const phantom = !!window._phantom;
    add('headless_indicators', 'window._phantom', !phantom, String(phantom), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window._phantom', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const callPhantom = typeof window.callPhantom === 'function';
    add('headless_indicators', 'window.callPhantom', !callPhantom, String(callPhantom), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.callPhantom', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const domAutomation = !!window.domAutomation;
    add('headless_indicators', 'window.domAutomation', !domAutomation, String(domAutomation), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.domAutomation', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const selenium = !!window._selenium;
    add('headless_indicators', 'window._selenium', !selenium, String(selenium), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window._selenium', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const wdEval = !!window.__webdriver_evaluate;
    add('headless_indicators', 'window.__webdriver_evaluate', !wdEval, String(wdEval), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.__webdriver_evaluate', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const driverEval = !!window.__driver_evaluate;
    add('headless_indicators', 'window.__driver_evaluate', !driverEval, String(driverEval), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.__driver_evaluate', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const wdScript = !!window.__webdriver_script_fn;
    add('headless_indicators', 'window.__webdriver_script_fn', !wdScript, String(wdScript), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.__webdriver_script_fn', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const wdScriptExecutor = !!window.__webdriver_script_executor;
    add('headless_indicators', 'window.__webdriver_script_executor', !wdScriptExecutor, String(wdScriptExecutor), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.__webdriver_script_executor', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const seleniumDriver = !!window.__selenium_unwrapped;
    add('headless_indicators', 'window.__selenium_unwrapped', !seleniumDriver, String(seleniumDriver), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.__selenium_unwrapped', true, 'Error (no property = good)', 'undefined', 'critical'); }

  try {
    const fxDriver = !!window.__fxdriver_unwrapped;
    add('headless_indicators', 'window.__fxdriver_unwrapped', !fxDriver, String(fxDriver), 'undefined', 'critical');
  } catch (e) { add('headless_indicators', 'window.__fxdriver_unwrapped', true, 'Error (no property = good)', 'undefined', 'critical'); }

  // ===================== PERFORMANCE TIMING =====================
  try {
    const navStart = performance.timing?.navigationStart;
    const timeOrigin = performance.timeOrigin;
    if (navStart && timeOrigin) {
      const diff = Math.abs(navStart - timeOrigin);
      const close = diff < 1000;
      add('navigator', 'performance timing consistency', close, 'diff: ' + diff + 'ms (navStart: ' + navStart + ', timeOrigin: ' + Math.round(timeOrigin) + ')', '< 1000ms difference', 'low');
    } else {
      add('navigator', 'performance timing consistency', false, 'navStart: ' + navStart + ', timeOrigin: ' + timeOrigin, 'Both values present', 'low');
    }
  } catch (e) { add('navigator', 'performance timing consistency', false, 'Error: ' + e.message, 'Both values present and close', 'low'); }

  // ===================== SharedArrayBuffer / crossOriginIsolated =====================
  try {
    const hasSAB = typeof SharedArrayBuffer !== 'undefined';
    const coIsolated = window.crossOriginIsolated;
    // If SAB exists, crossOriginIsolated should be true; if not, both should be false
    const consistent = (hasSAB && coIsolated) || (!hasSAB && !coIsolated);
    add('navigator', 'SharedArrayBuffer/crossOriginIsolated', consistent, 'SAB: ' + hasSAB + ', crossOriginIsolated: ' + coIsolated, 'Consistent SAB/crossOriginIsolated', 'low');
  } catch (e) { add('navigator', 'SharedArrayBuffer/crossOriginIsolated', false, 'Error: ' + e.message, 'Consistent SAB/crossOriginIsolated', 'low'); }

  // ===================== OffscreenCanvas =====================
  try {
    const hasOC = typeof OffscreenCanvas !== 'undefined';
    const hasTransfer = hasOC && typeof (new OffscreenCanvas(1, 1)).transferToImageBitmap === 'function';
    add('navigator', 'OffscreenCanvas transferToImageBitmap', hasTransfer, String(hasTransfer), 'true (OffscreenCanvas supports transferToImageBitmap)', 'low');
  } catch (e) { add('navigator', 'OffscreenCanvas transferToImageBitmap', false, 'Error: ' + e.message, 'true', 'low'); }

  // ===================== MediaDevices =====================
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      add('navigator', 'mediaDevices.enumerateDevices', false, 'API not available', 'Returns device list with audioinput/videoinput/audiooutput', 'medium');
    } else {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const hasAudioIn = devices.some(d => d.kind === 'audioinput');
        const hasVideoIn = devices.some(d => d.kind === 'videoinput');
        const hasAudioOut = devices.some(d => d.kind === 'audiooutput');
        const pass = hasAudioIn && hasVideoIn && hasAudioOut;
        add('navigator', 'mediaDevices.enumerateDevices', pass,
          'audioinput: ' + hasAudioIn + ', videoinput: ' + hasVideoIn + ', audiooutput: ' + hasAudioOut + ' (total: ' + devices.length + ')',
          'At least audioinput + videoinput + audiooutput', 'medium');
      }).catch(err => {
        add('navigator', 'mediaDevices.enumerateDevices', false, 'Error: ' + err.message, 'At least audioinput + videoinput + audiooutput', 'medium');
      });
    }
  } catch (e) { add('navigator', 'mediaDevices.enumerateDevices', false, 'Error: ' + e.message, 'At least audioinput + videoinput + audiooutput', 'medium'); }

  // ===================== Connection =====================
  try {
    const conn = navigator.connection;
    const hasConn = !!conn;
    const hasRtt = hasConn && typeof conn.rtt === 'number';
    const hasDownlink = hasConn && typeof conn.downlink === 'number';
    const hasType = hasConn && typeof conn.effectiveType === 'string';
    const pass = hasConn && hasRtt && hasDownlink && hasType;
    add('navigator', 'navigator.connection', pass,
      hasConn ? 'rtt: ' + conn.rtt + ', downlink: ' + conn.downlink + ', effectiveType: ' + conn.effectiveType : 'not available',
      'Connection with rtt, downlink, effectiveType', 'medium');
  } catch (e) { add('navigator', 'navigator.connection', false, 'Error: ' + e.message, 'Connection API with rtt/downlink/effectiveType', 'medium'); }

  return results;
})()
`;

// ==================== Score Calculation ====================

function calculateScore(checks: FingerprintCheck[]): number {
  // Group checks by category
  const byCategory = new Map<string, FingerprintCheck[]>();
  for (const check of checks) {
    const cat = check.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(check);
  }

  let totalScore = 0;
  for (const [category, catChecks] of byCategory) {
    const maxPoints = CATEGORY_WEIGHTS[category] ?? 0;
    if (catChecks.length === 0) continue;
    const passedCount = catChecks.filter(c => c.passed).length;
    const ratio = passedCount / catChecks.length;
    totalScore += ratio * maxPoints;
  }

  // Normalize to 0-100 in case not all categories are present
  const maxPossible = Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0);
  return Math.round((totalScore / maxPossible) * 100);
}

function extractIssues(checks: FingerprintCheck[]): string[] {
  return checks
    .filter(c => !c.passed)
    .map(c => {
      const sev = c.severity.toUpperCase().padEnd(8);
      return `[${sev}] ${c.category}/${c.name}: got "${c.value}", expected "${c.expected}"`;
    });
}

// ==================== Browser Launch ====================

/**
 * Launch a Chromium browser via dynamic `import('playwright')`.
 * For 'obscura' engine, applies additional anti-detection Chrome flags.
 * Returns a disposable { browser, cleanup } handle.
 */
async function launchBrowser(
  engine: 'playwright' | 'obscura',
  options?: { proxy?: string; headless?: boolean },
): Promise<{ browser: import('playwright').Browser; cleanup: () => Promise<void> }> {
  const { chromium } = await import('playwright');
  const headless = options?.headless ?? true;

  const commonArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ];

  const obscuraExtraArgs = [
    '--disable-features=IsolateOrigins,site-per-process,VizDisplayCompositor,TranslateUI',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-ipc-flooding-protection',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--disable-print-preview',
    '--disable-reading-mode',
    '--disable-renderer-throttling',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--no-pings',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-infobars',
  ];

  const launchOptions: Record<string, unknown> = {
    headless,
    timeout: 30000,
    args: engine === 'obscura' ? [...commonArgs, ...obscuraExtraArgs] : commonArgs,
  };

  if (options?.proxy) {
    launchOptions.proxy = { server: options.proxy };
  }

  const browser = await chromium.launch(launchOptions);

  return {
    browser,
    cleanup: async () => {
      try { await browser.close(); } catch { /* already closed */ }
    },
  };
}

// ==================== Main Function ====================

/**
 * Run a comprehensive fingerprint stealth test against the specified engine.
 *
 * Launches a real Chromium instance via Playwright, navigates to the test URL,
 * and evaluates a comprehensive fingerprint detection script in the page context.
 * All checks are isolated with try-catch so one failure doesn't break the rest.
 *
 * @param engine  Which browser configuration to test
 * @param options Optional configuration overrides
 * @returns Detailed fingerprint test result with per-check pass/fail and overall score
 */
export async function runFingerprintTest(
  engine: 'playwright' | 'obscura',
  options?: { testUrl?: string; proxy?: string; headless?: boolean },
): Promise<FingerprintTestResult> {
  const testUrl = options?.testUrl ?? DEFAULT_TEST_URL;
  const cleanupRegistry: Array<() => Promise<void>> = [];

  try {
    // 1. Launch browser
    const { browser, cleanup } = await launchBrowser(engine, options);
    cleanupRegistry.push(cleanup);

    // 2. Create context and page
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: engine === 'obscura'
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        : undefined,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      screen: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    cleanupRegistry.push(async () => { try { await context.close(); } catch { /* ignore */ } });

    const page = await context.newPage();

    // 3. For obscura engine, attempt to import and apply the stealth script
    if (engine === 'obscura') {
      try {
        const { getStealthScript, getProfileForDomain } = await import('./stealth');
        const profile = getProfileForDomain('fingerprint-test.local');
        const stealthScript = getStealthScript(profile);
        await page.addInitScript(stealthScript);

        // Also update context to match the profile
        // (We already created context, so we can't change UA, but other settings are fine)
      } catch {
        // Stealth module not available — run without it (still tests raw Obscura args)
      }
    }

    // 4. Navigate to test URL
    try {
      await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {
      // Navigation may fail for about:blank or network issues — page context is still usable
    }

    // 5. Evaluate fingerprint detection script (synchronous checks only)
    const rawChecks = await page.evaluate((script: string) => {
      // eslint-disable-next-line no-eval
      return eval(script) as Array<Record<string, unknown>>;
    }, FINGERPRINT_DETECTION_SCRIPT);

    // For async checks, we need a second evaluation that collects from a global array.
    // We modify the approach: inject a global collector, then merge results.
    let asyncChecks: Array<Record<string, unknown>> = [];
    try {
      // Set up a global collector for async results
      await page.evaluate(() => {
        (window as any).__fpAsyncResults = [];
      });

      // Re-run just the async checks with the collector
      const asyncScript = `
(() => {
  const results = (window.__fpAsyncResults || []);
  function add(category, name, passed, value, expected, severity) {
    results.push({ category, name, passed, value: String(value), expected: String(expected), severity });
  }

  // Permissions - notifications
  try {
    if (navigator.permissions) {
      navigator.permissions.query({ name: 'notifications' }).then(() => {
        add('navigator', 'permissions query (notifications)', true, 'resolved', 'Resolves (not rejects)', 'medium');
      }).catch(() => {
        add('navigator', 'permissions query (notifications)', false, 'rejected', 'Resolves (not rejects)', 'medium');
      });
    }
  } catch(e) { add('navigator', 'permissions query (notifications)', false, 'Error: ' + e.message, 'Resolves (not rejects)', 'medium'); }

  // Permissions - geolocation
  try {
    if (navigator.permissions) {
      navigator.permissions.query({ name: 'geolocation' }).then(() => {
        add('navigator', 'permissions query (geolocation)', true, 'resolved', 'Resolves (not rejects)', 'medium');
      }).catch(() => {
        add('navigator', 'permissions query (geolocation)', false, 'rejected', 'Resolves (not rejects)', 'medium');
      });
    }
  } catch(e) {}

  // MediaDevices
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const hasAudioIn = devices.some(d => d.kind === 'audioinput');
        const hasVideoIn = devices.some(d => d.kind === 'videoinput');
        const hasAudioOut = devices.some(d => d.kind === 'audiooutput');
        const pass = hasAudioIn && hasVideoIn && hasAudioOut;
        add('navigator', 'mediaDevices.enumerateDevices', pass,
          'audioinput:' + hasAudioIn + ',videoinput:' + hasVideoIn + ',audiooutput:' + hasAudioOut + ' (total:' + devices.length + ')',
          'At least audioinput + videoinput + audiooutput', 'medium');
      }).catch(err => {
        add('navigator', 'mediaDevices.enumerateDevices', false, 'Error: ' + err.message, 'At least audioinput + videoinput + audiooutput', 'medium');
      });
    } else {
      add('navigator', 'mediaDevices.enumerateDevices', false, 'API not available', 'At least audioinput + videoinput + audiooutput', 'medium');
    }
  } catch(e) { add('navigator', 'mediaDevices.enumerateDevices', false, 'Error: ' + e.message, 'At least audioinput + videoinput + audiooutput', 'medium'); }
})()
`;
      await page.evaluate(async (script: string) => {
        // eslint-disable-next-line no-eval
        eval(script);
        // Wait for async callbacks
        await new Promise(r => setTimeout(r, 1000));
      }, asyncScript);

      asyncChecks = await page.evaluate(() => (window as any).__fpAsyncResults || []);
    } catch {
      // Async check collection failed — continue with sync results only
    }

    // 6. Merge sync and async results, deduplicating by category+name
    const allChecks: FingerprintCheck[] = [];
    const seen = new Set<string>();
    for (const raw of [...rawChecks, ...asyncChecks]) {
      const key = `${raw.category}:${raw.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allChecks.push({
        category: String(raw.category),
        name: String(raw.name),
        passed: Boolean(raw.passed),
        value: String(raw.value ?? ''),
        expected: String(raw.expected ?? ''),
        severity: validateSeverity(String(raw.severity)),
      });
    }

    // 7. Calculate score and extract issues
    const overallScore = calculateScore(allChecks);
    const issues = extractIssues(allChecks);

    return {
      testUrl,
      engine,
      timestamp: new Date().toISOString(),
      checks: allChecks,
      overallScore,
      issues,
    };
  } finally {
    // Cleanup in reverse order
    for (let i = cleanupRegistry.length - 1; i >= 0; i--) {
      try { await cleanupRegistry[i](); } catch { /* best effort */ }
    }
  }
}

// ==================== Helpers ====================

function validateSeverity(s: string): 'critical' | 'high' | 'medium' | 'low' {
  if (['critical', 'high', 'medium', 'low'].includes(s)) return s as 'critical' | 'high' | 'medium' | 'low';
  return 'low';
}
