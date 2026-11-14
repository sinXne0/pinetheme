// Studio feature test: preview scaling, Image Lab, templates, manifest form,
// palette presets, simulator and command palette.
// Run with: node_modules/.bin/electron test/studio.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const REF = path.join(__dirname, '..', 'reference', 'wargames');
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.raw', '.ttf']);

function readTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const relp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, relp);
      else if (e.isFile()) out.push({ path: relp, base64: fs.readFileSync(abs).toString('base64'), binary: BINARY_EXT.has(path.extname(relp).toLowerCase()) });
    }
  };
  walk(dir, '');
  return { name: path.basename(dir), files: out };
}

ipcMain.handle('loadReferenceTree', () => readTree(REF));
ipcMain.handle('openThemeFolder', () => null);
ipcMain.handle('readTree', () => null);
ipcMain.handle('pickSaveFolder', () => null);
ipcMain.handle('saveThemeToFolder', () => ({ ok: true }));
ipcMain.handle('joinPath', (e, a, b) => path.join(a, b));
ipcMain.handle('saveZip', () => null);
ipcMain.handle('openZip', () => null);
ipcMain.handle('pickAssetFiles', () => []);
ipcMain.handle('saveBinaryFile', () => null);
ipcMain.handle('pickThemeRepo', () => null);
ipcMain.handle('scanThemeRepo', () => null);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: false }
  });
  const rendererErrors = [];
  win.webContents.on('console-message', (...args) => {
    if (args[1] === 3 || /Uncaught/i.test(String(args[2] || ''))) rendererErrors.push(String(args[2] || ''));
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.confirm = () => true;
    const app = window.__themeBuilder;
    while (!app || !document.querySelectorAll('#previewComponent option').length) await sleep(100);
    const out = {};
    const canvas = document.getElementById('previewCanvas');
    const wrap = document.getElementById('previewCanvasWrap');

    // ---- preview scaling: fit fits, 3x overflows without the page clipping ----
    app.setZoom('fit');
    await sleep(250);
    out.fit = {
      canvasW: canvas.getBoundingClientRect().width,
      canvasH: canvas.getBoundingClientRect().height,
      wrapW: wrap.clientWidth,
      wrapH: wrap.clientHeight
    };
    app.setZoom('fixed', 3);
    await sleep(150);
    out.zoom3 = canvas.style.width;
    app.setZoom('fit');

    // ---- Image Lab: palette remap + dither + apply ----
    app.setTab('imagelab');
    const lab = app.state.imageLab;
    const asset = app.state.model.listAssets().find((p) => /wargames_bg_updated/.test(p));
    lab.loadAsset(asset);
    await sleep(500);
    lab.ops.mode = 'palette';
    lab.ops.outWidth = 480;
    lab.ops.outHeight = 222;
    lab.ops.preset = 'screen';
    lab.render();
    await sleep(150);
    const paletteData = lab.el.canvas.getContext('2d').getImageData(0, 0, lab.el.canvas.width, lab.el.canvas.height).data;
    const colors = new Set();
    for (let i = 0; i < paletteData.length; i += 4) {
      if (paletteData[i + 3]) colors.add(paletteData[i] + ',' + paletteData[i + 1] + ',' + paletteData[i + 2]);
    }
    out.labPaletteColors = colors.size;
    lab.ops.mode = 'dither-fs';
    lab.ops.outWidth = 63;
    lab.ops.outHeight = 62;
    lab.render();
    await sleep(150);
    const before = app.state.model.getBase64(asset);
    lab.applyToAsset(false);
    await sleep(600);
    out.labApplied = app.state.model.getBase64(asset) !== before;
    out.labDims = [lab.el.canvas.width, lab.el.canvas.height];
    out.labPresets = lab.el.preset.options.length;

    // ---- template generator ----
    const created = app.createFromTemplate('dashboard');
    out.templateCreated = !!created && app.state.model.has(created);
    out.templateHasMenu = Array.isArray(app.state.model.getComponent(created).menu_items);

    // ---- manifest form edit ----
    app.setTab('themejson');
    await sleep(200);
    const form = document.getElementById('manifestForm');
    out.manifestSections = form.querySelectorAll('.manifest-section').length;
    const select = [...form.querySelectorAll('.manifest-row select')]
      .find((s) => s.value === 'components/status_bars/status_bar.json');
    out.manifestStatusSelect = !!select;
    if (select) {
      select.value = 'components/status_bars/status_bar_min.json';
      select.dispatchEvent(new Event('change'));
      await sleep(200);
    }
    out.manifestUpdated = app.state.model.getThemeJson().status_bars.default === 'components/status_bars/status_bar_min.json';

    // ---- palette preset + harmony tools ----
    app.setTab('colors');
    await sleep(150);
    const cyber = app.ThemeTemplates.PRESETS.find((p) => p.id === 'cyberpunk');
    app.applyPalettePreset(cyber);
    out.presetColors = Object.keys(app.state.model.getPalette()).length;
    out.presetBlack = app.state.model.getPalette().black.r === 5;
    out.harmonySwatches = document.querySelectorAll('#harmonyPreview .mini-swatch').length;

    // ---- simulator ----
    app.setTab('simulator');
    await sleep(400);
    const sim = document.getElementById('simCanvas');
    const simData = sim.getContext('2d').getImageData(0, 0, sim.width, sim.height).data;
    let simNonBlank = 0;
    for (let i = 0; i < simData.length; i += 4) if (simData[i] || simData[i + 1] || simData[i + 2]) simNonBlank++;
    out.simNonBlank = simNonBlank;
    const beforeSel = app.state.preview.selectedIndex;
    document.querySelector('[data-sim="down"]').click();
    await sleep(200);
    out.simMoved = app.state.preview.selectedIndex !== beforeSel;

    // ---- command palette ----
    app.openCommandPalette();
    await sleep(150);
    out.commandItems = document.querySelectorAll('#commandResults .command-item').length;
    document.getElementById('commandOverlay').classList.add('hidden');

    // ---- focus preview ----
    document.getElementById('btnFocusPreview').click();
    await sleep(250);
    out.focus = document.body.classList.contains('focus-preview');
    out.focusCanvas = canvas.getBoundingClientRect().width;
    document.getElementById('btnFocusPreview').click();

    return out;
  })().catch((e) => ({ __scriptError: String((e && e.stack) || e) }))`);

  if (!result || result.__scriptError) {
    console.error('FAIL ' + (result && result.__scriptError));
    console.log('RENDERER_ERRORS ' + JSON.stringify(rendererErrors));
    app.exit(1);
    return;
  }
  console.log('STUDIO_RESULT ' + JSON.stringify(result));
  if (rendererErrors.length) console.log('RENDERER_ERRORS ' + JSON.stringify(rendererErrors));
  const ok = result.fit.canvasW > 0 &&
    result.fit.canvasW <= result.fit.wrapW + 1 &&
    result.fit.canvasH <= result.fit.wrapH + 1 &&
    result.labPaletteColors > 1 &&
    result.labApplied === true &&
    result.labDims[0] === 63 && result.labDims[1] === 62 &&
    result.labPresets >= 10 &&
    result.templateCreated === true &&
    result.templateHasMenu === true &&
    result.manifestSections >= 10 &&
    result.manifestStatusSelect === true &&
    result.manifestUpdated === true &&
    result.presetColors === 30 &&
    result.harmonySwatches > 0 &&
    result.simNonBlank > 0 &&
    result.simMoved === true &&
    result.commandItems > 0 &&
    result.focus === true &&
    result.focusCanvas > result.fit.canvasW &&
    rendererErrors.length === 0;
  app.exit(ok ? 0 : 1);
});
