#!/usr/bin/env node
/*
 * Layout probe: loads the Android web payload in headless Chromium at phone
 * sizes and reports geometry / overflow for the key regions.
 *
 *   node android/tools/layout-probe.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'build', 'www');
const SCRATCH = '/tmp/opencode/pt-layout';
const CHROME = path.join(process.env.HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.cpSync(WWW, SCRATCH, { recursive: true });

fs.writeFileSync(
  path.join(SCRATCH, '__probe.js'),
  `
(async function () {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    if (window.__themeBuilder && window.__themeBuilder.state.model.files.size > 0) break;
    await wait(100);
  }
  await wait(400);
  const ids = ['toolbar', 'app', 'content', 'sidebar', 'preview-panel', 'previewStage',
               'previewCanvasWrap', 'previewCanvas', 'dockBody', 'toast'];
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      scrollW: el.scrollWidth, scrollH: el.scrollHeight,
      display: cs.display, dir: cs.flexDirection, pos: cs.position
    };
  };
  const out = {
    viewport: { w: innerWidth, h: innerHeight },
    bodyScroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
    boxes: {}
  };
  for (const id of ids) out.boxes[id] = box(document.getElementById(id));

  const wide = [];
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > innerWidth + 2 || r.left < -2)) {
      wide.push((el.id || el.className || el.tagName).toString().slice(0, 48) + ' @' + Math.round(r.left) + '+' + Math.round(r.width));
    }
  });
  out.offscreen = wide.slice(0, 12);
  out.offscreenCount = wide.length;

  const pre = document.createElement('pre');
  pre.id = 'probe-result';
  pre.textContent = JSON.stringify(out, null, 2);
  document.body.appendChild(pre);
})();
`
);

const indexPath = path.join(SCRATCH, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace('</body>', '<script src="__probe.js"></script>\n</body>');
fs.writeFileSync(indexPath, html);

const sizes = [[390, 844, 'phone portrait'], [412, 915, 'large phone'], [844, 390, 'phone landscape'], [800, 1280, 'tablet ant']];

for (const [w, h, label] of sizes) {
  const dom = execFileSync(
    CHROME,
    ['--headless=new', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
     '--virtual-time-budget=10000', `--window-size=${w},${h}`, '--dump-dom',
     'file://' + indexPath],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const m = dom.match(/<pre id="probe-result">([\s\S]*?)<\/pre>/);
  if (!m) { console.log('\n### ' + label + ': probe failed'); continue; }
  const r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  console.log('\n### ' + label + '  (viewport ' + r.viewport.w + 'x' + r.viewport.h + ')');
  console.log('  document scroll: ' + r.bodyScroll.w + ' x ' + r.bodyScroll.h);
  for (const [id, b] of Object.entries(r.boxes)) {
    if (!b) { console.log('  ' + id.padEnd(20) + ' missing'); continue; }
    const over = (b.scrollW > b.w + 2 || b.scrollH > b.h + 2) ? '  overflow scroll=' + b.scrollW + 'x' + b.scrollH : '';
    console.log('  ' + id.padEnd(20) + ' ' + b.w + 'x' + b.h + ' @' + b.x + ',' + b.y +
      '  ' + b.display + (b.dir && b.dir !== 'row' ? '/' + b.dir : '') + over);
  }
  console.log('  offscreen elements: ' + r.offscreenCount);
  for (const o of r.offscreen) console.log('    ' + o);
}
