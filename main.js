const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif',
  '.raw', '.rgb', '.ttf', '.otf', '.woff', '.woff2', '.bin', '.wav',
  '.mp3', '.ogg', '.mid', '.rtttl', '.so', '.ko', '.gz', '.zip', '.svg'
]);

function isBinaryName(relPath) {
  return BINARY_EXT.has(path.extname(relPath).toLowerCase());
}

const REFERENCE_PATH = path.join(__dirname, 'reference', 'wargames');

function readTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.DS_Store' || e.name === 'node_modules') continue;
      const abs = path.join(d, e.name);
      const relp = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        walk(abs, relp);
      } else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        out.push({ path: relp, base64: buf.toString('base64'), binary: isBinaryName(relp) });
      }
    }
  };
  walk(dir, '');
  return { name: path.basename(dir), files: out };
}

function safeJoin(dir, rel) {
  const resolved = path.resolve(dir, rel);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path traversal blocked: ' + rel);
  }
  return resolved;
}

function writeTree(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const abs = safeJoin(dir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(f.base64, 'base64'));
  }
  return { ok: true, count: files.length };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: 'PineTheme Studio',
    backgroundColor: '#040608',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Ask before closing a window with unsaved edits. The renderer reports its
  // dirty state over IPC whenever it changes.
  win.__dirty = false;
  win.__forceClose = false;
  win.on('close', (e) => {
    if (!win.__dirty || win.__forceClose) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Discard changes'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Discard your changes and close PineTheme Studio?'
    });
    if (choice === 1) win.__forceClose = true;
    else e.preventDefault();
  });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  return win;
}

// ---- IPC handlers ---------------------------------------------------------

ipcMain.handle('loadReferenceTree', () => {
  if (!fs.existsSync(REFERENCE_PATH)) {
    throw new Error('Bundled reference theme not found at ' + REFERENCE_PATH);
  }
  return readTree(REFERENCE_PATH);
});

ipcMain.handle('openThemeFolder', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Open a theme folder',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const folderPath = res.filePaths[0];
  return { tree: readTree(folderPath), folderPath };
});

ipcMain.handle('joinPath', (event, parent, name) => {
  return path.join(parent, name);
});

ipcMain.handle('readTree', (event, p) => readTree(p));

ipcMain.handle('pickSaveFolder', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose where to save the theme',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('saveThemeToFolder', async (event, files, folderPath) => {
  return writeTree(folderPath, files);
});

ipcMain.handle('saveZip', async (event, base64, defaultName) => {
  const res = await dialog.showSaveDialog({
    title: 'Export theme as ZIP',
    defaultPath: defaultName || 'theme.zip',
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(base64, 'base64'));
  return res.filePath;
});

// Save an arbitrary base64 payload (preview PNG, palette JSON, ...).
ipcMain.handle('saveBinaryFile', async (event, base64, defaultName, filters) => {
  const res = await dialog.showSaveDialog({
    title: 'Save file',
    defaultPath: defaultName || 'file',
    filters: Array.isArray(filters) && filters.length ? filters : undefined
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(base64, 'base64'));
  return res.filePath;
});

// Renderer reports unsaved changes so the window close handler can prompt.
ipcMain.on('setDirty', (event, dirty) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.__dirty = !!dirty;
});

ipcMain.handle('openZip', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Open a theme ZIP',
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const buf = fs.readFileSync(res.filePaths[0]);
  return { name: path.basename(res.filePaths[0]), base64: buf.toString('base64') };
});

ipcMain.handle('pickAssetFiles', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Import image assets',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || !res.filePaths.length) return [];
  return res.filePaths.map((p) => ({
    name: path.basename(p),
    base64: fs.readFileSync(p).toString('base64')
  }));
});

// ---- theme library --------------------------------------------------------
function countTree(dir) {
  let files = 0, components = 0, assets = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.DS_Store' || e.name === 'node_modules') continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        stack.push(abs);
      } else if (e.isFile()) {
        files++;
        try { bytes += fs.statSync(abs).size; } catch (e) { /* ignore */ }
        const rel = path.relative(dir, abs).replace(/\\/g, '/');
        if (rel.startsWith('components/') && rel.endsWith('.json')) components++;
        if (rel.startsWith('assets/')) assets++;
      }
    }
  }
  return { files, components, assets, bytes };
}

function readThemeMeta(dir) {
  const tjPath = path.join(dir, 'theme.json');
  if (!fs.existsSync(tjPath)) return null;
  let tj = {};
  try { tj = JSON.parse(fs.readFileSync(tjPath, 'utf8')); } catch (e) { return null; }
  const counts = countTree(dir);
  let readme = '';
  for (const name of ['README.md', 'README']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      try { readme = fs.readFileSync(p, 'utf8').slice(0, 4000); } catch (e) { /* ignore */ }
      break;
    }
  }
  const author = tj.author || ((readme.match(/Author:\s*(.+)/i) || [])[1] || '').trim();
  const palette = tj.color_palette || {};
  const swatches = Object.values(palette).slice(0, 16).map((c) =>
    '#' + [c.r || 0, c.g || 0, c.b || 0].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
  );
  return {
    name: path.basename(dir),
    path: dir,
    title: tj.theme_name || tj.name || path.basename(dir),
    author,
    version: String(tj.theme_version || ''),
    framework: String(tj.theme_framework_version || ''),
    components: counts.components,
    assets: counts.assets,
    files: counts.files,
    bytes: counts.bytes,
    swatches,
    hasThemeJson: true
  };
}

function scanThemeRepo(dir) {
  let themesDir = dir;
  const nested = path.join(dir, 'themes');
  try {
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) themesDir = nested;
  } catch (e) { /* ignore */ }
  const themes = [];
  try {
    const entries = fs.readdirSync(themesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      const meta = readThemeMeta(path.join(themesDir, e.name));
      if (meta) themes.push(meta);
    }
  } catch (e) { /* ignore */ }
  // A single theme folder was selected.
  if (!themes.length) {
    const meta = readThemeMeta(dir);
    if (meta) themes.push(meta);
  }
  themes.sort((a, b) => a.name.localeCompare(b.name));
  return { folderPath: themesDir, themes };
}

ipcMain.handle('pickThemeRepo', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose a themes repository or a themes folder',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return scanThemeRepo(res.filePaths[0]);
});

ipcMain.handle('scanThemeRepo', (event, dir) => {
  if (!dir || !fs.existsSync(dir)) return null;
  return scanThemeRepo(dir);
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
