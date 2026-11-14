#!/usr/bin/env node
/*
 * Device test for the Android web payload.
 *
 * Drives headless Chromium over the DevTools Protocol with mobile emulation
 * (390x844 @2.625, touch input) and checks the things a phone actually cares
 * about: real viewport geometry, no page-level overflow, the bottom tab bar
 * being on-screen, the preview canvas being big enough to edit, the hardware
 * back contract, and touch drag on the canvas.
 *
 *   node android/tools/device-test.js
 *
 * Screenshots land in /tmp/opencode/pt-device-*.png.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX = 'file://' + path.join(ROOT, 'build', 'www', 'index.html');
const CHROME = path.join(process.env.HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const PORT = 9333 + (process.pid % 200);
const PROFILE = '/tmp/opencode/chrome-device-profile';

const STUB = `
  window.__calls = [];
  window.Android = {
    platform: function () { return 'android'; },
    versionName: function () { return '0.2.0'; },
    saveBase64: function (n, m, b) { window.__calls.push({ fn: 'saveBase64', name: n }); return 'ok'; },
    writeTree: function (t, j) { window.__calls.push({ fn: 'writeTree', token: t }); return '/themes/' + t; },
    readTree: function () { return null; },
    listThemes: function () { return '[]'; },
    toast: function (m) { window.__calls.push({ fn: 'toast', msg: String(m) }); }
  };
  window.__errors = [];
  window.addEventListener('error', function (e) { window.__errors.push('error: ' + (e.message || e)); });
  window.addEventListener('unhandledrejection', function (e) { window.__errors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)); });
  window.__ptTestTouch = function (type, points) {
    var target = document.getElementById('previewCanvas');
    var touches = points.map(function (p, i) {
      return new Touch({ identifier: p.id == null ? i : p.id, target: target,
        clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y,
        screenX: p.x, screenY: p.y,
        radiusX: p.radiusX || 1, radiusY: p.radiusY || 1, force: p.force == null ? 1 : p.force });
    });
    var ev = new TouchEvent(type, {
      touches: type === 'touchEnd' ? [] : touches,
      targetTouches: type === 'touchEnd' ? [] : touches,
      changedTouches: touches, bubbles: true, cancelable: true
    });
    target.dispatchEvent(ev);
    return Promise.resolve(true);
  };
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
  }
  send(method, params) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : 'eval failed');
    }
    return r.result.value;
  }
}

async function waitPort(url, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { /* not up yet */ }
    await sleep(120);
  }
  throw new Error('chrome devtools did not start');
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore' });

  let exitCode = 0;
  const checks = [];
  const check = (name, pass, detail) => {
    checks.push({ name, pass: !!pass, detail });
    if (!pass) exitCode = 1;
  };

  try {
    await waitPort(`http://127.0.0.1:${PORT}/json/version`, 20000);
    const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2.625, mobile: true,
      screenWidth: 390, screenHeight: 844
    });

    await cdp.send('Page.navigate', { url: INDEX });

    // Wait for init (reference theme is ~1.5 MB of base64).
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        ready = await cdp.eval('!!(window.__themeBuilder && window.__themeBuilder.state.model.files.size > 100)');
      } catch (e) { /* navigating */ }
      if (ready) break;
      await sleep(150);
    }
    check('app booted with reference theme', ready);

    await sleep(500);

    const geo = await cdp.eval(`(() => {
      const r = (id) => { const el = document.getElementById(id); if (!el) return null;
        const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
                 scrollW: el.scrollWidth, scrollH: el.scrollHeight, display: cs.display, dir: cs.flexDirection }; };
      return {
        vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
        docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight,
        bodyScroll: { w: document.body.scrollWidth, h: document.body.scrollHeight },
        toolbar: r('toolbar'), app: r('app'), content: r('content'), sidebar: r('sidebar'),
        preview: r('preview-panel'), stage: r('previewStage'), canvas: r('previewCanvas'),
        dock: r('dockBody'), toast: r('toast')
      };
    })()`);

    check('viewport is phone sized', geo.vw === 390 && geo.vh === 844, geo.vw + 'x' + geo.vh + ' @' + geo.dpr);
    check('no horizontal page overflow', geo.docW <= geo.vw, geo.docW + ' > ' + geo.vw);
    check('no vertical page overflow', geo.docH <= geo.vh + 1, geo.docH + ' > ' + geo.vh);
    check('bottom tab bar on screen', geo.sidebar && geo.sidebar.y + geo.sidebar.h <= geo.vh + 1 && geo.sidebar.h >= 40,
      geo.sidebar && (geo.sidebar.y + '+' + geo.sidebar.h));
    check('preview canvas large enough', geo.canvas && geo.canvas.w >= 260 && geo.canvas.h >= 100,
      geo.canvas && (geo.canvas.w + 'x' + geo.canvas.h));
    check('canvas inside preview stage', geo.canvas && geo.stage &&
      geo.canvas.x >= geo.stage.x && geo.canvas.y >= geo.stage.y - 1,
      geo.canvas && geo.stage && ('canvas@' + geo.canvas.x + ',' + geo.canvas.y + ' stage@' + geo.stage.x + ',' + geo.stage.y));
    check('content area usable', geo.content && geo.content.h >= 200, geo.content && geo.content.h);
    check('dock panes visible', geo.dock && geo.dock.h >= 80, geo.dock && geo.dock.h);
    check('toast centered', geo.toast && geo.toast.x >= 0 && geo.toast.x + geo.toast.w <= geo.vw + 1,
      geo.toast && (geo.toast.x + '+' + geo.toast.w));

    const canvasBitmap = await cdp.eval(`(() => {
      const cv = document.getElementById('previewCanvas');
      const g = cv.getContext('2d');
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
      return { lit: lit, total: d.length / 4 };
    })()`);
    check('preview actually rendered pixels', canvasBitmap.lit > 100,
      canvasBitmap.lit + '/' + canvasBitmap.total + ' lit');

    // ---- touch drag in Edit mode ----------------------------------------
    const drag = await cdp.eval(`(async () => {
      const tb = window.__themeBuilder;
      const st = tb.state;
      const cv = document.getElementById('previewCanvas');
      const regions = (st.renderer && st.renderer.hitRegions) || [];
      let region = null;
      for (let i = regions.length - 1; i >= 0; i--) {
        const r = regions[i];
        if ((r.layer && (r.layer.x !== undefined || r.layer.y !== undefined)) || r.item) { region = r; break; }
      }
      if (!region) return { error: 'no draggable hit region', regions: regions.length };
      const edit = document.getElementById('editMode');
      edit.checked = true;
      edit.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 120));
      const b = cv.getBoundingClientRect();
      const cx = region.x + region.w / 2;
      const cy = region.y + region.h / 2;
      const target = region.layer && (region.layer.x !== undefined || region.layer.y !== undefined)
        ? region.layer : region.item;
      const before = { x: target.x || 0, y: target.y || 0 };
      const sx = b.left + (cx / 480) * b.width;
      const sy = b.top + (cy / 222) * b.height;
      const touch = (type, x, y) => {
        const t = [{ x: Math.round(x), y: Math.round(y), radiusX: 2, radiusY: 2, force: 1, id: 0 }];
        return window.__ptTestTouch(type, t);
      };
      await window.__ptTestTouch('touchstart', [{ x: Math.round(sx), y: Math.round(sy), radiusX: 2, radiusY: 2, force: 1, id: 0 }]);
      for (let step = 1; step <= 6; step++) {
        await window.__ptTestTouch('touchmove', [{ x: Math.round(sx + (24 * step) / 6), y: Math.round(sy + (12 * step) / 6), radiusX: 2, radiusY: 2, force: 1, id: 0 }]);
      }
      await window.__ptTestTouch('touchend', []);
      await new Promise((r) => setTimeout(r, 200));
      const after = { x: target.x || 0, y: target.y || 0 };
      return {
        before, after, dx: after.x - before.x, dy: after.y - before.y,
        dragCleared: !st.drag, dirty: !!(st.model && st.model.dirty),
        canvasW: Math.round(cv.getBoundingClientRect().width), zoomMode: st.preview.zoomMode,
        selected: st.selection.length, editMode: edit.checked
      };
    })()`);
    check('touch drag moved the element', drag && !drag.error && (drag.dx !== 0 || drag.dy !== 0),
      drag && (drag.error || ('d=' + drag.dx + ',' + drag.dy + ' from ' + JSON.stringify(drag.before))));
    check('touch drag cleared state', drag && drag.dragCleared === true);
    check('touch drag marked theme dirty', drag && drag.dirty === true);
    check('edit mode keeps the canvas fitted', drag && drag.canvasW <= geo.vw && drag.zoomMode === 'fit',
      drag && (drag.canvasW + 'px, ' + drag.zoomMode));

    // ---- mouse drag (the path the Electron tests exercise) --------------
    const mouse = await cdp.eval(`(async () => {
      const tb = window.__themeBuilder, st = tb.state, cv = document.getElementById('previewCanvas');
      const regions = (st.renderer && st.renderer.hitRegions) || [];
      let region = null;
      for (let i = regions.length - 1; i >= 0; i--) {
        const r = regions[i];
        if (r.layer && (r.layer.x !== undefined || r.layer.y !== undefined)) { region = r; break; }
      }
      if (!region) return { error: 'no layer region' };
      st.selection.length = 0;
      const b = cv.getBoundingClientRect();
      const sx = b.left + ((region.x + region.w / 2) / 480) * b.width;
      const sy = b.top + ((region.y + region.h / 2) / 222) * b.height;
      const before = { x: region.layer.x || 0, y: region.layer.y || 0 };
      cv.dispatchEvent(new MouseEvent('mousedown', { clientX: sx, clientY: sy, button: 0, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: sx + 20, clientY: sy + 10, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const after = { x: region.layer.x || 0, y: region.layer.y || 0 };
      return { before, after, dx: after.x - before.x, dy: after.y - before.y, dragCleared: !st.drag };
    })()`);
    check('mouse drag still works', mouse && !mouse.error && (mouse.dx !== 0 || mouse.dy !== 0),
      mouse && (mouse.error || ('d=' + mouse.dx + ',' + mouse.dy)));
    check('mouse drag clears state', mouse && mouse.dragCleared === true);

    // undo the drag to keep the screenshot clean
    await cdp.eval(`(document.getElementById('editMode').checked = false,
      document.getElementById('editMode').dispatchEvent(new Event('change')),
      window.__themeBuilder.history.undo(), true)`);

    // ---- every tab renders ----------------------------------------------
    const tabs = await cdp.eval(`(async () => {
      const tb = window.__themeBuilder;
      const before = window.__errors.length;
      const out = [];
      for (const b of document.querySelectorAll('#sidebar .nav-item[data-tab]')) {
        b.click();
        await new Promise((r) => setTimeout(r, 160));
        const panel = document.getElementById('panel-' + b.dataset.tab);
        out.push({ name: b.dataset.tab, active: !!(panel && panel.classList.contains('active')) });
      }
      tb.setTab('design');
      await new Promise((r) => setTimeout(r, 120));
      return { tabs: out, newErrors: window.__errors.slice(before) };
    })()`);
    const broken = tabs.tabs.filter((t) => !t.active).map((t) => t.name);
    check('every tab opens its panel', broken.length === 0, broken.join(',') || tabs.tabs.length + ' tabs');
    check('tab sweep raises no errors', tabs.newErrors.length === 0, tabs.newErrors.join(' | '));

    // ---- Save writes the working theme to app storage --------------------
    const saved = await cdp.eval(`(async () => {
      window.__calls.length = 0;
      document.getElementById('btnSave').click();
      await new Promise((r) => setTimeout(r, 500));
      return {
        call: window.__calls.find((c) => c.fn === 'writeTree') || null,
        opened: window.__themeBuilder.state.openedFolder,
        dirty: window.__themeBuilder.state.model.dirty
      };
    })()`);
    check('Save writes to app storage', saved.call && /^themes\//.test(saved.call.token),
      JSON.stringify(saved.call || saved));
    check('Save clears the dirty flag', saved.dirty === false);

    // ---- advanced image editor iframe ------------------------------------
    const adv = await cdp.eval(`(async () => {
      const frame = document.getElementById('advancedFrame');
      const ready = new Promise((resolve) => {
        const on = (e) => {
          if (e.data && e.data.type === 'ready') {
            window.removeEventListener('message', on);
            resolve(true);
          }
        };
        window.addEventListener('message', on);
        setTimeout(() => resolve(false), 12000);
      });
      frame.src = 'advanced-editor.html';
      const ok = await ready;
      let tui = false, editor = false;
      try {
        tui = !!(frame.contentWindow && frame.contentWindow.tui);
        editor = !!frame.contentDocument.getElementById('editor');
      } catch (e) { /* cross origin */ }
      frame.src = 'about:blank';
      return { ready: ok, tui, editor };
    })()`);
    check('advanced editor loads in its iframe', adv.ready && adv.tui && adv.editor, JSON.stringify(adv));

    await sleep(300);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/opencode/pt-device-portrait.png', Buffer.from(shot.data, 'base64'));

    // ---- bottom nav interaction ----------------------------------------
    const nav = await cdp.eval(`(async () => {
      const buttons = Array.from(document.querySelectorAll('#sidebar .nav-item[data-tab]'));
      const b = buttons.find((x) => x.dataset.tab === 'assets');
      b.click();
      await new Promise((r) => setTimeout(r, 120));
      const panel = document.getElementById('panel-assets');
      const active = panel && panel.classList.contains('active');
      const rect = b.getBoundingClientRect();
      return { active, count: buttons.length, visible: rect.bottom <= innerHeight + 1 && rect.top >= 0 };
    })()`);
    check('bottom tab switches panels', nav && nav.active, nav && (nav.count + ' tabs'));
    check('tab row within viewport', nav && nav.visible);

    // ---- hardware back --------------------------------------------------
    const back = await cdp.eval(`(async () => {
      const tb = window.__themeBuilder;
      tb.setTab('colors');
      await new Promise((r) => setTimeout(r, 80));
      const r1 = window.__ptBackPressed();
      const tab = tb.state.currentTab;
      const r2 = window.__ptBackPressed();
      const overlay = document.querySelector('.overlay:not(.hidden)');
      return { r1, tabAfter: tab, r2, overlay: !!overlay };
    })()`);
    check('back returns to overview tab', back && back.r1 === true && back.tabAfter === 'design', JSON.stringify(back));
    check('back exits when nothing open', back && back.r2 === false);
    check('no stray modal blocking back', back && back.overlay === false);

    // ---- small phone ----------------------------------------------------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 360, height: 640, deviceScaleFactor: 3, mobile: true,
      screenWidth: 360, screenHeight: 640
    });
    await sleep(700);
    const small = await cdp.eval(`(() => {
      const b = (id) => { const el = document.getElementById(id); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      return { vw: innerWidth, vh: innerHeight, docW: document.documentElement.scrollWidth,
        docH: document.documentElement.scrollHeight, canvas: b('previewCanvas'), sidebar: b('sidebar'), content: b('content'),
        zoomMode: window.__themeBuilder.state.preview.zoomMode, inlineW: document.getElementById('previewCanvas').style.width };
    })()`);
    check('small phone: no page overflow', small.docW <= small.vw && small.docH <= small.vh + 1,
      small.docW + 'x' + small.docH + ' / ' + small.vw + 'x' + small.vh);
    check('small phone: canvas still usable', small.canvas && small.canvas.w >= 200 && small.canvas.h >= 90,
      small.canvas && (small.canvas.w + 'x' + small.canvas.h + ' zm=' + small.zoomMode + ' inline=' + small.inlineW));
    check('small phone: nav on screen', small.sidebar && small.sidebar.y + small.sidebar.h <= small.vh + 1);

    // ---- orientation change --------------------------------------------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 844, height: 390, deviceScaleFactor: 2.625, mobile: true,
      screenWidth: 844, screenHeight: 390
    });
    await sleep(600);
    const land = await cdp.eval(`(() => {
      const b = (id) => { const el = document.getElementById(id); if (!el) return null;
        const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      return { vw: innerWidth, vh: innerHeight, docW: document.documentElement.scrollWidth,
        canvas: b('previewCanvas'), stage: b('previewStage'), sidebar: b('sidebar'), content: b('content'), preview: b('preview-panel') };
    })()`);
    check('landscape has no page overflow', land.docW <= land.vw, land.docW + ' > ' + land.vw);
    check('landscape canvas usable', land.canvas && land.canvas.w >= 120 && land.canvas.h >= 60,
      land.canvas && (land.canvas.w + 'x' + land.canvas.h));
    check('landscape sidebar is a rail', land.sidebar && land.sidebar.w <= 80 && land.sidebar.h > 200,
      land.sidebar && (land.sidebar.w + 'x' + land.sidebar.h));
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/opencode/pt-device-landscape.png', Buffer.from(shot2.data, 'base64'));

    // ---- console errors -------------------------------------------------
    const errors = await cdp.eval('window.__errors || []');
    check('no page errors', errors.length === 0, errors.join(' | '));

    ws.close();
  } catch (e) {
    check('test harness', false, e.message);
  } finally {
    chrome.kill('SIGKILL');
  }

  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail !== undefined && c.detail !== null ? '   [' + c.detail + ']' : ''));
  }
  console.log('\n' + (exitCode ? 'device test failed' : 'device test passed') +
    '  (screenshots: /tmp/opencode/pt-device-*.png)');
  process.exit(exitCode);
}

main();
