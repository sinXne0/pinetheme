// End-to-end interaction test: boots the real renderer under Electron and
// exercises live color preview, text wrapping, preview variants, drag editing,
// keyboard nudge, undo/redo, asset import, palette/PNG export, validation, and
// ZIP export.
// Run with:  node_modules/.bin/electron test/interaction.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const REF = path.join(__dirname, '..', 'reference', 'wargames');
const OUT_DIR = '/tmp/opencode';
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.raw', '.ttf']);

function isBinaryName(p) { return BINARY_EXT.has(path.extname(p).toLowerCase()); }

function readTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const relp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, relp);
      else if (e.isFile()) out.push({ path: relp, base64: fs.readFileSync(abs).toString('base64'), binary: isBinaryName(relp) });
    }
  };
  walk(dir, '');
  return { name: path.basename(dir), files: out };
}

// 1x1 PNG used to prove asset import works.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

ipcMain.handle('loadReferenceTree', () => readTree(REF));
ipcMain.handle('openThemeFolder', () => null);
ipcMain.handle('readTree', () => null);
ipcMain.handle('pickSaveFolder', () => null);
ipcMain.handle('saveThemeToFolder', () => ({ ok: true }));
ipcMain.handle('joinPath', (e, a, b) => path.join(a, b));
ipcMain.handle('saveZip', () => null);
ipcMain.handle('openZip', () => null);
ipcMain.handle('pickAssetFiles', () => [{ name: 'test.png', base64: TINY_PNG }]);

// Capture files written through the generic save path (palette JSON, preview
// PNG) so the test can inspect exactly what would hit disk.
const savedFiles = [];
ipcMain.handle('saveBinaryFile', (e, base64, defaultName, filters) => {
  savedFiles.push({ base64, defaultName, filters });
  return path.join(OUT_DIR, defaultName || 'saved.bin');
});

