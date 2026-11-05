// End-to-end smoke test: boots the real renderer under Electron, loads the
// bundled reference theme, and verifies the UI + preview render correctly.
// Run with:  node_modules/.bin/electron test/smoke.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const REF = path.join(__dirname, '..', 'reference', 'wargames');
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

ipcMain.handle('loadReferenceTree', () => readTree(REF));
ipcMain.handle('openThemeFolder', () => null);
ipcMain.handle('readTree', () => null);
ipcMain.handle('pickSaveFolder', () => null);
ipcMain.handle('saveThemeToFolder', () => ({ ok: true }));
ipcMain.handle('joinPath', (e, a, b) => path.join(a, b));
ipcMain.handle('saveZip', () => null);
ipcMain.handle('openZip', () => null);
ipcMain.handle('pickAssetFiles', () => []);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: false }
  });

  win.webContents.on('console-message', (...args) => {
    const rest = args.slice(1).map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)));
    console.log('[renderer]', rest.join(' '));
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 3000));

  const result = await win.webContents.executeJavaScript(`(async () => {
    const canvas = document.getElementById('previewCanvas');
    const ctx = canvas.getContext('2d');
    let nonBlank = 0;
    let colors = 0;
    try {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] || d[i+1] || d[i+2]) nonBlank++;
        if (d[i] || d[i+1] || d[i+2]) colors++;
      }
    } catch (e) { return { error: String(e) }; }
    return {
      themeModel: !!window.ThemeModel,
      previewRenderer: !!window.PreviewRenderer,
      zip: !!window.Zip,
      colorCells: document.querySelectorAll('#colorGrid .color-cell').length,
      componentItems: document.querySelectorAll('#componentList li').length,
      assetCells: document.querySelectorAll('#assetGrid .asset-cell').length,
      previewOptions: document.querySelectorAll('#previewComponent option').length,
      previewNonBlankPixels: nonBlank,
      projectName: document.getElementById('projectName').textContent
    };
  })()`);

  console.log('SMOKE_RESULT ' + JSON.stringify(result));
  const ok = result && !result.error && result.previewNonBlankPixels > 0 && result.colorCells === 30 && result.componentItems > 0 && result.assetCells > 0;
  app.exit(ok ? 0 : 1);
});
