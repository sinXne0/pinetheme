#!/usr/bin/env node
/*
 * Headless smoke test for the Android web payload.
 *
 * Copies android/build/www to a scratch dir, injects a stub `window.Android`
 * bridge plus an in-page test script, then loads it in headless Chromium with
 * --allow-file-access-from-files (the same privileges the WebView is given).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'build', 'www');
const OUT = '/tmp/opencode/pt-smoke/www';
const CHROME = path.join(
  process.env.HOME,
  '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'
);

fs.rmSync('/tmp/opencode/pt-smoke', { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(WWW, OUT, { recursive: true });

const STUB = `
(function(){
  window.__calls = [];
  window.Android = {
    platform: function () { return 'android'; },
    versionName: function () { return '0.2.0'; },
    saveBase64: function (name, mime, b64) {
      window.__calls.push({ fn: 'saveBase64', name: name, mime: mime, len: b64.length });
      window.__saved = b64;
      return 'ok';
    },
    writeTree: function (token, json) {
      window.__calls.push({ fn: 'writeTree', token: token, files: JSON.parse(json).length });
      window.__tree = { token: token, json: json };
      return '/storage/emulated/0/Android/data/studio.pinetheme.app/files/themes/' + token;
    },
    readTree: function () { return null; },
    listThemes: function () { return JSON.stringify([{ name: 'demo-theme', title: 'Demo', version: '2.0.0', framework: '0.9', components: 3, assets: 2, bytes: 1234, swatches: ['#00ff9c'] }]); },
    toast: function (m) { window.__calls.push({ fn: 'toast', msg: String(m) }); }
  };
  window.__errors = [];
  window.addEventListener('error', function (e) { window.__errors.push('error: ' + (e.message || e)); });
  window.addEventListener('unhandledrejection', function (e) { window.__errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)); });
  var ce = console.error;
  console.error = function () { window.__errors.push('console.error: ' + Array.prototype.join.call(arguments, ' ')); ce.apply(console, arguments); };
})();
`;

const TEST = `
(async function () {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: {}, errors: [], info: {} };
  const check = (name, cond, detail) => { out.checks[name] = { pass: !!cond, detail: detail === undefined ? null : String(detail) }; };

  // app init is async: wait until the model has files
  for (let i = 0; i < 80; i++) {
    if (window.__themeBuilder && window.__themeBuilder.state.model.files.size > 0) break;
    await wait(100);
  }
  const tb = window.__themeBuilder;
  const st = tb && tb.state;

  check('themeBuilder exposed', !!tb);
  check('api bridge present', !!window.api, window.api && window.api.platform);
  check('reference theme loaded', st && st.model.files.size > 100, st && st.model.files.size);
  check('theme.json parsed', !!(st && st.model.getThemeJson()), st && !!st.model.getThemeJson());

  const comps = st ? Array.from(st.model.files.keys()).filter((p) => p.startsWith('components/')) : [];
  check('components found', comps.length > 0, comps.length);
  out.info.firstComponents = comps.slice(0, 3);

  // mobile chrome
  check('body.pt-mobile', document.body.classList.contains('pt-mobile'));
  const sb = getComputedStyle(document.getElementById('sidebar'));
  check('sidebar is bottom bar', sb.flexDirection === 'row', sb.flexDirection);
  const pp = document.getElementById('preview-panel');
  check('preview sheet sized', pp && pp.getBoundingClientRect().height > 80, pp && Math.round(pp.getBoundingClientRect().height));
  check('open button hidden', document.getElementById('btnOpen').classList.contains('hidden'));
  check('preview toggle added', !!document.getElementById('ptPreviewToggle'));
  check('mobile.css loaded', Array.from(document.styleSheets).some((s) => (s.href || '').endsWith('mobile.css')));

  // canvas rendered
  const cv = document.getElementById('previewCanvas');
  const rect = cv.getBoundingClientRect();
  check('canvas visible', rect.width > 40 && rect.height > 20, Math.round(rect.width) + 'x' + Math.round(rect.height));

  // ZIP round-trip through the real engine
  try {
    const files = tb.serialize();
    const b64 = window.Zip.build(files);
    check('zip export', b64.startsWith('UEs'), b64.length + ' b64 chars');
    const parsed = await window.Zip.parse(b64);
    check('zip import', parsed.files.length === files.length, parsed.files.length + '/' + files.length);
  } catch (e) {
    check('zip round-trip', false, e.message);
  }

  // bridge actions
  try {
    await window.api.saveZip('UEsDBAo=', 'smoke.zip');
    await window.api.saveThemeToFolder([{ path: 'theme.json', base64: 'e30=', binary: false }], 'themes/smoke');
    const repo = await window.api.scanThemeRepo();
    window.__repo = repo;
    check('native saveZip called', window.__calls.some((c) => c.fn === 'saveBase64'), JSON.stringify(window.__calls.slice(0, 2)));
    check('native writeTree called', window.__calls.some((c) => c.fn === 'writeTree'));
    check('library scan', repo.themes.length === 1, JSON.stringify(repo.themes[0] && repo.themes[0].name));
  } catch (e) {
    check('bridge actions', false, e.message);
  }

  // tab switching still works
  try {
    tb.setTab('assets');
    await wait(60);
    const panel = document.getElementById('panel-assets');
    check('tab switch', panel && panel.classList.contains('active'), panel && panel.className);
    tb.setTab('design');
  } catch (e) {
    check('tab switch', false, e.message);
  }

  // collapse toggle
  try {
    document.getElementById('ptPreviewToggle').click();
    await wait(60);
    check('preview collapse', document.body.classList.contains('pt-preview-collapsed'));
    document.getElementById('ptPreviewToggle').click();
    await wait(60);
    check('preview expand', !document.body.classList.contains('pt-preview-collapsed'));
  } catch (e) {
    check('preview collapse', false, e.message);
  }

  // back handler
  tb.setTab('assets');
  await wait(60);
  const backToTab = window.__ptBackPressed();
  check('back returns to overview', backToTab === true && tb.state.currentTab === 'design', backToTab + '/' + tb.state.currentTab);

  const back = typeof window.__ptBackPressed === 'function' ? window.__ptBackPressed() : 'missing';
  check('back handler', back === false, JSON.stringify({
    returned: back,
    selection: st && st.selection.length,
    overlay: !!document.querySelector('.overlay:not(.hidden)'),
    context: !!document.querySelector('.context-menu'),
    focus: document.body.classList.contains('focus-preview')
  }));

  out.errors = window.__errors;
  const pre = document.createElement('pre');
  pre.id = 'smoke-result';
  pre.textContent = JSON.stringify(out, null, 2);
  document.body.appendChild(pre);
})();
`;

fs.writeFileSync(path.join(OUT, '__stub.js'), STUB);
fs.writeFileSync(path.join(OUT, '__smoke.js'), TEST);

const indexPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace('<script src="bridge.js"></script>', '<script src="__stub.js"></script>\n  <script src="bridge.js"></script>');
html = html.replace('</body>', '<script src="__smoke.js"></script>\n</body>');
fs.writeFileSync(indexPath, html);

const dom = execFileSync(
  CHROME,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--allow-file-access-from-files',
    '--allow-file-access',
    '--virtual-time-budget=15000',
    '--window-size=390,844',
    '--dump-dom',
    'file://' + indexPath
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
);

const m = dom.match(/<pre id="smoke-result">([\s\S]*?)<\/pre>/);
if (!m) {
  console.error('no smoke result in DOM; first 1500 chars:\n' + dom.slice(0, 1500));
  process.exit(1);
}
const result = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
let failed = 0;
for (const [name, c] of Object.entries(result.checks)) {
  if (!c.pass) failed++;
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + name + (c.detail ? '   [' + c.detail + ']' : ''));
}
if (result.errors && result.errors.length) {
  console.log('\npage errors:');
  for (const e of result.errors) console.log('  ' + e);
  failed += result.errors.length;
}
console.log('\n' + (failed ? failed + ' problem(s)' : 'all checks passed'));
process.exit(failed ? 1 : 0);