function waitForApp(win, timeoutMs = 15000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < timeoutMs) {
      const ready = await win.webContents.executeJavaScript(
        '!!(window.__themeBuilder && document.querySelectorAll("#previewComponent option").length)'
      ).catch(() => false);
      if (ready) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: false }
  });

  const rendererErrors = [];
  win.webContents.on('console-message', (...args) => {
    const level = args[1];
    const message = String(args[2] || '');
    if (level === 3 || /Uncaught/i.test(message)) rendererErrors.push(message);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  const ready = await waitForApp(win);
  if (!ready) {
    console.error('FAIL app did not become ready');
    app.exit(1);
    return;
  }

  let result;
  try {
    result = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.__themeBuilder;
    const canvas = document.getElementById('previewCanvas');
    const ctx = canvas.getContext('2d');
    const out = {};
    window.confirm = () => true;
    let promptQueue = [];
    window.prompt = () => promptQueue.shift();

    out.previewOptions = document.querySelectorAll('#previewComponent option').length;
    out.colorCells = document.querySelectorAll('#colorGrid .color-cell').length;
    out.componentItems = document.querySelectorAll('#componentList li').length;
    out.assetCells = document.querySelectorAll('#assetGrid .asset-cell').length;

    const hash = () => {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 97) { h ^= d[i]; h = Math.imul(h, 16777619); }
      return h >>> 0;
    };
    out.beforeHash = hash();

    // ---- live color preview: tint the whole palette magenta ----
    const originalPalette = app.state.model.getPalette();
    const magenta = {};
    for (const k of Object.keys(originalPalette)) magenta[k] = { r: 255, g: 0, b: 255 };
    app.state.model.setPalette(magenta);
    await app.renderPreview();
    out.afterColorHash = hash();
    out.colorChanged = out.afterColorHash !== out.beforeHash;

    // Recolored image cache must be keyed on the actual RGB, not the name.
    const renderer = app.state.renderer;
    const sampleAsset = app.state.model.listAssets().find((p) => /\.png$/i.test(p));
    if (sampleAsset) {
      await renderer.ensureImage(sampleAsset);
      const tintA = renderer.recolor(sampleAsset, 'green');
      const tintA2 = renderer.recolor(sampleAsset, 'green');
      app.state.model.setColor('green', { r: 1, g: 2, b: 3 });
      const tintB = renderer.recolor(sampleAsset, 'green');
      out.recolorCached = tintA === tintA2;
      out.recolorInvalidated = tintA !== tintB;
    }

    app.state.model.setPalette(originalPalette);
    await app.renderPreview();

    // ---- text wrapping helper ----
    out.wrapLines = renderer.wrapText('alpha beta gamma delta', 10, true);
    out.wrapOk = out.wrapLines.length > 1 && out.wrapLines.every((l) => l.length <= 10);
    out.newlineOk = renderer.wrapText('a\\nb', 10, false).length === 2;

    // ---- preview variants: template states, keyboard input, image-only ----
    const allComps = app.state.model.listComponents();
    let templateComp = null;
    let keyboardComp = null;
    let imageComp = null;
    for (const p of allComps) {
      const c = app.state.model.getComponent(p);
      if (!c || c.__parseError) continue;
      if (!templateComp && (Array.isArray(c.enabled) || Array.isArray(c.disabled))) templateComp = p;
      if (!keyboardComp && c.input_area && c.input_area.max_characters != null) keyboardComp = p;
      if (!imageComp && Object.keys(c).some(
        (k) => typeof c[k] === 'string' && /(_image_path|background_path)$/.test(k)
      )) imageComp = p;
    }
    out.templateComp = templateComp;
    out.templateScreens = templateComp
      ? renderer.listScreens(app.state.model.getComponent(templateComp)).map((s) => s.name)
      : [];
    out.keyboardComp = keyboardComp;
    out.keyboardScreens = keyboardComp
      ? renderer.listScreens(app.state.model.getComponent(keyboardComp)).map((s) => s.name)
      : [];
    out.imageComp = imageComp;
    out.imageScreens = imageComp
      ? renderer.listScreens(app.state.model.getComponent(imageComp)).map((s) => s.name)
      : [];

    // ---- simulation variables + click-through ----
    out.truthyDefault = renderer.truthy(undefined);
    out.truthyOff = renderer.truthy('false');
    out.truthyOn = renderer.truthy('true');
    renderer.variables['$_INPUT'] = 'CUSTOM';
    out.varOverride = renderer.sampleValue('$_INPUT') === 'CUSTOM';
    delete renderer.variables['$_INPUT'];

    // Variable panel for the default dashboard component.
    out.variablesBoxVisible = !document.getElementById('variablesBox').classList.contains('hidden');
    out.hasPayloadVar = Array.from(document.querySelectorAll('#variableList .variable-row label'))
      .some((l) => l.textContent === '$_PAYLOAD_CATEGORIES');

    const catInput = Array.from(document.querySelectorAll('#variableList .variable-row input'))
      .find((i) => i.placeholder === 'Category');
    if (catInput) {
      catInput.value = 'CUSTOM_CATEGORY';
      catInput.dispatchEvent(new Event('input'));
      await sleep(200);
      out.varInputApplied = app.state.renderer.sampleValue('$_PAYLOAD_CATEGORIES') === 'CUSTOM_CATEGORY';
    }

    // Simulate a click on the "SETTINGS" dashboard item to follow its target.
    document.getElementById('simulateMode').checked = true;
    await sleep(250);
    const simRegions = app.state.renderer.hitRegions;
    let targetRegion = null;
    for (let i = simRegions.length - 1; i >= 0; i--) {
      const r = simRegions[i];
      if (r.item && r.item.target === 'settings_menu') { targetRegion = r; break; }
    }
    out.simulateRegionFound = !!targetRegion;
    if (targetRegion) {
      const srect = canvas.getBoundingClientRect();
      const scx = srect.left + ((targetRegion.x + targetRegion.w / 2) / 480) * srect.width;
      const scy = srect.top + ((targetRegion.y + targetRegion.h / 2) / 222) * srect.height;
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: scx, clientY: scy, bubbles: true }));
      await sleep(450);
      out.simulatedJump = app.state.preview.componentPath === 'components/dashboards/dashboard_settings.json';
      out.backStackLen = app.state.backStack.length;
    }
    document.getElementById('simulateMode').checked = false;
    await sleep(150);

    // ---- drag editing ----
    const editMode = document.getElementById('editMode');
    editMode.checked = true;
    editMode.dispatchEvent(new Event('change'));
    // Toggling edit mode re-renders; wait for hit regions to be rebuilt.
    await sleep(400);

    const compSnapshot = new Map(
      app.state.model.listComponents().map((p) => [p, app.state.model.getComponentRaw(p)])
    );
    const regions = app.state.renderer.hitRegions;
    out.regionCount = regions.length;
    let region = null;
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (r.layer && r.w > 2 && r.h > 2 && r.x >= 0 && r.y >= 0 && r.x < 480 && r.y < 222) { region = r; break; }
    }
    if (region) {
      const rect = canvas.getBoundingClientRect();
      out.rectWidth = rect.width;
      const cx = rect.left + ((region.x + region.w / 2) / 480) * rect.width;
      const cy = rect.top + ((region.y + region.h / 2) / 222) * rect.height;

      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true }));
      out.dragStarted = !!app.state.drag;
      const origX = region.layer.x || 0;
      const origY = region.layer.y || 0;
      window.dispatchEvent(new MouseEvent('mousemove', {
        clientX: cx + (rect.width / 480) * 5,
        clientY: cy + (rect.height / 222) * 3,
        bubbles: true
      }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      out.dragDx = (region.layer.x || 0) - origX;
      out.dragDy = (region.layer.y || 0) - origY;
      out.dirtyAfterDrag = app.state.model.dirty;

      const beforeNudge = region.layer.x || 0;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      out.nudged = (region.layer.x || 0) - beforeNudge;

      // Drag/nudge edits live in the component cache until flushed; make sure
      // they reach the serialized file map.
      app.state.model.flushComponents();
      out.dragPersisted = app.state.model.listComponents().some(
        (p) => app.state.model.getComponentRaw(p) !== compSnapshot.get(p)
      );
      await sleep(250);
    }

    // ---- layers panel + properties inspector ----
    out.layersBoxVisible = !document.getElementById('layersBox').classList.contains('hidden');
    out.layerRowCount = document.querySelectorAll('#layerList .layer-row').length;
    const firstRow = document.querySelector('#layerList .layer-row');
    if (firstRow) {
      firstRow.click();
      await sleep(150);
      out.propsBoxVisible = !document.getElementById('propsBox').classList.contains('hidden');
      out.propRowCount = document.querySelectorAll('#propsFields .prop-row').length;
      out.layerSelected = !!(app.state.selected && app.state.selected.layer);

      // Edit X via the inspector.
      const xInput = document.querySelector('#propsFields .prop-row input[type="number"]');
      if (xInput) {
        const beforeX = (app.state.selected.layer && app.state.selected.layer.x) || 0;
        xInput.focus();
        xInput.value = '77';
        xInput.dispatchEvent(new Event('change'));
        await sleep(150);
        out.propXEdited = (app.state.selected.layer && app.state.selected.layer.x) === 77 && 77 !== beforeX;
      }

      // Visibility toggle.
      const eye = document.querySelector('#layerList .layer-row.active .eye');
      if (eye) {
        eye.click();
        await sleep(150);
        out.hiddenCount = app.state.hidden.size;
        eye.click();
        await sleep(150);
        out.hiddenCountRestored = app.state.hidden.size === 0;
      }

      // Delete a layer (undoable; the theme is reloaded later anyway).
      const del = document.querySelector('#layerList .layer-row .move button:last-child');
      if (del) {
        const beforeRows = document.querySelectorAll('#layerList .layer-row').length;
        del.click();
        await sleep(200);
        out.layerDeleted = document.querySelectorAll('#layerList .layer-row').length < beforeRows;
      }
    }

    // ---- asset import ----
    const beforeAssets = document.querySelectorAll('#assetGrid .asset-cell').length;
    document.getElementById('btnImportAssets').click();
    await sleep(500);
    out.assetsBefore = beforeAssets;
    out.assetsAfter = document.querySelectorAll('#assetGrid .asset-cell').length;
    out.hasImportedAsset = app.state.model.has('assets/test.png');

    // ---- validation ----
    document.getElementById('btnRunValidation').click();
    await sleep(150);
    out.validationSummary = document.getElementById('validationSummary').textContent;
    out.validationOk = document.querySelectorAll('#validationResults .v-entry.ok').length;
    out.validationProblems = document.querySelectorAll('#validationResults .v-entry.error, #validationResults .v-entry.warn').length;

    // ---- export ----
    const files = app.serialize();
    out.serializedCount = files.length;
    const themeFile = files.find((f) => f.path === 'theme.json');
    const themeJson = JSON.parse(new TextDecoder().decode(Zip.base64ToBytes(themeFile.base64)));
    out.exportColorCount = Object.keys(themeJson.color_palette || {}).length;
    out.exportThemeVersion = themeJson.theme_version;
    out.zipBase64 = Zip.build(files);

    // ---- undo / redo + shortcuts ----
    const redBefore = Object.assign({}, app.state.model.getPalette().red);
    app.history.push();
    app.state.model.setColor('red', { r: 1, g: 2, b: 3 });
    await app.renderPreview();
    out.undoEnabled = !document.getElementById('btnUndo').disabled;
    document.getElementById('btnUndo').click();
    await sleep(300);
    const redAfterUndo = app.state.model.getPalette().red;
    out.undoRestored = redAfterUndo.r === redBefore.r && redAfterUndo.g === redBefore.g;
    out.redoEnabled = !document.getElementById('btnRedo').disabled;
    document.getElementById('btnRedo').click();
    await sleep(300);
    out.redoRestored = app.state.model.getPalette().red.r === 1;

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await sleep(300);
    out.ctrlZRestored = app.state.model.getPalette().red.r === redBefore.r;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
    await sleep(300);
    out.ctrlShiftZRestored = app.state.model.getPalette().red.r === 1;

    // Restore the original red for the remaining checks.
    app.state.model.setColor('red', redBefore);
    await app.renderPreview();

    // ---- palette import validation ----
    const imported = app.importPaletteText(JSON.stringify({
      color_palette: { red: '#010203', cyan: { r: 300, g: 2.7, b: -5 } }
    }));
    out.paletteImportOk = imported.red.r === 1 && imported.red.g === 2 && imported.red.b === 3 &&
      imported.cyan.r === 255 && imported.cyan.g === 3 && imported.cyan.b === 0;
    let paletteRejected = false;
    try { app.importPaletteText('[1,2,3]'); } catch (e) { paletteRejected = /expected an object/.test(e.message); }
    out.paletteRejected = paletteRejected;

    // ---- palette JSON + preview PNG export ----
    document.getElementById('btnExportPalette').click();
    await sleep(300);
    document.getElementById('btnSavePreview').click();
    await sleep(700);

    // ---- animation-frame preview control ----
    const compSelect = document.getElementById('previewComponent');
    compSelect.value = 'components/boot_animation.json';
    compSelect.dispatchEvent(new Event('change'));
    await sleep(700);
    out.frameRowVisible = !document.getElementById('frameRow').classList.contains('hidden');
    const frame0Hash = hash();
    document.getElementById('previewFrame').value = '1';
    document.getElementById('previewFrame').dispatchEvent(new Event('input'));
    await sleep(400);
    out.frameChanged = hash() !== frame0Hash;

    // ---- multi-page preview control ----
    let multiPage = null;
    for (const p of app.state.model.listComponents()) {
      const screens = renderer.listScreens(app.state.model.getComponent(p));
      if (screens.some((s) => s.screen && Array.isArray(s.screen.pages) && s.screen.pages.length > 1)) {
        multiPage = p;
        break;
      }
    }
    if (multiPage) {
      compSelect.value = multiPage;
      compSelect.dispatchEvent(new Event('change'));
      await sleep(700);
      out.pageRowVisible = !document.getElementById('pageRow').classList.contains('hidden');
      const page0Hash = hash();
      document.getElementById('previewPage').value = '1';
      document.getElementById('previewPage').dispatchEvent(new Event('input'));
      await sleep(400);
      out.pageChanged = hash() !== page0Hash;
    }

    // ---- metadata version writes through to theme.json ----
    const versionInput = document.getElementById('metaVersion');
    versionInput.value = '9.9.9';
    versionInput.dispatchEvent(new Event('input'));
    out.versionWritten = (app.state.model.getThemeJson() || {}).theme_version === '9.9.9';

    // ---- raw theme.json editor: apply, reject, reload ----
    document.querySelector('.nav-item[data-tab="themejson"]').click();
    await sleep(120);
    const tjEditor = document.getElementById('themeJsonEditor');
    const originalThemeText = tjEditor.value;
    const tjObj = JSON.parse(originalThemeText);
    tjObj.theme_version = '7.7.7';
    tjEditor.value = JSON.stringify(tjObj, null, 2);
    tjEditor.dispatchEvent(new Event('input'));
    out.themeJsonDirtyBeforeApply = app.state.themeJsonDirty === true;
    document.getElementById('btnApplyThemeJson').click();
    await sleep(350);
    out.themeJsonApplied = (app.state.model.getThemeJson() || {}).theme_version === '7.7.7';
    out.themeJsonDirtyAfterApply = app.state.themeJsonDirty;
    out.themeJsonStatus = document.getElementById('themeJsonStatus').textContent;

    const versionBeforeInvalid = (app.state.model.getThemeJson() || {}).theme_version;
    tjEditor.value = '{ not valid json';
    tjEditor.dispatchEvent(new Event('input'));
    document.getElementById('btnApplyThemeJson').click();
    await sleep(150);
    out.themeJsonRejected = (app.state.model.getThemeJson() || {}).theme_version === versionBeforeInvalid &&
      app.state.themeJsonDirty === true &&
      /Invalid JSON/.test(document.getElementById('themeJsonStatus').textContent);

    // Unsaved raw JSON must survive a tab round-trip.
    document.querySelector('.nav-item[data-tab="components"]').click();
    document.querySelector('.nav-item[data-tab="themejson"]').click();
    await sleep(120);
    out.themeJsonPreserved = /not valid json/.test(tjEditor.value) && app.state.themeJsonDirty === true;

    document.getElementById('btnReloadThemeJson').click();
    await sleep(120);
    out.themeJsonReloaded = app.state.themeJsonDirty === false && !/not valid json/.test(tjEditor.value);

    // Ctrl+Enter applies theme.json.
    tjEditor.value = JSON.stringify(Object.assign(JSON.parse(tjEditor.value), { theme_version: '6.6.6' }), null, 2);
    tjEditor.dispatchEvent(new Event('input'));
    tjEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await sleep(250);
    out.themeJsonCtrlEnter = (app.state.model.getThemeJson() || {}).theme_version === '6.6.6' &&
      app.state.themeJsonDirty === false;

    // ---- validation badge + jump-to-editor actions ----
    const badTj = JSON.parse(tjEditor.value);
    badTj.generic_menus = Object.assign({}, badTj.generic_menus, {
      __missing_test: 'components/__missing_test__.json'
    });
    tjEditor.value = JSON.stringify(badTj, null, 2);
    document.getElementById('btnApplyThemeJson').click();
    await sleep(350);
    const badge = document.getElementById('validationBadge');
    out.validationBadgeVisible = !badge.classList.contains('hidden') && badge.classList.contains('error');
    out.validationBadgeText = badge.textContent;
    out.validationOpenButtons = document.querySelectorAll('#validationResults .v-open').length;
    const openBtn = document.querySelector('#validationResults .v-open');
    if (openBtn) {
      openBtn.click();
      await sleep(120);
      const active = document.querySelector('.nav-item.active');
      out.validationJumpTab = active ? active.dataset.tab : null;
    }
    tjEditor.value = originalThemeText;
    document.getElementById('btnApplyThemeJson').click();
    await sleep(350);
    out.validationBadgeCleared = badge.classList.contains('hidden');

    // ---- component create / duplicate / rename / delete ----
    document.querySelector('.nav-item[data-tab="components"]').click();
    await sleep(120);
    promptQueue = ['components/test_component.json'];
    document.getElementById('btnNewComponent').click();
    await sleep(200);
    out.componentCreated = app.state.model.has('components/test_component.json') &&
      app.state.selectedComponent === 'components/test_component.json';

    promptQueue = ['components/test_component_copy.json'];
    document.getElementById('btnDuplicateComponent').click();
    await sleep(200);
    out.componentDuplicated = app.state.model.has('components/test_component_copy.json') &&
      app.state.selectedComponent === 'components/test_component_copy.json';

    promptQueue = ['components/test_component_renamed.json'];
    document.getElementById('btnRenameComponent').click();
    await sleep(200);
    out.componentRenamed = app.state.model.has('components/test_component_renamed.json') &&
      !app.state.model.has('components/test_component_copy.json');

    document.getElementById('btnDeleteComponent').click();
    await sleep(200);
    out.componentDeleted = !app.state.model.has('components/test_component_renamed.json');

    // Renaming a referenced component must update theme.json and other
    // component files that point at the old path.
    const referenced = app.state.model.referencedComponentPaths()[0];
    let renameRefsOk = false;
    if (referenced) {
      const item = Array.from(document.querySelectorAll('#componentList li'))
        .find((li) => li.textContent.startsWith(referenced));
      if (item) {
        item.click();
        const newRef = referenced.replace(/\.json$/i, '_renamed.json');
        promptQueue = [newRef];
        document.getElementById('btnRenameComponent').click();
        await sleep(250);
        const tjText = app.state.model.getText('theme.json') || '';
        renameRefsOk = app.state.model.has(newRef) &&
          tjText.includes(newRef) && !tjText.includes('"' + referenced + '"');
        promptQueue = [referenced];
        document.getElementById('btnRenameComponent').click();
        await sleep(250);
      }
    }
    out.componentReferenceRename = renameRefsOk;

    // ---- component import / Ctrl+Enter apply / export ----
    out.componentImported = app.importComponentText(
      JSON.stringify({ screen_name: 'imported_test', pages: [] }, null, 2),
      'components/imported_test.json',
      false
    );
    out.importedExists = app.state.model.has('components/imported_test.json');
    const compEditor = document.getElementById('componentEditor');
    compEditor.value = JSON.stringify({ screen_name: 'imported_test', pages: [{ menu_items: [] }] }, null, 2);
    compEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await sleep(200);
    const importedComp = app.state.model.getComponent('components/imported_test.json');
    out.componentCtrlEnter = importedComp && Array.isArray(importedComp.pages) && importedComp.pages.length === 1;
    out.componentExportName = await app.exportComponent();

    // ---- fit zoom, coordinate readout, 5px snap ----
    const zoomSel = document.getElementById('previewZoom');
    const wrap = document.getElementById('previewCanvasWrap');
    zoomSel.value = 'fit';
    zoomSel.dispatchEvent(new Event('change'));
    await sleep(180);
    out.fitZoom = app.state.preview.zoomMode === 'fit' &&
      parseFloat(canvas.style.width) > 0 &&
      parseFloat(canvas.style.width) <= wrap.clientWidth;
    zoomSel.value = '2';
    zoomSel.dispatchEvent(new Event('change'));
    await sleep(120);

    const crect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('mousemove', {
      clientX: crect.left + crect.width / 2,
      clientY: crect.top + crect.height / 2,
      bubbles: true
    }));
    out.coords = document.getElementById('previewCoords').textContent;
    out.coordsOk = /x:\\s*240/.test(out.coords) && /y:\\s*111/.test(out.coords);

    editMode.checked = true;
    editMode.dispatchEvent(new Event('change'));
    await sleep(350);
    const snapCheckbox = document.getElementById('snapGrid');
    out.snapDefaultOff = snapCheckbox.checked === false;
    const snapRegions = app.state.renderer.hitRegions;
    let snapRegion = null;
    for (let i = snapRegions.length - 1; i >= 0; i--) {
      const r = snapRegions[i];
      if (r.layer && r.w > 2 && r.h > 2 && r.x >= 0 && r.y >= 0 && r.x < 480 && r.y < 222) {
        snapRegion = r;
        break;
      }
    }
    if (snapRegion) {
      const rect2 = canvas.getBoundingClientRect();
      const sx = rect2.left + ((snapRegion.x + snapRegion.w / 2) / 480) * rect2.width;
      const sy = rect2.top + ((snapRegion.y + snapRegion.h / 2) / 222) * rect2.height;
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: sx, clientY: sy, bubbles: true }));
      snapCheckbox.checked = true;
      window.dispatchEvent(new MouseEvent('mousemove', {
        clientX: sx + (rect2.width / 480) * 3,
        clientY: sy + (rect2.height / 222) * 3,
        bubbles: true
      }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      out.snapApplied = (snapRegion.layer.x || 0) % 5 === 0 && (snapRegion.layer.y || 0) % 5 === 0;
      snapCheckbox.checked = false;
    }
    editMode.checked = false;
    editMode.dispatchEvent(new Event('change'));
    await sleep(250);

    // ---- asset usage count + drag-and-drop import ----
    document.querySelector('.nav-item[data-tab="assets"]').click();
    await sleep(120);
    let referencedAsset = null;
    for (const p of app.state.model.listComponents()) {
      const comp = app.state.model.getComponent(p);
      if (!comp || comp.__parseError) continue;
      const visit = (n) => {
        if (referencedAsset) return;
        if (Array.isArray(n)) { n.forEach(visit); return; }
        if (n && typeof n === 'object') {
          for (const v of Object.values(n)) {
            if (typeof v === 'string' && v.startsWith('assets/') && app.state.model.has(v)) {
              referencedAsset = v;
              return;
            }
            visit(v);
          }
        }
      };
      visit(comp);
      if (referencedAsset) break;
    }
    if (referencedAsset) {
      const assetCell = Array.from(document.querySelectorAll('#assetGrid .asset-cell')).find((el) => {
        const name = el.querySelector('.asset-name');
        return name && name.textContent === referencedAsset;
      });
      if (assetCell) {
        assetCell.click();
        await sleep(120);
        out.assetUsageShown = /used\\s+\\d+×/.test(document.getElementById('assetInfo').textContent);
      }
    }

    // ---- asset rename updates references ----
    if (referencedAsset) {
      const ext = referencedAsset.slice(referencedAsset.lastIndexOf('.'));
      const stem = referencedAsset.slice(0, referencedAsset.lastIndexOf('.'));
      const renamedAsset = stem + '_renamed' + ext;
      promptQueue = [renamedAsset];
      document.getElementById('btnRenameAsset').click();
      await sleep(250);
      let foundNew = false;
      for (const p of app.state.model.listComponents()) {
        if ((app.state.model.getText(p) || '').includes(renamedAsset)) { foundNew = true; break; }
      }
      out.assetRenamed = app.state.model.has(renamedAsset) && !app.state.model.has(referencedAsset) && foundNew;
      promptQueue = [referencedAsset];
      document.getElementById('btnRenameAsset').click();
      await sleep(250);
      out.assetRenameReverted = app.state.model.has(referencedAsset) && !app.state.model.has(renamedAsset);
    }

    out.assetsBeforeDrop = document.querySelectorAll('#assetGrid .asset-cell').length;
    const dropBytes = Uint8Array.from(atob('${TINY_PNG}'), (c) => c.charCodeAt(0));
    const droppedFile = new File([dropBytes], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(droppedFile);
    document.getElementById('assetGrid').dispatchEvent(new DragEvent('drop', {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true
    }));
    await sleep(600);
    out.dropImported = app.state.model.has('assets/dropped.png');
    out.dropCount = document.querySelectorAll('#assetGrid .asset-cell').length;

    // ---- unused asset flag + cleanup ----
    const droppedCell = Array.from(document.querySelectorAll('#assetGrid .asset-cell')).find((el) => {
      const n = el.querySelector('.asset-name');
      return n && n.textContent === 'assets/dropped.png';
    });
    out.unusedAssetFlagged = !!(droppedCell && droppedCell.classList.contains('unused'));
    const beforeUnused = document.querySelectorAll('#assetGrid .asset-cell').length;
    document.getElementById('btnDeleteUnusedAssets').click();
    await sleep(400);
    out.unusedDeleted = !app.state.model.has('assets/dropped.png') &&
      !app.state.model.has('assets/test.png') &&
      document.querySelectorAll('#assetGrid .asset-cell').length < beforeUnused;

    // ---- case-insensitive collision validation + duplicate theme ----
    app.state.model.setFile('case-test.txt', 'x', false);
    app.state.model.setFile('CASE-test.txt', 'x', false);
    document.getElementById('btnRunValidation').click();
    await sleep(200);
    out.caseCollisionWarned = Array.from(document.querySelectorAll('#validationResults .v-entry.warn'))
      .some((el) => /differ only by case/.test(el.textContent));
    app.state.model.deleteFile('case-test.txt');
    app.state.model.deleteFile('CASE-test.txt');

    out.dupBeforeCount = app.state.model.listAllFiles().length;
    document.getElementById('btnDuplicate').click();
    await sleep(600);
    out.duplicateSlug = /-copy/.test(app.state.model.themeDirName);
    out.duplicateFileCount = app.state.model.listAllFiles().length;
    out.duplicateDirty = app.state.model.dirty === true;

    // ---- reloading a theme clears stale image caches ----
    document.getElementById('btnNew').click();
    await sleep(1500);
    out.reloadedAssets = document.querySelectorAll('#assetGrid .asset-cell').length;
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlank = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) nonBlank++;
    out.reloadedNonBlank = nonBlank;

    // ---- blank theme ----
    app.startBlankTheme();
    await sleep(400);
    out.blankFileCount = app.state.model.listAllFiles().length;
    out.blankHasPalette = Object.keys(app.state.model.getPalette()).length === 30;
    out.blankUndoDisabled = document.getElementById('btnUndo').disabled;
    out.blankPreviewOptions = document.querySelectorAll('#previewComponent option').length;

    return out;
  })().catch((e) => ({ __scriptError: String((e && e.stack) || e) }))`);
  } catch (e) {
    console.error('EXEC_REJECT ' + ((e && e.stack) || e));
    console.log('RENDERER_ERRORS ' + JSON.stringify(rendererErrors));
    app.exit(1);
    return;
  }

  if (!result || result.__scriptError) {
    console.error('FAIL renderer script: ' + (result && result.__scriptError));
    console.log('RENDERER_ERRORS ' + JSON.stringify(rendererErrors));
    app.exit(1);
    return;
  }

  const zipBase64 = result.zipBase64;
  delete result.zipBase64;

  // Inspect files the renderer asked to save (palette JSON, preview PNG).
  result.savedFileNames = savedFiles.map((f) => f.defaultName);
  const paletteSave = savedFiles.find((f) => /-palette\.json$/.test(f.defaultName || ''));
  if (paletteSave) {
    try {
      const parsed = JSON.parse(Buffer.from(paletteSave.base64, 'base64').toString('utf8'));
      result.paletteExportOk = !!(parsed.color_palette &&
        Object.keys(parsed.color_palette).length === 30);
    } catch (e) {
      result.paletteExportOk = false;
    }
  }
  const pngSave = savedFiles.find((f) => /\.png$/.test(f.defaultName || ''));
  if (pngSave) {
    const buf = Buffer.from(pngSave.base64, 'base64');
    result.pngExportOk = buf.length > 100 &&
      buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (result.pngExportOk) {
      result.pngWidth = buf.readUInt32BE(16);
      result.pngHeight = buf.readUInt32BE(20);
    }
  }
  const componentSave = savedFiles.find((f) => (f.defaultName || '').endsWith('imported_test.json'));
  if (componentSave) {
    try {
      const parsed = JSON.parse(Buffer.from(componentSave.base64, 'base64').toString('utf8'));
      result.componentExportOk = parsed.screen_name === 'imported_test' &&
        Array.isArray(parsed.pages) && parsed.pages.length === 1;
    } catch (e) {
      result.componentExportOk = false;
    }
  }

  const zipPath = path.join(OUT_DIR, 'export-test.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipBase64, 'base64'));

  // Validate with the system unzip tool (independent of our own reader).
  let unzipOk = false;
  let unzipEntries = 0;
  try {
    const listing = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
    unzipOk = /No errors detected/.test(listing);
    unzipEntries = (listing.match(/testing:/g) || []).length;
  } catch (e) {
    result.unzipError = String(e.message || e);
  }
  result.unzipOk = unzipOk;
  result.unzipEntries = unzipEntries;

  // Also verify our own reader can reopen the exported ZIP.
  const parsed = await win.webContents.executeJavaScript(
    `(async () => {
      const res = await Zip.parse(${JSON.stringify(zipBase64)});
      return { count: res.files.length };
    })()`
  ).catch((e) => ({ error: String(e) }));
  result.selfParse = parsed;

  console.log('INTERACTION_RESULT ' + JSON.stringify(result));
  if (rendererErrors.length) console.log('RENDERER_ERRORS ' + JSON.stringify(rendererErrors));

  const ok = result &&
    result.previewOptions > 0 &&
    result.colorCells === 30 &&
    result.componentItems > 0 &&
    result.assetCells > 0 &&
    result.colorChanged === true &&
    result.recolorCached === true &&
    result.recolorInvalidated === true &&
    result.wrapOk === true &&
    result.newlineOk === true &&
    Array.isArray(result.templateScreens) && result.templateScreens.length > 0 &&
    !!result.keyboardComp &&
    Array.isArray(result.keyboardScreens) && result.keyboardScreens.includes('input_area') &&
    Array.isArray(result.imageScreens) && result.imageScreens.length > 0 &&
    result.truthyDefault === true &&
    result.truthyOff === false &&
    result.truthyOn === true &&
    result.varOverride === true &&
    result.variablesBoxVisible === true &&
    result.hasPayloadVar === true &&
    result.varInputApplied === true &&
    result.simulateRegionFound === true &&
    result.simulatedJump === true &&
    result.backStackLen === 1 &&
    result.undoEnabled === true &&
    result.undoRestored === true &&
    result.redoRestored === true &&
    result.ctrlZRestored === true &&
    result.ctrlShiftZRestored === true &&
    result.paletteImportOk === true &&
    result.paletteRejected === true &&
    result.paletteExportOk === true &&
    result.pngExportOk === true &&
    result.pngWidth === 480 && result.pngHeight === 222 &&
    result.frameRowVisible === true &&
    result.frameChanged === true &&
    result.pageRowVisible === true &&
    result.pageChanged === true &&
    result.versionWritten === true &&
    result.themeJsonDirtyBeforeApply === true &&
    result.themeJsonApplied === true &&
    result.themeJsonDirtyAfterApply === false &&
    result.themeJsonRejected === true &&
    result.themeJsonPreserved === true &&
    result.themeJsonReloaded === true &&
    result.validationBadgeVisible === true &&
    result.validationBadgeCleared === true &&
    result.validationJumpTab === 'components' &&
    result.validationOpenButtons > 0 &&
    result.componentCreated === true &&
    result.componentDuplicated === true &&
    result.componentRenamed === true &&
    result.componentDeleted === true &&
    result.componentReferenceRename === true &&
    result.componentImported === true &&
    result.importedExists === true &&
    result.componentCtrlEnter === true &&
    !!result.componentExportName &&
    result.componentExportOk === true &&
    result.fitZoom === true &&
    result.coordsOk === true &&
    result.snapDefaultOff === true &&
    result.snapApplied === true &&
    result.assetUsageShown === true &&
    result.assetRenamed === true &&
    result.assetRenameReverted === true &&
    result.dropImported === true &&
    result.dropCount === result.assetsBeforeDrop + 1 &&
    result.unusedAssetFlagged === true &&
    result.unusedDeleted === true &&
    result.caseCollisionWarned === true &&
    result.duplicateSlug === true &&
    result.duplicateFileCount === result.dupBeforeCount &&
    result.duplicateDirty === true &&
    result.reloadedAssets === 163 &&
    result.reloadedNonBlank > 0 &&
    result.blankFileCount === 2 &&
    result.blankHasPalette === true &&
    result.blankUndoDisabled === true &&
    result.blankPreviewOptions === 0 &&
    result.dragStarted === true &&
    result.dragDx === 5 && result.dragDy === 3 &&
    result.nudged === 1 &&
    result.dragPersisted === true &&
    result.layersBoxVisible === true &&
    result.layerRowCount > 0 &&
    result.propsBoxVisible === true &&
    result.propRowCount > 0 &&
    result.layerSelected === true &&
    result.propXEdited === true &&
    result.hiddenCount === 1 &&
    result.hiddenCountRestored === true &&
    result.layerDeleted === true &&
    result.hasImportedAsset === true &&
    result.assetsAfter === result.assetsBefore + 1 &&
    result.validationOk === 1 &&
    result.validationProblems === 0 &&
    result.unzipOk === true &&
    result.selfParse && result.selfParse.count === result.serializedCount &&
    rendererErrors.length === 0;

  app.exit(ok ? 0 : 1);
});
