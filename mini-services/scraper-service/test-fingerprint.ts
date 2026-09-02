/**
 * Standalone fingerprint test — avoids tsx __name transpilation issue
 * by using page.addScriptTag + global variable instead of page.evaluate with functions.
 */
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getStealthScript, getProfileForDomain } from './src/stealth';

// Detection script that sets a global variable instead of returning
const DETECTION_JS = `
window.__fpResults = (() => {
  const results = [];
  function add(category, name, passed, value, expected, severity) {
    results.push({ category, name, passed, value: String(value), expected: String(expected), severity });
  }

  // NAVIGATOR
  try {
    const ua = navigator.userAgent;
    const hasChromeInUA = /Chrome\/\//.test(ua) && !/HeadlessChrome/.test(ua);
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
    const pass = count === 5;
    add('navigator', 'plugins count', pass, String(count), '5 plugins', 'high');
  } catch (e) { add('navigator', 'plugins count', false, 'Error: ' + e.message, '5 plugins', 'high'); }

  try {
    const plugins = navigator.plugins;
    let hasPDF = false;
    if (plugins) { for (let i = 0; i < plugins.length; i++) { if (plugins[i].name.indexOf('PDF') >= 0) { hasPDF = true; break; } } }
    add('navigator', 'plugins PDF Viewer', !!hasPDF, String(hasPDF), 'PDF Viewer plugin present', 'medium');
  } catch (e) { add('navigator', 'plugins PDF Viewer', false, 'Error: ' + e.message, 'PDF Viewer plugin', 'medium'); }

  try {
    const mimes = navigator.mimeTypes;
    const count = mimes ? mimes.length : 0;
    const valid = count >= 10;
    add('navigator', 'mimeTypes count', valid, String(count), '>= 10 mimeTypes', 'medium');
  } catch (e) { add('navigator', 'mimeTypes count', false, 'Error: ' + e.message, '>= 10 mimeTypes', 'medium'); }

  // WEBDRIVER
  try {
    const wd = navigator.webdriver;
    const pass = wd === undefined || wd === false;
    add('webdriver', 'navigator.webdriver', pass, String(wd), 'undefined or false', 'critical');
  } catch (e) { add('webdriver', 'navigator.webdriver', false, 'Error: ' + e.message, 'undefined or false', 'critical'); }

  // SCREEN
  try {
    const sw = screen.width; const sh = screen.height;
    const aw = screen.availWidth; const ah = screen.availHeight;
    const consistent = sw >= aw && sh >= ah && sw > 0 && sh > 0;
    add('screen', 'screen dimensions', consistent, sw + 'x' + sh + ' (avail: ' + aw + 'x' + ah + ')', 'availWidth <= width, availHeight <= height', 'high');
  } catch (e) { add('screen', 'screen dimensions', false, 'Error: ' + e.message, 'Consistent screen dimensions', 'high'); }

  try {
    const cd = screen.colorDepth; const pd = screen.pixelDepth;
    const valid = cd === 24 && pd === 24;
    add('screen', 'colorDepth/pixelDepth', valid, cd + '/' + pd, '24/24 (typical)', 'medium');
  } catch (e) { add('screen', 'colorDepth/pixelDepth', false, 'Error: ' + e.message, '24/24', 'medium'); }

  try {
    const ow = window.outerWidth; const oh = window.outerHeight;
    const iw = window.innerWidth; const ih = window.innerHeight;
    const reasonable = ow >= iw && oh >= ih && ow > 0 && oh > 0 && iw > 0 && ih > 0;
    add('screen', 'outer/inner dimensions', reasonable, 'outer: ' + ow + 'x' + oh + ' inner: ' + iw + 'x' + ih, 'outer >= inner, all positive', 'medium');
  } catch (e) { add('screen', 'outer/inner dimensions', false, 'Error: ' + e.message, 'Consistent window dimensions', 'medium'); }

  // WEBGL
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      add('webgl', 'vendor/renderer (not SwiftShader)', false, 'No WebGL context', 'Real GPU (not SwiftShader)', 'critical');
    } else {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const isSwiftShader = /SwiftShader/i.test(renderer);
      add('webgl', 'vendor/renderer (not SwiftShader)', !isSwiftShader, vendor + ' / ' + renderer, 'Real GPU (not SwiftShader)', 'critical');
    }
  } catch (e) { add('webgl', 'vendor/renderer (not SwiftShader)', false, 'Error: ' + e.message, 'Real GPU renderer', 'critical'); }

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    add('webgl', 'WebGL2 support', !!gl, gl ? 'available' : 'No WebGL2 context', 'WebGL2 context available', 'medium');
  } catch (e) { add('webgl', 'WebGL2 support', false, 'Error: ' + e.message, 'WebGL2 context available', 'medium'); }

  // CANVAS
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 50;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top'; ctx.font = '14px Arial';
    ctx.fillStyle = '#f60'; ctx.fillRect(50, 0, 100, 50);
    ctx.fillStyle = '#069'; ctx.fillText('Fingerprint test', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'; ctx.fillText('Fingerprint test', 4, 17);
    const fp1 = canvas.toDataURL();
    const fp2 = canvas.toDataURL();
    const nonEmpty = fp1.length > 100;
    const consistent = fp1 === fp2;
    add('canvas', 'toDataURL non-empty', nonEmpty, fp1.substring(0, 80) + '...', 'Non-empty data URL (>100 chars)', 'high');
    add('canvas', 'toDataURL consistency', consistent && nonEmpty, consistent ? 'match' : 'mismatch', 'Identical across calls', 'high');
  } catch (e) { add('canvas', 'toDataURL non-empty', false, 'Error: ' + e.message, 'Non-empty data URL', 'high'); }

  // AUDIO
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      add('audio', 'AudioContext creation', false, 'AudioContext not available', 'AudioContext available', 'medium');
    } else {
      const actx = new AudioCtx();
      const analyser = actx.createAnalyser();
      const osc = actx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = 10000;
      const gain = actx.createGain(); gain.gain.value = 0;
      osc.connect(gain); gain.connect(analyser);
      osc.start(); osc.stop(actx.currentTime + 0.05);
      add('audio', 'AudioContext creation', true, 'AudioContext created', 'AudioContext available', 'medium');
      actx.close();
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
      const data = new Float32Array(analyser.frequencyBinCount);
      const osc = actx.createOscillator();
      osc.type = 'triangle'; osc.frequency.value = 10000;
      const gain = actx.createGain(); gain.gain.value = 0;
      osc.connect(gain); gain.connect(analyser);
      analyser.connect(actx.destination);
      osc.start();
      analyser.getFloatFrequencyData(data);
      const hasNonZero = data.some(function(v) { return v !== 0 && !isNaN(v); });
      add('audio', 'AudioContext getFloatFrequencyData', hasNonZero, 'nonZero: ' + hasNonZero, 'Non-zero frequency data values', 'low');
      osc.stop(); actx.close();
    }
  } catch (e) { add('audio', 'AudioContext getFloatFrequencyData', false, 'Error: ' + e.message, 'Non-zero frequency data', 'low'); }

  // WEBRTC
  try {
    if (!window.RTCPeerConnection) {
      add('webrtc', 'WebRTC API available', true, 'RTCPeerConnection not available', 'RTCPeerConnection API functional', 'low');
    } else {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      const apiOk = typeof pc.createOffer === 'function' && typeof pc.createDataChannel === 'function';
      add('webrtc', 'WebRTC API available', apiOk, 'RTCPeerConnection API intact', 'RTCPeerConnection API functional', 'low');
      pc.close();
    }
  } catch (e) { add('webrtc', 'WebRTC API available', false, 'Error: ' + e.message, 'RTCPeerConnection API functional', 'low'); }

  // CHROME OBJECT
  try {
    const hasChrome = !!window.chrome;
    const hasRuntime = hasChrome && !!window.chrome.runtime;
    const hasCsi = hasChrome && typeof window.chrome.csi === 'function';
    const hasLoadTimes = hasChrome && typeof window.chrome.loadTimes === 'function';
    add('chrome_object', 'window.chrome exists', hasChrome, String(hasChrome), 'true', 'high');
    add('chrome_object', 'window.chrome.runtime', hasRuntime, String(hasRuntime), 'true', 'critical');
    add('chrome_object', 'window.chrome.csi', hasCsi, String(hasCsi), 'function', 'medium');
    add('chrome_object', 'window.chrome.loadTimes', hasLoadTimes, String(hasLoadTimes), 'function', 'medium');
  } catch (e) { add('chrome_object', 'window.chrome exists', false, 'Error: ' + e.message, 'true', 'high'); }

  // HEADLESS INDICATORS
  try { add('headless_indicators', 'window.__nightmare', !window.__nightmare, String(!!window.__nightmare), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.__nightmare', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window._phantom', !window._phantom, String(!!window._phantom), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window._phantom', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window.callPhantom', typeof window.callPhantom !== 'function', String(typeof window.callPhantom === 'function'), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.callPhantom', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window.domAutomation', !window.domAutomation, String(!!window.domAutomation), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.domAutomation', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window._selenium', !window._selenium, String(!!window._selenium), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window._selenium', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window.__webdriver_evaluate', !window.__webdriver_evaluate, String(!!window.__webdriver_evaluate), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.__webdriver_evaluate', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window.__driver_evaluate', !window.__driver_evaluate, String(!!window.__driver_evaluate), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.__driver_evaluate', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window.__webdriver_script_fn', !window.__webdriver_script_fn, String(!!window.__webdriver_script_fn), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.__webdriver_script_fn', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window.__webdriver_script_executor', !window.__webdriver_script_executor, String(!!window.__webdriver_script_executor), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.__webdriver_script_executor', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window.__selenium_unwrapped', !window.__selenium_unwrapped, String(!!window.__selenium_unwrapped), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.__selenium_unwrapped', true, 'Error', 'undefined', 'critical'); }
  try { add('headless_indicators', 'window.__fxdriver_unwrapped', !window.__fxdriver_unwrapped, String(!!window.__fxdriver_unwrapped), 'undefined', 'critical'); } catch (e) { add('headless_indicators', 'window.__fxdriver_unwrapped', true, 'Error', 'undefined', 'critical'); }

  // CONNECTION
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
})();
`;

