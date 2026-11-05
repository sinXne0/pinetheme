const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif',
  '.raw', '.rgb', '.ttf', '.otf', '.woff', '.woff2', '.bin', '.wav',
  '.mp3', '.ogg', '.mid', '.rtttl', '.so', '.ko', '.gz', '.zip'
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
    title: 'Pager Theme Builder',
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
      detail: 'Discard your changes and close Pager Theme Builder?'
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