async function main() {
  console.log('=== Fingerprint Stealth Test (obscura) ===\n');

  const profile = getProfileForDomain('fingerprint-test.local');
  console.log('Profile:');
  console.log('  platform:', profile.platform);
  console.log('  userAgent:', profile.userAgent.substring(0, 80) + '...');
  console.log('  webglVendor:', profile.webglVendor);
  console.log('  webglRenderer:', profile.webglRenderer);
  console.log('  screen:', profile.screenWidth + 'x' + profile.screenHeight);
  console.log('  colorDepth:', profile.colorDepth);
  console.log('  hardwareConcurrency:', profile.hardwareConcurrency);
  console.log('  deviceMemory:', profile.deviceMemory);
  console.log('  languages:', JSON.stringify(profile.languages));
  console.log('');

  const stealthScript = getStealthScript(profile);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: profile.userAgent,
      locale: profile.languages[0],
      timezoneId: profile.timezone,
      screen: { width: profile.screenWidth, height: profile.screenHeight },
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();
    await page.addInitScript(stealthScript);
    await page.goto('about:blank');

    // Debug: save stealth script to file and check for syntax errors
    const tmpStealth = path.join(os.tmpdir(), 'stealth-' + Date.now() + '.js');
    fs.writeFileSync(tmpStealth, stealthScript);
    console.log('Stealth script length:', stealthScript.length);
    try {
      const { execSync } = require('child_process');
      const syntaxCheck = execSync('node --check ' + tmpStealth + ' 2>&1').toString();
      console.log('Syntax check:', syntaxCheck || 'OK');
    } catch(e: any) {
      console.log('Syntax ERROR:', e.stdout?.toString() || e.message);
    }
    fs.unlinkSync(tmpStealth);

    // Quick check of key properties
    console.log('navigator.platform:', await page.evaluate('navigator.platform'));
    console.log('navigator.webdriver:', await page.evaluate('navigator.webdriver'));
    console.log('window.chrome:', await page.evaluate('!!window.chrome'));
    console.log('navigator.plugins.length:', await page.evaluate('navigator.plugins.length'));
    console.log('navigator.languages:', await page.evaluate('JSON.stringify(navigator.languages)'));
    console.log('navigator.hardwareConcurrency:', await page.evaluate('navigator.hardwareConcurrency'));

    // Write detection script to temp file and inject via addScriptTag
    const tmpJs = path.join(os.tmpdir(), 'fp-detect-' + Date.now() + '.js');
    fs.writeFileSync(tmpJs, DETECTION_JS);
    await page.addScriptTag({ path: tmpJs });
    fs.unlinkSync(tmpJs);

    // Read results from global variable
    const checks = await page.evaluate('window.__fpResults');
    if (!Array.isArray(checks)) {
      console.error('Expected array, got:', checks);
      await context.close();
      return;
    }

    // Print results
    let passed = 0;
    let failed = 0;
    const failures: any[] = [];

    for (const check of checks) {
      const icon = check.passed ? 'PASS' : 'FAIL';
      const sev = '[' + (check.severity || '').toUpperCase() + ']'.padEnd(10);
      const cat = (check.category || '').padEnd(20);
      const name = (check.name || '').padEnd(45);
      console.log(icon + ' ' + sev + ' ' + cat + ' ' + name + ' val=' + String(check.value).substring(0, 60));
      if (check.passed) {
        passed++;
      } else {
        failed++;
        failures.push(check);
      }
    }

    console.log('\n=== Summary: ' + passed + ' passed, ' + failed + ' failed out of ' + checks.length + ' checks ===');
    if (failures.length > 0) {
      console.log('\nFailed checks:');
      for (const f of failures) {
        console.log('  [' + f.severity.toUpperCase() + '] ' + f.category + '/' + f.name);
        console.log('    got: ' + f.value);
        console.log('    expected: ' + f.expected);
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch(function(err) {
  console.error('Test failed:', err);
  process.exit(1);
});
