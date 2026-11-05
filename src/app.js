(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const hasElectron = !!(window.api);

  const state = {
    model: new ThemeModel(),
    renderer: null,
    openedFolder: null,          // absolute path to the theme folder on disk (or null)
    currentTab: 'metadata',
    selectedComponent: null,
    selectedAsset: null,
    preview: {
      componentPath: null,
      variantIndex: 0,
      selectedIndex: 0,
      pageIndex: 0,
      frameIndex: 0,
      zoom: 2,
      zoomMode: 'fixed'
    },
    selected: null,              // { layer, item } identity of the selected element
    drag: null,
    themeJsonDirty: false,
    variables: {},
    backStack: [],
    hidden: new Set()            // layer/item objects hidden from the preview
  };

  // ---- undo / redo --------------------------------------------------------
  // Snapshots hold a shallow copy of the file map. File entries are immutable
  // (setFile always creates a new object), so this is cheap even for a 301-file
  // theme, and flushComponents() keeps identities stable when nothing changed.
  const history = {
    undoStack: [],
    redoStack: [],
    limit: 80,

    snapshot() {
      state.model.flushComponents();
      return {
        files: new Map(state.model.files),
        meta: Object.assign({}, state.model.meta),
        themeDirName: state.model.themeDirName
      };
    },

    same(a, b) {
      if (!a || !b) return false;
      if (a.files.size !== b.files.size) return false;
      for (const [path, file] of a.files) if (b.files.get(path) !== file) return false;
      return a.themeDirName === b.themeDirName &&
        JSON.stringify(a.meta) === JSON.stringify(b.meta);
    },

    push() {
      const snap = this.snapshot();
      if (this.same(snap, this.undoStack[this.undoStack.length - 1])) return false;
      this.undoStack.push(snap);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
      updateHistoryButtons();
      return true;
    },

    undo() {
      if (!this.undoStack.length) return false;
      const current = this.snapshot();
      const snap = this.undoStack.pop();
      this.redoStack.push(current);
      restoreSnapshot(snap);
      updateHistoryButtons();
      return true;
    },

    redo() {
      if (!this.redoStack.length) return false;
      const current = this.snapshot();
      const snap = this.redoStack.pop();
      this.undoStack.push(current);
      restoreSnapshot(snap);
      updateHistoryButtons();
      return true;
    },

    clear() {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
      updateHistoryButtons();
    }
  };

  function updateHistoryButtons() {
    const u = $('btnUndo');
    const r = $('btnRedo');
    if (u) u.disabled = history.undoStack.length === 0;
    if (r) r.disabled = history.redoStack.length === 0;
  }

  function restoreSnapshot(snap) {
    state.model.files = new Map(snap.files);
    state.model._componentCache.clear();
    state.model.meta = Object.assign({}, snap.meta);
    state.model.themeDirName = snap.themeDirName;
    state.model.dirty = true;
    state.renderer.setModel(state.model);
    state.selected = null;

    syncMetaFromModel();
    refreshEnabled();
    renderColors();
    renderComponentList();
    renderAssets();
    renderValidation(null);
    if (!state.themeJsonDirty) refreshThemeJsonEditor();

    if (state.selectedComponent && !state.model.has(state.selectedComponent)) {
      state.selectedComponent = null;
      $('componentPath').textContent = '—';
      $('componentEditor').value = '';
      $('componentStatus').textContent = 'Select a component to edit its JSON.';
    } else if (state.selectedComponent) {
      selectComponent(state.selectedComponent);
    }

    if (!state.preview.componentPath || !state.model.has(state.preview.componentPath)) {
      const tj = state.model.getThemeJson() || {};
      state.preview.componentPath = (tj.generic_menus && tj.generic_menus.dashboard_path) ||
        state.model.referencedComponentPaths()[0] ||
        state.model.listComponents()[0] ||
        null;
      state.preview.variantIndex = 0;
      state.preview.selectedIndex = 0;
      state.preview.pageIndex = 0;
      state.preview.frameIndex = 0;
    }
    populatePreviewComponentSelect();
    renderPreview();
    runValidation();
  }

  // ---- toast --------------------------------------------------------------
  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ---- dirty tracking -----------------------------------------------------
  function refreshEnabled() {
    const has = state.model.listAllFiles().length > 0;
    ['btnSave', 'btnSaveAs', 'btnExport', 'btnValidate', 'btnDuplicate'].forEach((id) => { $(id).disabled = !has; });
    const dirty = state.model.dirty;
    $('dirtyBadge').classList.toggle('hidden', !dirty);
    $('projectName').textContent = state.model.meta.name || state.model.themeDirName || 'No theme loaded';
    if (window.api && window.api.setDirty) window.api.setDirty(dirty);
  }

  function markDirty() {
    state.model.dirty = true;
    refreshEnabled();
    schedulePreview();
  }

  function onModelChanged() {
    refreshEnabled();
    schedulePreview();
  }

  // ---- preview scheduling -------------------------------------------------
  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => renderPreview(), 150);
  }

  // Coalesce rapid drag updates to at most one render per animation frame.
  let previewRaf = null;
  function requestPreviewRender() {
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(() => {
      previewRaf = null;
      renderPreview();
    });
  }

  // ---- tabs ---------------------------------------------------------------
  function setTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab));
    if (tab === 'validation') runValidation();
    if (tab === 'themejson' && !state.themeJsonDirty) refreshThemeJsonEditor();
  }

  // ---- raw theme.json editor ---------------------------------------------
  function setThemeJsonStatus(msg, isError) {
    const el = $('themeJsonStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? 'var(--danger)' : '';
  }

  function refreshThemeJsonEditor() {
    const editor = $('themeJsonEditor');
    if (!editor) return;
    editor.value = state.model.getThemeJsonRaw();
    state.themeJsonDirty = false;
    setThemeJsonStatus('Edit the manifest JSON, then click Apply.', false);
  }

  function syncMetaFromThemeJson() {
    const tj = state.model.getThemeJson();
    if (!tj) return;
    if (tj.theme_version != null) state.model.meta.version = String(tj.theme_version);
    if (tj.theme_framework_version != null) state.model.meta.frameworkVersion = String(tj.theme_framework_version);
  }

  function applyThemeJson() {
    const editor = $('themeJsonEditor');
    const text = editor.value;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      setThemeJsonStatus('Invalid JSON: ' + e.message, true);
      toast('theme.json was not applied — invalid JSON', true);
      return false;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      setThemeJsonStatus('theme.json must contain a JSON object.', true);
      toast('theme.json was not applied — expected an object', true);
      return false;
    }

    history.push();
    state.model.setThemeJson(obj);
    state.themeJsonDirty = false;
    syncMetaFromThemeJson();
    syncMetaFromModel();
    refreshEnabled();
    renderColors();
    renderComponentList();
    editor.value = JSON.stringify(obj, null, 2);
    setThemeJsonStatus('Applied ✓', false);

    // Keep the preview pointed at a component that still exists.
    if (!state.preview.componentPath || !state.model.has(state.preview.componentPath)) {
      const tj = state.model.getThemeJson() || {};
      state.preview.componentPath = (tj.generic_menus && tj.generic_menus.dashboard_path) ||
        state.model.referencedComponentPaths()[0] ||
        state.model.listComponents()[0] ||
        null;
      state.preview.variantIndex = 0;
      state.preview.selectedIndex = 0;
      state.preview.pageIndex = 0;
      state.preview.frameIndex = 0;
    }
    populatePreviewComponentSelect();
    markDirty();
    renderPreview();
    runValidation();
    state.themeJsonDirty = false;
    toast('Applied theme.json');
    return true;
  }

  function formatThemeJson() {
    const editor = $('themeJsonEditor');
    let obj;
    try {
      obj = JSON.parse(editor.value);
    } catch (e) {
      setThemeJsonStatus('Cannot format — invalid JSON: ' + e.message, true);
      return;
    }
    editor.value = JSON.stringify(obj, null, 2);
    state.themeJsonDirty = true;
    setThemeJsonStatus('Formatted — click Apply to update the theme.', false);
  }

  function reloadThemeJson() {
    if (state.themeJsonDirty && !confirm('Discard unsaved theme.json edits?')) return;
    refreshThemeJsonEditor();
    toast('Reloaded theme.json from the current theme');
  }

  function bindThemeJson() {
    $('themeJsonEditor').addEventListener('input', () => {
      state.themeJsonDirty = true;
      setThemeJsonStatus('Unsaved changes — click Apply to update the theme.', false);
    });
    $('btnApplyThemeJson').addEventListener('click', applyThemeJson);
    $('btnFormatThemeJson').addEventListener('click', formatThemeJson);
    $('btnReloadThemeJson').addEventListener('click', reloadThemeJson);
    $('themeJsonEditor').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        applyThemeJson();
      }
    });
  }

  // ---- project loading ----------------------------------------------------
  function confirmDiscard() {
    if (!state.model.dirty) return true;
    return confirm('Discard unsaved changes to "' +
      (state.model.meta.name || state.model.themeDirName) + '"?');
  }

  function applyLoaded() {
    // Drop cached images/recolors from any previously loaded theme.
    state.renderer.setModel(state.model);
    syncMetaFromModel();
    refreshEnabled();
    renderColors();
    renderComponentList();
    renderAssets();
    refreshThemeJsonEditor();
    history.clear();
    // pick a sensible default component to preview
    const tj = state.model.getThemeJson() || {};
    const def = (tj.generic_menus && tj.generic_menus.dashboard_path) ||
      state.model.referencedComponentPaths()[0] ||
      state.model.listComponents()[0];
    state.preview.componentPath = def || null;
    state.preview.variantIndex = 0;
    state.preview.selectedIndex = 0;
    state.preview.pageIndex = 0;
    state.preview.frameIndex = 0;
    populatePreviewComponentSelect();
    renderPreview();
    runValidation();
  }

  async function startNewTheme() {
    if (!confirmDiscard()) return;
    let tree;
    if (hasElectron) {
      tree = await window.api.loadReferenceTree();
    } else {
      tree = scaffoldTree();
    }
    state.model.setFilesFromTree(tree);
    state.model.themeDirName = 'my-theme';
    state.model.meta.name = 'Untitled Theme';
    state.model.meta.author = '';
    state.model.meta.description = '';
    state.openedFolder = null;
    state.model.ensureReadme();
    state.model.dirty = false;
    applyLoaded();
    toast('New theme created from the bundled reference');
  }

  function scaffoldTree() {
    // Browser fallback: a minimal, valid theme with just the default palette.
    const themeJson = {
      theme_version: '2.0.0',
      theme_framework_version: '0.9',
      color_palette: Object.assign({}, Palette.DEFAULT)
    };
    const files = [
      { path: 'theme.json', base64: Zip.bytesToBase64(new TextEncoder().encode(JSON.stringify(themeJson, null, 2))), binary: false },
      { path: 'README.md', base64: Zip.bytesToBase64(new TextEncoder().encode('# Untitled Theme\n')), binary: false }
    ];
    return { name: 'my-theme', files };
  }

  function startBlankTheme() {
    if (!confirmDiscard()) return;
    state.model.setFilesFromTree(scaffoldTree());
    state.model.themeDirName = 'my-theme';
    state.model.meta.name = 'Untitled Theme';
    state.model.meta.author = '';
    state.model.meta.description = '';
    state.openedFolder = null;
    state.model.ensureReadme();
    state.model.dirty = false;
    applyLoaded();
    toast('Blank theme created — add components and assets before installing');
  }

  function nextCopySlug(slug) {
    const s = String(slug || 'my-theme');
    const m = s.match(/^(.*)-copy(\d*)$/);
    if (m) {
      const n = m[2] ? parseInt(m[2], 10) + 1 : 2;
      return m[1] + '-copy' + n;
    }
    return s + '-copy';
  }

  function duplicateTheme() {
    state.model.flushComponents();
    const clone = new Map();
    for (const [k, v] of state.model.files) clone.set(k, v);
    state.model.files = clone;
    state.model._componentCache.clear();
    state.model.themeDirName = nextCopySlug(state.model.themeDirName);
    state.openedFolder = null;
    state.model.dirty = true;
    applyLoaded();
    toast('Duplicated theme as ' + state.model.themeDirName);
  }

  async function openFolder() {
    if (!hasElectron) { toast('Folder open requires the Electron app', true); return; }
    if (!confirmDiscard()) return;
    const res = await window.api.openThemeFolder();
    if (!res) return;
    state.model.setFilesFromTree(res.tree);
    state.openedFolder = res.folderPath;
    applyLoaded();
    toast('Opened ' + res.tree.name);
  }

  async function openZip() {
    if (!confirmDiscard()) return;
    if (hasElectron) {
      const res = await window.api.openZip();
      if (!res) return;
      await loadFromZipBase64(res.base64, res.name, true);
    } else {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip';
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        const buf = await f.arrayBuffer();
        await loadFromZipBase64(Zip.bytesToBase64(new Uint8Array(buf)), f.name);
      };
      input.click();
    }
  }

  async function loadFromZipBase64(base64, name, skipConfirm) {
    if (!skipConfirm && !confirmDiscard()) return;
    try {
      const { files } = await Zip.parse(base64);
      const tree = { name: name.replace(/\.zip$/i, ''), files };
      state.model.setFilesFromTree(tree);
      state.openedFolder = null;
      applyLoaded();
      toast('Opened ZIP: ' + name);
    } catch (e) {
      toast('Failed to open ZIP: ' + e.message, true);
    }
  }

  // ---- saving / export ----------------------------------------------------
  async function saveAs() {
    if (!hasElectron) { toast('Saving folders requires the Electron app', true); return; }
    state.model.ensureReadme();
    const parent = await window.api.pickSaveFolder();
    if (!parent) return;
    const target = await window.api.joinPath(parent, state.model.themeDirName);
    await window.api.saveThemeToFolder(state.model.serializeFiles(), target);
    state.openedFolder = target;
    state.model.dirty = false;
    refreshEnabled();
    toast('Saved theme to ' + target);
  }

  async function save() {
    if (!hasElectron) { toast('Saving folders requires the Electron app', true); return; }
    state.model.ensureReadme();
    if (!state.openedFolder) return saveAs();
    await window.api.saveThemeToFolder(state.model.serializeFiles(), state.openedFolder);
    state.model.dirty = false;
    refreshEnabled();
    toast('Saved to ' + state.openedFolder);
  }

  async function saveBase64File(base64, name, filters) {
    if (hasElectron) {
      return window.api.saveBinaryFile(base64, name, filters);
    }
    const a = document.createElement('a');
    a.href = 'data:application/octet-stream;base64,' + base64;
    a.download = name;
    a.click();
    return name;
  }

  function previewPngBase64() {
    const cv = $('previewCanvas');
    const dataUrl = cv.toDataURL('image/png');
    return dataUrl.replace(/^data:image\/png;base64,/, '');
  }

  async function savePreviewPng() {
    const comp = (state.preview.componentPath || 'preview')
      .replace(/^components\//, '')
      .replace(/\.json$/i, '')
      .replace(/[^a-z0-9_-]+/gi, '-');
    const name = state.model.slugify(state.model.meta.name) + '-' + comp + '.png';
    const saved = await saveBase64File(previewPngBase64(), name, [
      { name: 'PNG image', extensions: ['png'] }
    ]);
    if (saved) toast('Saved preview to ' + saved);
  }

  async function exportZip() {
    state.model.ensureReadme();
    state.model.flushComponents();

    // Surface validation problems before producing a package that may not
    // install cleanly on the Pager.
    const results = Validators.validate(state.model);
    renderValidation(results);
    if (results.errors.length) {
      const proceed = confirm(
        'This theme has ' + results.errors.length + ' validation error(s).\n\n' +
        'Export anyway?'
      );
      if (!proceed) {
        setTab('validation');
        toast('Export cancelled — fix validation errors first', true);
        return;
      }
    }

    const base64 = Zip.build(state.model.serializeFiles());
    const name = state.model.slugify(state.model.meta.name) + '.zip';
    if (hasElectron) {
      const saved = await window.api.saveZip(base64, name);
      if (saved) toast('Exported ' + saved);
    } else {
      const a = document.createElement('a');
      a.href = 'data:application/zip;base64,' + base64;
      a.download = name;
      a.click();
      toast('Exported ' + name);
    }
  }

  // ---- metadata -----------------------------------------------------------
  function syncMetaFromModel() {
    const m = state.model.meta;
    $('metaName').value = m.name || '';
    $('metaAuthor').value = m.author || '';
    $('metaVersion').value = m.version || '';
    $('metaFramework').value = m.frameworkVersion || '';
    $('metaDescription').value = m.description || '';
    $('metaDirName').value = state.model.themeDirName || '';
  }

  function bindMetadata() {
    const onField = (id, key) => {
      $(id).addEventListener('focus', () => history.push());
      $(id).addEventListener('input', () => {
        state.model.meta[key] = $(id).value;
        if (key === 'name') state.model.themeDirName = state.model.slugify($(id).value);
        if (key === 'version' || key === 'frameworkVersion') {
          const tj = Object.assign({}, state.model.getThemeJson() || {});
          if (key === 'version') tj.theme_version = $(id).value;
          else tj.theme_framework_version = $(id).value;
          state.model.setThemeJson(tj);
        }
        markDirty();
        if (key === 'name') { $('projectName').textContent = state.model.meta.name; $('metaDirName').value = state.model.themeDirName; }
      });
    };
    onField('metaName', 'name');
    onField('metaAuthor', 'author');
    onField('metaVersion', 'version');
    onField('metaFramework', 'frameworkVersion');
    onField('metaDescription', 'description');
    $('metaDirName').addEventListener('focus', () => history.push());
    $('metaDirName').addEventListener('input', () => {
      state.model.themeDirName = state.model.slugify($('metaDirName').value);
      markDirty();
    });
    $('btnSlugify').addEventListener('click', () => {
      history.push();
      state.model.themeDirName = state.model.slugify(state.model.meta.name);
      $('metaDirName').value = state.model.themeDirName;
      markDirty();
    });
  }

  // ---- colors -------------------------------------------------------------
  function renderColors() {
    const grid = $('colorGrid');
    grid.innerHTML = '';
    const palette = state.model.getPalette();
    const names = Object.keys(palette).sort();
    for (const name of names) {
      const c = palette[name];
      const hex = Palette.toHex(c);
      const cell = document.createElement('div');
      cell.className = 'color-cell';
      cell.dataset.name = name;

      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.style.background = hex;
      swatch.style.color = Palette.isLight(c) ? '#000' : '#fff';
      swatch.textContent = hex;

      const label = document.createElement('div');
      label.className = 'color-name';
      label.textContent = name;

      const row = document.createElement('div');
      row.className = 'color-row';

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = hex;

      const text = document.createElement('input');
      text.type = 'text';
      text.value = hex;

      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = '×';
      rm.title = 'Remove color';

      row.appendChild(picker);
      row.appendChild(text);
      row.appendChild(rm);
      cell.appendChild(swatch);
      cell.appendChild(label);
      cell.appendChild(row);
      grid.appendChild(cell);

      swatch.addEventListener('click', () => picker.click());
      picker.addEventListener('focus', () => history.push());
      text.addEventListener('focus', () => history.push());
      picker.addEventListener('input', () => {
        const nc = Palette.fromHex(picker.value);
        state.model.setColor(name, nc);
        text.value = picker.value;
        swatch.style.background = picker.value;
        swatch.style.color = Palette.isLight(nc) ? '#000' : '#fff';
        swatch.textContent = picker.value;
        markDirty();
      });
      text.addEventListener('change', () => {
        const nc = Palette.fromHex(text.value);
        const hx = Palette.toHex(nc);
        state.model.setColor(name, nc);
        text.value = hx;
        picker.value = hx;
        swatch.style.background = hx;
        swatch.style.color = Palette.isLight(nc) ? '#000' : '#fff';
        swatch.textContent = hx;
        markDirty();
      });
      rm.addEventListener('click', () => {
        if (confirm('Remove color "' + name + '"?')) {
          history.push();
          state.model.removeColor(name);
          markDirty();
          renderColors();
        }
      });
    }
  }

  function bindColors() {
    $('btnAddColor').addEventListener('click', () => {
      const raw = $('newColorName').value.trim();
      const name = raw.replace(/[^a-z0-9_]/gi, '_').toLowerCase() || 'new_color';
      history.push();
      state.model.addColor(name);
      $('newColorName').value = '';
      markDirty();
      renderColors();
      toast('Added color "' + name + '"');
    });
    $('btnImportPalette').addEventListener('click', importPalette);
    $('btnExportPalette').addEventListener('click', exportPalette);
    $('btnResetPalette').addEventListener('click', resetPalette);
  }

  // ---- palette import / export -------------------------------------------
  function normalizePalette(data) {
    const raw = data && typeof data === 'object' && data.color_palette
      ? data.color_palette
      : data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('expected an object of color names');
    }
    const out = {};
    for (const [name, val] of Object.entries(raw)) {
      if (typeof val === 'string') {
        out[name] = Palette.fromHex(val);
      } else if (val && typeof val === 'object' &&
                 Number.isFinite(Number(val.r)) &&
                 Number.isFinite(Number(val.g)) &&
                 Number.isFinite(Number(val.b))) {
        out[name] = {
          r: Palette.clamp(Number(val.r)),
          g: Palette.clamp(Number(val.g)),
          b: Palette.clamp(Number(val.b))
        };
      } else {
        throw new Error('invalid color "' + name + '"');
      }
    }
    if (!Object.keys(out).length) throw new Error('palette is empty');
    return out;
  }

  function importPaletteText(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('not valid JSON');
    }
    return normalizePalette(data);
  }

  function importPalette() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const palette = importPaletteText(await f.text());
        history.push();
        state.model.setPalette(palette);
        markDirty();
        renderColors();
        toast('Imported ' + Object.keys(palette).length + ' colors');
      } catch (e) {
        toast('Palette import failed: ' + e.message, true);
      }
    };
    input.click();
  }

  async function exportPalette() {
    const text = JSON.stringify({ color_palette: state.model.getPalette() }, null, 2);
    const name = state.model.slugify(state.model.meta.name) + '-palette.json';
    const base64 = Zip.bytesToBase64(new TextEncoder().encode(text));
    const saved = await saveBase64File(base64, name, [
      { name: 'JSON', extensions: ['json'] }
    ]);
    if (saved) toast('Exported palette to ' + saved);
  }

  function resetPalette() {
    if (!confirm('Reset all colors to the default palette?')) return;
    history.push();
    state.model.setPalette(Object.assign({}, Palette.DEFAULT));
    markDirty();
    renderColors();
    toast('Palette reset to defaults');
  }

  // ---- components ---------------------------------------------------------
  function componentBaseName(path) {
    return String(path || '').replace(/^components\//, '').replace(/\.json$/i, '');
  }

  function normalizeComponentPath(input) {
    let s = String(input || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!s) return null;
    if (!s.startsWith('components/')) s = 'components/' + s;
    if (!/\.json$/i.test(s)) s += '.json';
    const parts = s.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) return null;
    if (!/^components\/.+\.json$/i.test(s)) return null;
    return s;
  }

  function walkJsonStrings(node, fn) {
    if (typeof node === 'string') { fn(node); return; }
    if (Array.isArray(node)) { for (const v of node) walkJsonStrings(v, fn); return; }
    if (node && typeof node === 'object') {
      for (const v of Object.values(node)) walkJsonStrings(v, fn);
    }
  }

  function replaceJsonString(node, oldValue, newValue) {
    let count = 0;
    const walk = (n) => {
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) {
          if (n[i] === oldValue) { n[i] = newValue; count++; }
          else walk(n[i]);
        }
      } else if (n && typeof n === 'object') {
        for (const k of Object.keys(n)) {
          if (n[k] === oldValue) { n[k] = newValue; count++; }
          else walk(n[k]);
        }
      }
    };
    walk(node);
    return count;
  }

  function countJsonString(node, value) {
    let count = 0;
    walkJsonStrings(node, (s) => { if (s === value) count++; });
    return count;
  }

  // Update path references in theme.json and every component JSON. This keeps
  // renamed components and assets wired up instead of silently breaking the theme.
  function replacePathReferences(oldPath, newPath) {
    let count = 0;
    const tj = state.model.getThemeJson();
    if (tj) {
      const next = JSON.parse(JSON.stringify(tj));
      const n = replaceJsonString(next, oldPath, newPath);
      if (n) {
        state.model.setThemeJson(next);
        count += n;
      }
    }
    for (const path of state.model.listComponents()) {
      const raw = state.model.getComponentRaw(path);
      if (raw == null) continue;
      let obj;
      try { obj = JSON.parse(raw); } catch (e) { continue; }
      const n = replaceJsonString(obj, oldPath, newPath);
      if (n) {
        state.model.setComponentRaw(path, JSON.stringify(obj, null, 2));
        count += n;
      }
    }
    return count;
  }

  function countComponentReferences(path) {
    let count = 0;
    const tj = state.model.getThemeJson();
    if (tj) count += countJsonString(tj, path);
    for (const p of state.model.listComponents()) {
      if (p === path) continue;
      const comp = state.model.getComponent(p);
      if (comp && !comp.__parseError) count += countJsonString(comp, path);
    }
    return count;
  }

  function updateComponentButtons() {
    const has = !!state.selectedComponent && state.model.has(state.selectedComponent);
    $('btnDuplicateComponent').disabled = !has;
    $('btnRenameComponent').disabled = !has;
    $('btnDeleteComponent').disabled = !has;
    $('btnExportComponent').disabled = !has;
  }

  function newComponentTemplate(path) {
    const palette = Object.keys(state.model.getPalette());
    const color = palette.includes('blue') ? 'blue' : (palette[0] || 'white');
    const selectedColor = palette.includes('yellow') ? 'yellow' : color;
    const name = componentBaseName(path).split('/').pop();
    return {
      screen_name: name,
      windowed_canvas: true,
      cache_canvases: false,
      pages: [{
        page_index: 0,
        menu_items: [{
          id: 'item1',
          x: 110,
          y: 20,
          layers: [{ text: 'New Item', text_color_palette: color }],
          selected_layers: [{ text: 'New Item', text_color_palette: selectedColor }],
          target: 'back'
        }]
      }]
    };
  }

  function createComponent() {
    const raw = prompt('New component path (under components/):', 'components/new_component.json');
    if (raw == null) return;
    const path = normalizeComponentPath(raw);
    if (!path) { toast('Invalid component path', true); return; }
    if (state.model.has(path)) { toast(path + ' already exists', true); return; }
    history.push();
    state.model.setComponentRaw(path, JSON.stringify(newComponentTemplate(path), null, 2));
    markDirty();
    renderComponentList();
    selectComponent(path);
    populatePreviewComponentSelect();
    toast('Created ' + path);
  }

  function duplicateComponent() {
    const src = state.selectedComponent;
    if (!src || !state.model.has(src)) return;
    const suggested = src.replace(/\.json$/i, '_copy.json');
    const raw = prompt('Duplicate component as:', suggested);
    if (raw == null) return;
    const path = normalizeComponentPath(raw);
    if (!path) { toast('Invalid component path', true); return; }
    if (path === src) { toast('Choose a different name', true); return; }
    if (state.model.has(path)) { toast(path + ' already exists', true); return; }
    let obj;
    try {
      obj = JSON.parse(state.model.getComponentRaw(src) || 'null');
    } catch (e) {
      toast('Cannot duplicate — source JSON is invalid', true);
      return;
    }
    if (!obj || typeof obj !== 'object') { toast('Cannot duplicate this component', true); return; }
    history.push();
    const copy = JSON.parse(JSON.stringify(obj));
    if (typeof copy.screen_name === 'string') copy.screen_name = componentBaseName(path).split('/').pop();
    state.model.setComponentRaw(path, JSON.stringify(copy, null, 2));
    markDirty();
    renderComponentList();
    selectComponent(path);
    populatePreviewComponentSelect();
    toast('Duplicated to ' + path);
  }

  function renameComponent() {
    const oldPath = state.selectedComponent;
    if (!oldPath || !state.model.has(oldPath)) return;
    const raw = prompt('Rename component to:', oldPath);
    if (raw == null) return;
    const newPath = normalizeComponentPath(raw);
    if (!newPath) { toast('Invalid component path', true); return; }
    if (newPath === oldPath) return;
    if (state.model.has(newPath)) { toast(newPath + ' already exists', true); return; }

    history.push();
    const text = state.model.getComponentRaw(oldPath) || '';
    state.model.deleteFile(oldPath);
    state.model._componentCache.delete(oldPath);
    state.model.setFile(newPath, text, false);
    state.model._componentCache.delete(newPath);
    const refs = replacePathReferences(oldPath, newPath);

    if (state.preview.componentPath === oldPath) state.preview.componentPath = newPath;
    state.selectedComponent = newPath;
    markDirty();
    renderComponentList();
    selectComponent(newPath);
    populatePreviewComponentSelect();
    renderPreview();
    runValidation();
    toast('Renamed to ' + newPath + (refs ? ' (' + refs + ' reference' + (refs === 1 ? '' : 's') + ' updated)' : ''));
  }

  function deleteComponent() {
    const path = state.selectedComponent;
    if (!path || !state.model.has(path)) return;
    const refs = countComponentReferences(path);
    let msg = 'Delete ' + path + '?';
    if (refs) {
      msg += '\n\nIt is referenced ' + refs + ' time' + (refs === 1 ? '' : 's') +
        '. Those references will be left in place and validation will flag them.';
    }
    if (!confirm(msg)) return;

    history.push();
    state.model.deleteFile(path);
    state.model._componentCache.delete(path);
    if (state.preview.componentPath === path) state.preview.componentPath = null;
    state.selectedComponent = null;
    $('componentPath').textContent = '—';
    $('componentEditor').value = '';
    $('componentStatus').textContent = 'Select a component to edit its JSON.';
    $('componentStatus').style.color = '';
    markDirty();
    renderComponentList();

    if (!state.preview.componentPath) {
      const tj = state.model.getThemeJson() || {};
      state.preview.componentPath = (tj.generic_menus && tj.generic_menus.dashboard_path) ||
        state.model.referencedComponentPaths()[0] ||
        state.model.listComponents()[0] ||
        null;
    }
    populatePreviewComponentSelect();
    renderPreview();
    runValidation();
    toast('Deleted ' + path);
  }

  function importComponentText(text, path, overwrite) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      toast('Invalid component JSON: ' + e.message, true);
      return false;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      toast('Component must be a JSON object', true);
      return false;
    }
    const target = normalizeComponentPath(path);
    if (!target) { toast('Invalid component path', true); return false; }
    if (state.model.has(target) && !overwrite) {
      toast(target + ' already exists', true);
      return false;
    }
    history.push();
    state.model.setComponentRaw(target, text);
    markDirty();
    renderComponentList();
    selectComponent(target);
    populatePreviewComponentSelect();
    toast('Imported ' + target);
    return true;
  }

  function importComponent() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      const text = await f.text();
      const defaultPath = 'components/' + (f.name || 'component.json');
      const raw = prompt('Component path:', defaultPath);
      if (raw == null) return;
      importComponentText(text, raw, false);
    };
    input.click();
  }

  async function exportComponent() {
    const path = state.selectedComponent;
    if (!path || !state.model.has(path)) return null;
    state.model.flushComponents();
    const text = state.model.getComponentRaw(path) || '';
    const name = path.split('/').pop();
    const base64 = Zip.bytesToBase64(new TextEncoder().encode(text));
    const saved = await saveBase64File(base64, name, [{ name: 'JSON', extensions: ['json'] }]);
    if (saved) toast('Exported ' + saved);
    return saved;
  }

  function renderComponentList() {
    const list = $('componentList');
    list.innerHTML = '';
    if (state.selectedComponent && !state.model.has(state.selectedComponent)) {
      state.selectedComponent = null;
    }
    const referenced = new Set(state.model.referencedComponentPaths());
    const filter = $('componentFilter').value.toLowerCase();
    const comps = state.model.listComponents().filter((p) => !filter || p.toLowerCase().includes(filter));
    for (const path of comps) {
      const li = document.createElement('li');
      li.textContent = path;
      li.classList.toggle('active', path === state.selectedComponent);
      if (referenced.has(path)) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = '●';
        b.title = 'Referenced in theme.json';
        li.appendChild(b);
      }
      li.addEventListener('click', () => selectComponent(path));
      list.appendChild(li);
    }
    updateComponentButtons();
  }

  function selectComponent(path) {
    state.selectedComponent = path;
    state.model.flushComponents();
    const raw = state.model.getComponentRaw(path) || '';
    $('componentPath').textContent = path;
    $('componentEditor').value = raw;
    $('componentStatus').textContent = '';
    $('componentStatus').style.color = '';
    renderComponentList();
    updateComponentButtons();
  }

  function bindComponents() {
    $('componentFilter').addEventListener('input', renderComponentList);
    $('btnNewComponent').addEventListener('click', createComponent);
    $('btnDuplicateComponent').addEventListener('click', duplicateComponent);
    $('btnRenameComponent').addEventListener('click', renameComponent);
    $('btnDeleteComponent').addEventListener('click', deleteComponent);
    $('btnImportComponent').addEventListener('click', importComponent);
    $('btnExportComponent').addEventListener('click', exportComponent);
    $('componentEditor').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('btnSaveComponent').click();
      }
    });
    $('btnSaveComponent').addEventListener('click', () => {
      if (!state.selectedComponent) return;
      try {
        history.push();
        state.model.setComponentRaw(state.selectedComponent, $('componentEditor').value);
        $('componentStatus').textContent = 'Saved ✓';
        $('componentStatus').style.color = 'var(--accent2)';
        markDirty();
        renderComponentList();
      } catch (e) {
        $('componentStatus').textContent = 'Invalid JSON: ' + e.message;
        $('componentStatus').style.color = 'var(--danger)';
      }
    });
    $('btnPreviewComponent').addEventListener('click', () => {
      if (!state.selectedComponent) return;
      state.preview.componentPath = state.selectedComponent;
      state.preview.variantIndex = 0;
      state.preview.selectedIndex = 0;
      state.preview.pageIndex = 0;
      state.preview.frameIndex = 0;
      $('previewComponent').value = state.selectedComponent;
      renderPreview();
    });
  }

  // ---- assets -------------------------------------------------------------
  const assetCells = new Map();
  let assetUsage = new Map();

  function assetMime(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp'
    }[ext] || 'image/png';
  }

  function formatBytes(bytes) {
    return bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
  }

  function tallyStrings(node, map) {
    walkJsonStrings(node, (s) => {
      if (typeof s === 'string' && s.startsWith('assets/')) {
        map.set(s, (map.get(s) || 0) + 1);
      }
    });
  }

  function refreshAssetUsage() {
    const map = new Map();
    const tj = state.model.getThemeJson();
    if (tj) tallyStrings(tj, map);
    for (const p of state.model.listComponents()) {
      const comp = state.model.getComponent(p);
      if (comp && !comp.__parseError) tallyStrings(comp, map);
    }
    assetUsage = map;
    return map;
  }

  function countAssetReferences(path) {
    return assetUsage.get(path) || 0;
  }

  function normalizeAssetPath(input) {
    let s = String(input || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!s) return null;
    if (!s.startsWith('assets/')) s = 'assets/' + s;
    const parts = s.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) return null;
    if (!/^assets\/.+$/i.test(s)) return null;
    return s;
  }

  function selectAsset(path) {
    state.selectedAsset = path;
    for (const [p, cell] of assetCells) cell.classList.toggle('selected', p === path);
    $('btnReplaceAsset').disabled = !path;
    $('btnRenameAsset').disabled = !path;
    $('btnDeleteAsset').disabled = !path;
    const info = $('assetInfo');
    if (!path) {
      info.textContent = 'Select an asset to see its size and usage.';
      return;
    }
    const b64 = state.model.getBase64(path) || '';
    const size = formatBytes(Math.round(b64.length * 3 / 4));
    const refs = countAssetReferences(path);
    const usage = refs ? 'used ' + refs + '×' : 'unused';
    info.textContent = path + ' — ' + size + ' — ' + usage;
    if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(path)) {
      const img = new Image();
      img.onload = () => {
        if (state.selectedAsset === path) {
          info.textContent = path + ' — ' + img.naturalWidth + '×' + img.naturalHeight +
            ', ' + size + ' — ' + usage;
        }
      };
      img.src = 'data:' + assetMime(path) + ';base64,' + b64;
    }
  }

  function renderAssets() {
    const grid = $('assetGrid');
    grid.innerHTML = '';
    assetCells.clear();
    const usage = refreshAssetUsage();
    const all = state.model.listAssets();
    const filter = ($('assetFilter').value || '').toLowerCase();
    const assets = all.filter((p) => !filter || p.toLowerCase().includes(filter));
    const unusedCount = all.filter((p) => !usage.has(p) || usage.get(p) === 0).length;
    $('assetCount').textContent = assets.length + (filter ? ' of ' + all.length : '') +
      ' files' + (unusedCount ? ' · ' + unusedCount + ' unused' : '');
    for (const path of assets) {
      const b64 = state.model.getBase64(path);
      const used = usage.has(path) && usage.get(path) > 0;
      const cell = document.createElement('div');
      cell.className = 'asset-cell';
      cell.classList.toggle('selected', path === state.selectedAsset);
      cell.classList.toggle('unused', !used);

      const thumb = document.createElement('div');
      thumb.className = 'asset-thumb';
      if (b64) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = 'data:' + assetMime(path) + ';base64,' + b64;
        thumb.appendChild(img);
      } else {
        thumb.textContent = '?';
      }

      const name = document.createElement('div');
      name.className = 'asset-name';
      name.textContent = path;

      if (!used) {
        const badge = document.createElement('span');
        badge.className = 'unused-badge';
        badge.textContent = 'unused';
        cell.appendChild(thumb);
        cell.appendChild(name);
        cell.appendChild(badge);
      } else {
        cell.appendChild(thumb);
        cell.appendChild(name);
      }
      cell.addEventListener('click', () => selectAsset(path));
      assetCells.set(path, cell);
      grid.appendChild(cell);
    }
    if (state.selectedAsset && !state.model.has(state.selectedAsset)) state.selectedAsset = null;
    selectAsset(state.selectedAsset);
  }

  async function importAssets() {
    if (!hasElectron) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = async () => {
        history.push();
        for (const f of input.files) {
          const buf = await f.arrayBuffer();
          const assetPath = 'assets/' + f.name;
          state.renderer.invalidate(assetPath);
          state.model.setFile(assetPath, Zip.bytesToBase64(new Uint8Array(buf)), true);
        }
        markDirty();
        renderAssets();
      };
      input.click();
      return;
    }
    const picked = await window.api.pickAssetFiles();
    if (!picked.length) return;
    history.push();
    for (const p of picked) {
      const assetPath = 'assets/' + p.name;
      state.renderer.invalidate(assetPath);
      state.model.setFile(assetPath, p.base64, true);
    }
    markDirty();
    renderAssets();
    toast('Imported ' + picked.length + ' asset(s)');
  }

  async function replaceAsset() {
    if (!state.selectedAsset) return;
    if (!hasElectron) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        const buf = await f.arrayBuffer();
        history.push();
        state.renderer.invalidate(state.selectedAsset);
        state.model.setFile(state.selectedAsset, Zip.bytesToBase64(new Uint8Array(buf)), true);
        markDirty();
        renderAssets();
      };
      input.click();
      return;
    }
    const picked = await window.api.pickAssetFiles();
    if (!picked.length) return;
    history.push();
    state.renderer.invalidate(state.selectedAsset);
    state.model.setFile(state.selectedAsset, picked[0].base64, true);
    markDirty();
    renderAssets();
  }

  async function importDroppedAssets(fileList) {
    const files = Array.from(fileList || []).filter((f) =>
      /^image\//i.test(f.type || '') || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name || ''));
    if (!files.length) {
      toast('Drop image files to import them as assets', true);
      return;
    }
    history.push();
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const assetPath = 'assets/' + f.name;
      state.renderer.invalidate(assetPath);
      state.model.setFile(assetPath, Zip.bytesToBase64(new Uint8Array(buf)), true);
    }
    markDirty();
    renderAssets();
    toast('Imported ' + files.length + ' dropped asset' + (files.length === 1 ? '' : 's'));
  }

  function renameAsset() {
    const oldPath = state.selectedAsset;
    if (!oldPath || !state.model.has(oldPath)) return;
    const raw = prompt('Rename asset to:', oldPath);
    if (raw == null) return;
    const newPath = normalizeAssetPath(raw);
    if (!newPath) { toast('Invalid asset path', true); return; }
    if (newPath === oldPath) return;
    if (state.model.has(newPath)) { toast(newPath + ' already exists', true); return; }

    history.push();
    const entry = state.model.files.get(oldPath);
    // Preserve binary vs. text so a rename never corrupts a text asset.
    let content;
    if (entry.binary) {
      content = entry.base64;
    } else {
      content = state.model.getText(oldPath);
      if (content == null) content = '';
    }
    state.model.deleteFile(oldPath);
    state.model.setFile(newPath, content, !!entry.binary);
    state.renderer.invalidate(oldPath);
    state.renderer.invalidate(newPath);
    const refs = replacePathReferences(oldPath, newPath);

    state.selectedAsset = newPath;
    markDirty();
    renderAssets();
    selectAsset(newPath);
    renderPreview();
    runValidation();
    toast('Renamed to ' + newPath + (refs ? ' (' + refs + ' reference' + (refs === 1 ? '' : 's') + ' updated)' : ''));
  }

  function deleteUnusedAssets() {
    const usage = refreshAssetUsage();
    const unused = state.model.listAssets().filter((p) => !usage.has(p) || usage.get(p) === 0);
    if (!unused.length) { toast('No unused assets'); return; }
    if (!confirm('Delete ' + unused.length + ' unused asset' + (unused.length === 1 ? '' : 's') + '?')) return;
    history.push();
    for (const p of unused) {
      state.renderer.invalidate(p);
      state.model.deleteFile(p);
    }
    state.selectedAsset = null;
    $('btnReplaceAsset').disabled = true;
    $('btnRenameAsset').disabled = true;
    $('btnDeleteAsset').disabled = true;
    markDirty();
    renderAssets();
    toast('Deleted ' + unused.length + ' unused asset' + (unused.length === 1 ? '' : 's'));
  }

  function bindAssets() {
    $('btnImportAssets').addEventListener('click', importAssets);
    $('btnReplaceAsset').addEventListener('click', replaceAsset);
    $('btnRenameAsset').addEventListener('click', renameAsset);
    $('btnDeleteUnusedAssets').addEventListener('click', deleteUnusedAssets);
    $('assetFilter').addEventListener('input', renderAssets);
    $('btnDeleteAsset').addEventListener('click', () => {
      if (!state.selectedAsset) return;
      if (confirm('Delete ' + state.selectedAsset + '?')) {
        history.push();
        state.renderer.invalidate(state.selectedAsset);
        state.model.deleteFile(state.selectedAsset);
        state.selectedAsset = null;
        $('btnReplaceAsset').disabled = true;
        $('btnRenameAsset').disabled = true;
        $('btnDeleteAsset').disabled = true;
        markDirty();
        renderAssets();
      }
    });

    const grid = $('assetGrid');
    grid.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      grid.classList.add('drop-target');
    });
    grid.addEventListener('dragleave', () => grid.classList.remove('drop-target'));
    grid.addEventListener('drop', (e) => {
      e.preventDefault();
      grid.classList.remove('drop-target');
      if (e.dataTransfer) importDroppedAssets(e.dataTransfer.files);
    });

    // Dropping a file elsewhere in the window should not navigate away.
    window.addEventListener('dragover', (e) => { if (e.dataTransfer) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (e.target && e.target.closest && e.target.closest('#assetGrid')) return;
      e.preventDefault();
    });
  }

  // ---- validation ---------------------------------------------------------
  function renderValidation(results) {
    const box = $('validationResults');
    const badge = $('validationBadge');
    box.innerHTML = '';
    if (!results || !results.errors || !results.warnings) {
      $('validationSummary').textContent = '';
      if (badge) {
        badge.classList.add('hidden');
        badge.textContent = '';
      }
      return;
    }
    const { errors, warnings } = results;
    const total = errors.length + warnings.length;
    if (badge) {
      badge.classList.toggle('hidden', total === 0);
      badge.classList.toggle('error', errors.length > 0);
      badge.textContent = total ? String(total) : '';
      badge.title = total
        ? errors.length + ' error(s), ' + warnings.length + ' warning(s)'
        : 'No validation problems';
    }
    $('validationSummary').textContent = errors.length + ' error(s), ' + warnings.length + ' warning(s)';
    if (!errors.length && !warnings.length) {
      const ok = document.createElement('div');
      ok.className = 'v-entry ok';
      ok.innerHTML = '<span class="tag">OK</span>Theme looks good.';
      box.appendChild(ok);
      return;
    }
    for (const e of errors) box.appendChild(vEntry('error', e));
    for (const w of warnings) box.appendChild(vEntry('warn', w));
  }

  function validationJump(text) {
    if (/theme\.json/i.test(text)) return () => setTab('themejson');
    const comp = text.match(/components\/[^\s:]+\.json/);
    if (comp) {
      const path = comp[0];
      return () => {
        setTab('components');
        if (state.model.has(path)) selectComponent(path);
        else toast(path + ' is missing — create it or remove the reference', true);
      };
    }
    const asset = text.match(/assets\/[^\s:]+/);
    if (asset) {
      const path = asset[0];
      return () => {
        setTab('assets');
        $('assetFilter').value = path;
        renderAssets();
        if (state.model.has(path)) selectAsset(path);
      };
    }
    if (/palette color/i.test(text)) return () => setTab('colors');
    return null;
  }

  function vEntry(kind, text) {
    const d = document.createElement('div');
    d.className = 'v-entry ' + kind;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = kind === 'error' ? '✖' : '⚠';
    d.appendChild(tag);
    d.appendChild(document.createTextNode(text));
    const jump = validationJump(text);
    if (jump) {
      const btn = document.createElement('button');
      btn.className = 'v-open';
      btn.textContent = 'Open';
      btn.title = 'Open the relevant editor';
      btn.addEventListener('click', jump);
      d.appendChild(btn);
    }
    return d;
  }

  function runValidation() {
    state.model.flushComponents();
    renderValidation(Validators.validate(state.model));
  }

  // ---- preview ------------------------------------------------------------
  function populatePreviewComponentSelect() {
    const sel = $('previewComponent');
    const current = state.preview.componentPath;
    sel.innerHTML = '';
    const comps = state.model.listComponents();
    for (const p of comps) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      sel.appendChild(o);
    }
    if (current && comps.includes(current)) sel.value = current;
    else if (comps.length) { sel.value = comps[0]; state.preview.componentPath = comps[0]; }
  }

  function currentScreenItemCount() {
    const s = state.renderer && state.renderer.lastScreen;
    if (!s) return 0;
    if (s.menu_items) return s.menu_items.length;
    if (s.pages) {
      const page = s.pages[state.preview.pageIndex] || s.pages[0];
      return page && page.menu_items ? page.menu_items.length : 0;
    }
    return 0;
  }

  let previewChain = Promise.resolve();

  // Serialize preview renders. Returning the chain means callers that await
  // renderPreview() always see a frame drawn from the latest model state.
  function renderPreview() {
    const run = () => renderPreviewNow().catch((e) => {
      console.error('Preview render failed:', e);
    });
    previewChain = previewChain.then(run, run);
    return previewChain;
  }

  async function renderPreviewNow() {
    if (!state.preview.componentPath) return;
    state.renderer.setVariables(state.variables);
    const comp = state.model.getComponent(state.preview.componentPath);
    const screens = state.renderer.listScreens(comp);

    // variants
    const vSel = $('previewVariant');
    const showVariant = screens.length > 1 && screens[0].name !== '';
    $('variantRow').classList.toggle('hidden', !showVariant);
    if (showVariant) {
      vSel.innerHTML = '';
      screens.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = s.name || ('Screen ' + (i + 1));
        vSel.appendChild(o);
      });
      vSel.value = state.preview.variantIndex;
    }

    await state.renderer.render(state.preview.componentPath, {
      variantIndex: state.preview.variantIndex,
      selectedIndex: state.preview.selectedIndex,
      pageIndex: state.preview.pageIndex,
      frameIndex: state.preview.frameIndex,
      hidden: state.hidden
    });

    // page / animation-frame controls
    const screen = state.renderer.lastScreen;
    const pages = screen && Array.isArray(screen.pages) ? screen.pages : null;
    $('pageRow').classList.toggle('hidden', !pages || pages.length < 2);
    if (pages && pages.length > 1) {
      const pageInput = $('previewPage');
      pageInput.max = pages.length - 1;
      if (state.preview.pageIndex > pages.length - 1) state.preview.pageIndex = pages.length - 1;
      pageInput.value = state.preview.pageIndex;
      $('previewPageCount').textContent = '/ ' + (pages.length - 1);
    }
    const frames = screen && screen.animation && Array.isArray(screen.animation.frames)
      ? screen.animation.frames : null;
    $('frameRow').classList.toggle('hidden', !frames || frames.length < 2);
    if (frames && frames.length > 1) {
      const frameInput = $('previewFrame');
      frameInput.max = frames.length - 1;
      if (state.preview.frameIndex > frames.length - 1) state.preview.frameIndex = frames.length - 1;
      frameInput.value = state.preview.frameIndex;
      $('previewFrameCount').textContent = '/ ' + (frames.length - 1);
    }

    const count = currentScreenItemCount();
    const itemRow = $('itemRow');
    itemRow.classList.toggle('hidden', count === 0);
    $('previewItemCount').textContent = count ? '/ ' + (count - 1) : '';
    if (count) {
      const input = $('previewSelectedItem');
      input.max = count - 1;
      if (state.preview.selectedIndex > count - 1) state.preview.selectedIndex = count - 1;
      input.value = state.preview.selectedIndex;
    }

    drawSelectionOutline();
    renderVariables();
    renderLayers();
    renderProperties();
    updateSimBack();
  }

  // ---- simulation (click-through) + variable panel ------------------------
  function collectVariableNames(node, out) {
    if (Array.isArray(node)) { for (const v of node) collectVariableNames(v, out); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'variable_name' || k === 'variable') && typeof v === 'string' && v.startsWith('$')) out.add(v);
        else collectVariableNames(v, out);
      }
    }
  }

  const variableInputs = new Map();
  let lastVarKey = null;

  function renderVariables() {
    const box = $('variablesBox');
    const list = $('variableList');
    if (!box || !list) return;
    const comp = state.preview.componentPath ? state.model.getComponent(state.preview.componentPath) : null;
    const names = new Set();
    if (comp && !comp.__parseError) collectVariableNames(comp, names);
    const sorted = Array.from(names).sort();
    const key = state.preview.componentPath + '|' + sorted.join('|');
    if (key !== lastVarKey) {
      lastVarKey = key;
      variableInputs.clear();
      list.innerHTML = '';
      for (const name of sorted) {
        const row = document.createElement('div');
        row.className = 'variable-row';
        const label = document.createElement('label');
        label.textContent = name;
        const input = document.createElement('input');
        input.type = 'text';
        input.spellcheck = false;
        input.value = state.variables[name] || '';
        input.placeholder = state.renderer.sampleValue(name);
        input.addEventListener('input', () => {
          if (input.value === '') delete state.variables[name];
          else state.variables[name] = input.value;
          state.renderer.setVariables(state.variables);
          renderPreview();
        });
        row.appendChild(label);
        row.appendChild(input);
        list.appendChild(row);
        variableInputs.set(name, input);
      }
    }
    box.classList.toggle('hidden', sorted.length === 0);
    for (const [name, input] of variableInputs) {
      if (document.activeElement === input) continue;
      input.value = state.variables[name] || '';
    }
  }

  function updateSimBack() {
    $('btnSimBack').disabled = state.backStack.length === 0;
  }

  function pushBack() {
    state.backStack.push({
      componentPath: state.preview.componentPath,
      variantIndex: state.preview.variantIndex,
      pageIndex: state.preview.pageIndex,
      selectedIndex: state.preview.selectedIndex,
      frameIndex: state.preview.frameIndex
    });
    updateSimBack();
  }

  function popBack() {
    const s = state.backStack.pop();
    if (!s) { toast('No previous screen to return to', true); return; }
    state.preview.componentPath = s.componentPath;
    state.preview.variantIndex = s.variantIndex;
    state.preview.pageIndex = s.pageIndex;
    state.preview.selectedIndex = s.selectedIndex;
    state.preview.frameIndex = s.frameIndex;
    $('previewComponent').value = s.componentPath;
    populatePreviewComponentSelect();
    renderPreview();
    updateSimBack();
  }

  function jumpToComponent(path) {
    pushBack();
    state.preview.componentPath = path;
    state.preview.variantIndex = 0;
    state.preview.selectedIndex = 0;
    state.preview.pageIndex = 0;
    state.preview.frameIndex = 0;
    $('previewComponent').value = path;
    populatePreviewComponentSelect();
    renderPreview();
  }

  function gotoItem(id) {
    const screen = state.renderer.lastScreen;
    if (!screen) return;
    const find = (items) => items ? items.findIndex((it) => it && it.id === id) : -1;
    if (screen.pages) {
      for (let pi = 0; pi < screen.pages.length; pi++) {
        const idx = find(screen.pages[pi].menu_items);
        if (idx >= 0) {
          state.preview.pageIndex = pi;
          state.preview.selectedIndex = idx;
          renderPreview();
          return;
        }
      }
    }
    if (screen.menu_items) {
      const idx = find(screen.menu_items);
      if (idx >= 0) { state.preview.selectedIndex = idx; renderPreview(); return; }
    }
    if (screen.rows) {
      for (let r = 0; r < screen.rows.length; r++) {
        const idx = find(screen.rows[r]);
        if (idx >= 0) { state.preview.selectedIndex = idx; renderPreview(); return; }
      }
    }
    toast('Target "' + id + '" not found on this screen', true);
  }

  function toggleVariable(v) {
    const cur = state.variables[v];
    const on = typeof cur === 'string' && /^(true|on|1|yes|enabled|checked)$/i.test(cur);
    state.variables[v] = on ? 'false' : 'true';
    state.renderer.setVariables(state.variables);
    renderVariables();
    renderPreview();
  }

  function simulateClick(region) {
    const item = region.item;
    if (!item) return;

    const v = item.variable || (region.layer && (region.layer.variable_name || region.layer.variable));
    if (item.target === 'inline_toggle') {
      if (v) toggleVariable(v);
      else renderPreview();
      return;
    }

    const target = item.target;
    if (target) {
      if (target === 'back' || target === 'cancel' || target === 'close') { popBack(); return; }
      if (target === 'next_page') { state.preview.pageIndex++; renderPreview(); updateSimBack(); return; }
      if (target === 'previous_page') {
        state.preview.pageIndex = Math.max(0, state.preview.pageIndex - 1);
        renderPreview();
        updateSimBack();
        return;
      }
      if (target.startsWith('goto ')) { gotoItem(target.slice(5)); return; }
      const tj = state.model.getThemeJson() || {};
      const gm = tj.generic_menus || {};
      if (gm[target] && state.model.has(gm[target])) { jumpToComponent(gm[target]); return; }
      if (target.startsWith('components/') && state.model.has(target)) { jumpToComponent(target); return; }
    }

    // Fallback: just highlight the item's selected state.
    state.preview.selectedIndex = region.itemIndex;
    renderPreview();
  }

  // ---- layers panel + properties inspector --------------------------------
  const nodeIds = new Map();
  let nodeIdSeq = 0;
  function idOf(obj) {
    if (!obj) return 0;
    if (!nodeIds.has(obj)) nodeIds.set(obj, ++nodeIdSeq);
    return nodeIds.get(obj);
  }

  function currentItems(screen) {
    if (!screen) return [];
    if (screen.menu_items) return screen.menu_items;
    if (screen.pages) {
      const page = screen.pages[state.preview.pageIndex] || screen.pages[0];
      return page && page.menu_items ? page.menu_items : [];
    }
    if (screen.rows) { const flat = []; for (const r of screen.rows) for (const it of r || []) flat.push(it); return flat; }
    return [];
  }

  function layerGlyph(layer) {
    if (layer.image_path) return '🖼';
    if (layer.toggle_template) return '◉';
    if (layer.use_template || layer.string_template) return '⧉';
    if (layer.text != null || layer.variable_name || layer.variable) return 'T';
    return '·';
  }

  function layerLabel(layer, prefix) {
    let t;
    if (layer.image_path) t = layer.image_path;
    else if (layer.text != null) t = '“' + layer.text + '”';
    else if (layer.variable_name) t = layer.variable_name;
    else if (layer.use_template) t = layer.use_template;
    else if (layer.toggle_template) t = 'toggle';
    else if (layer.string_template) t = 'string';
    else t = 'layer';
    return (prefix ? prefix + ' · ' : '') + t;
  }

  function buildLayerNodes(screen) {
    const nodes = [];
    if (!screen) return nodes;
    const bg = screen.background || {};
    const bgLayers = Array.isArray(bg.layers) ? bg.layers : [];
    bgLayers.forEach((layer, index) => {
      nodes.push({ layer, item: null, parent: bgLayers, index, label: layerLabel(layer, 'bg') });
    });
    const items = currentItems(screen);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      nodes.push({ layer: null, item, parent: items, index: i, label: 'item · ' + (item.id || ('#' + i)) });
      const layers = Array.isArray(item.layers) ? item.layers : [];
      const selLayers = Array.isArray(item.selected_layers) ? item.selected_layers : [];
      layers.forEach((layer, index) => nodes.push({ layer, item, parent: layers, index, label: layerLabel(layer, '') }));
      selLayers.forEach((layer, index) => nodes.push({ layer, item, parent: selLayers, index, label: layerLabel(layer, 'sel') }));
    }
    return nodes;
  }

  let currentLayerNodes = [];
  let lastLayerSig = null;

  function renderLayers() {
    const box = $('layersBox');
    const list = $('layerList');
    if (!box || !list) return;
    const nodes = buildLayerNodes(state.renderer.lastScreen);
    const sig = nodes.map((n) => (n.layer ? 'L' + idOf(n.layer) : 'I' + idOf(n.item))).join(',');
    if (sig !== lastLayerSig) {
      lastLayerSig = sig;
      currentLayerNodes = nodes;
      list.innerHTML = '';
      for (const node of nodes) {
        const li = document.createElement('li');
        li.className = 'layer-row';

        const eye = document.createElement('button');
        eye.className = 'mini eye';
        eye.title = 'Show / hide in preview (still exported)';
        eye.textContent = state.hidden.has(node.layer || node.item) ? '▫' : '▮';
        eye.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = node.layer || node.item;
          if (state.hidden.has(key)) state.hidden.delete(key); else state.hidden.add(key);
          renderPreview();
        });

        const glyph = document.createElement('span');
        glyph.className = 'glyph';
        glyph.textContent = node.layer ? layerGlyph(node.layer) : '☰';

        const label = document.createElement('span');
        label.className = 'lname';
        label.textContent = node.label;

        li.appendChild(eye);
        li.appendChild(glyph);
        li.appendChild(label);

        const move = document.createElement('span');
        move.className = 'move';
        const up = document.createElement('button');
        up.className = 'mini';
        up.textContent = '↑';
        up.title = 'Move up';
        up.addEventListener('click', (e) => { e.stopPropagation(); moveLayerNode(node, -1); });
        const down = document.createElement('button');
        down.className = 'mini';
        down.textContent = '↓';
        down.title = 'Move down';
        down.addEventListener('click', (e) => { e.stopPropagation(); moveLayerNode(node, 1); });
        const del = document.createElement('button');
        del.className = 'mini';
        del.textContent = '✕';
        del.title = 'Delete';
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteLayerNode(node); });
        move.appendChild(up);
        move.appendChild(down);
        move.appendChild(del);
        li.appendChild(move);

        li.addEventListener('click', () => {
          state.selected = { layer: node.layer, item: node.item };
          renderLayers();
          renderProperties();
          renderPreview();
        });

        list.appendChild(li);
      }
    }
    box.classList.toggle('hidden', nodes.length === 0);
    // Refresh active + eye state without rebuilding (preserves scroll/focus).
    const lis = list.children;
    for (let i = 0; i < currentLayerNodes.length && i < lis.length; i++) {
      const node = currentLayerNodes[i];
      const li = lis[i];
      const isSel = state.selected && ((node.layer && state.selected.layer === node.layer) || (node.item && state.selected.item === node.item));
      li.classList.toggle('active', !!isSel);
      const eye = li.querySelector('.eye');
      if (eye) eye.textContent = state.hidden.has(node.layer || node.item) ? '▫' : '▮';
    }
  }

  function moveLayerNode(node, dir) {
    if (!node.parent) return;
    const arr = node.parent;
    const j = node.index + dir;
    if (j < 0 || j >= arr.length) return;
    history.push();
    const tmp = arr[node.index];
    arr[node.index] = arr[j];
    arr[j] = tmp;
    markDirty();
    renderPreview();
  }

  function deleteLayerNode(node) {
    history.push();
    if (node.layer && node.parent) {
      node.parent.splice(node.index, 1);
      if (state.selected && state.selected.layer === node.layer) state.selected = null;
    } else if (node.item && node.parent) {
      node.parent.splice(node.index, 1);
      if (state.selected && state.selected.item === node.item) state.selected = null;
    } else {
      history.undoStack.pop();
      return;
    }
    markDirty();
    renderPreview();
    toast('Deleted ' + (node.layer ? 'layer' : 'item'));
  }

  function addLayer() {
    const screen = state.renderer.lastScreen;
    if (!screen) { toast('Select a component to add a layer', true); return; }
    const assets = state.model.listAssets();
    const palette = Object.keys(state.model.getPalette());
    const newLayer = assets.length
      ? { image_path: assets[0], x: 0, y: 0 }
      : { text: 'New text', x: 0, y: 0, text_color_palette: palette[0] || 'soft_white' };
    history.push();
    const sel = state.selected;
    if (sel && sel.item) {
      if (!Array.isArray(sel.item.layers)) sel.item.layers = [];
      sel.item.layers.push(newLayer);
    } else {
      if (!screen.background) screen.background = {};
      if (!Array.isArray(screen.background.layers)) screen.background.layers = [];
      screen.background.layers.push(newLayer);
    }
    state.selected = { layer: newLayer, item: sel && sel.item ? sel.item : null };
    markDirty();
    renderPreview();
    toast('Added layer');
  }

  // ---- properties inspector -----------------------------------------------
  let lastPropsKey = null;
  let propBindings = [];

  function propRow(fields, labelText) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    row.appendChild(label);
    fields.appendChild(row);
    return row;
  }

  function bindProp(el, get) {
    propBindings.push({ el, get });
  }

  function propNumber(fields, labelText, obj, key) {
    const row = propRow(fields, labelText);
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.value = obj[key] || 0;
    input.addEventListener('focus', () => history.push());
    input.addEventListener('change', () => {
      obj[key] = Math.round(parseFloat(input.value) || 0);
      markDirty();
      renderPreview();
    });
    row.appendChild(input);
    bindProp(input, () => obj[key] || 0);
  }

  function propText(fields, labelText, obj, key) {
    const row = propRow(fields, labelText);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = obj[key] != null ? obj[key] : '';
    input.addEventListener('focus', () => history.push());
    input.addEventListener('change', () => {
      if (input.value === '') delete obj[key]; else obj[key] = input.value;
      markDirty();
      renderPreview();
    });
    row.appendChild(input);
    bindProp(input, () => obj[key] != null ? obj[key] : '');
  }

  function propSelect(fields, labelText, obj, key, options) {
    const row = propRow(fields, labelText);
    const sel = document.createElement('select');
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '—';
    sel.appendChild(empty);
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      sel.appendChild(opt);
    }
    sel.value = obj[key] || '';
    sel.addEventListener('focus', () => history.push());
    sel.addEventListener('change', () => {
      if (sel.value === '') delete obj[key]; else obj[key] = sel.value;
      markDirty();
      renderPreview();
    });
    row.appendChild(sel);
    bindProp(sel, () => obj[key] || '');
  }

  function buildLayerProps(fields, layer) {
    propNumber(fields, 'X', layer, 'x');
    propNumber(fields, 'Y', layer, 'y');
    if (layer.image_path || (!layer.text && !layer.variable_name && !layer.use_template && !layer.toggle_template)) {
      propSelect(fields, 'Image', layer, 'image_path', state.model.listAssets());
      propSelect(fields, 'Recolor', layer, 'recolor_palette', Object.keys(state.model.getPalette()).sort());
    }
    if (layer.text != null || layer.variable_name || layer.variable || layer.use_template === 'string' || layer.string_template) {
      propText(fields, 'Text', layer, 'text');
      propSelect(fields, 'Text color', layer, 'text_color_palette', Object.keys(state.model.getPalette()).sort());
      const sizeRow = propRow(fields, 'Size');
      const sizeSel = document.createElement('select');
      for (const s of ['small', 'medium', 'large']) {
        const o = document.createElement('option');
        o.value = s;
        o.textContent = s;
        sizeSel.appendChild(o);
      }
      sizeSel.value = layer.text_size || 'medium';
      sizeSel.addEventListener('focus', () => history.push());
      sizeSel.addEventListener('change', () => {
        layer.text_size = sizeSel.value;
        markDirty();
        renderPreview();
      });
      sizeRow.appendChild(sizeSel);
      bindProp(sizeSel, () => layer.text_size || 'medium');
    }
    if (layer.variable_name || layer.variable) {
      propText(fields, 'Variable', layer, 'variable_name');
    }
  }

  function buildItemProps(fields, item) {
    propNumber(fields, 'X', item, 'x');
    propNumber(fields, 'Y', item, 'y');
    const idRow = propRow(fields, 'ID');
    const idSpan = document.createElement('span');
    idSpan.className = 'muted mono';
    idSpan.textContent = item.id || '—';
    idRow.appendChild(idSpan);
    const targetRow = propRow(fields, 'Target');
    const targetSpan = document.createElement('span');
    targetSpan.className = 'muted mono';
    targetSpan.textContent = item.target || '—';
    targetRow.appendChild(targetSpan);
  }

  function renderProperties() {
    const box = $('propsBox');
    const fields = $('propsFields');
    if (!box || !fields) return;
    const sel = state.selected;
    const target = sel && (sel.layer || sel.item);
    const key = target ? (sel.layer ? 'L' + idOf(sel.layer) : 'I' + idOf(sel.item)) : 'none';
    box.classList.toggle('hidden', !target);
    if (key === lastPropsKey) {
      for (const b of propBindings) {
        if (document.activeElement === b.el) continue;
        b.el.value = b.get();
      }
      return;
    }
    lastPropsKey = key;
    propBindings = [];
    fields.innerHTML = '';
    if (!target) return;
    if (sel.layer) buildLayerProps(fields, sel.layer);
    else if (sel.item) buildItemProps(fields, sel.item);
  }

  function drawSelectionOutline() {
    const r = state.renderer;
    const sel = state.selected;
    if (!sel || !$('editMode').checked) return;
    const region = r.hitRegions.find((reg) =>
      (sel.layer && reg.layer === sel.layer) || (sel.item && reg.item === sel.item));
    if (!region) return;
    const c = r.ctx;
    c.save();
    c.strokeStyle = '#00ff9c';
    c.lineWidth = 1;
    c.setLineDash([3, 2]);
    c.strokeRect(region.x - 1, region.y - 1, (region.w || 1) + 2, (region.h || 1) + 2);
    c.setLineDash([]);
    c.restore();
  }

  function computeFitZoom() {
    const wrap = $('previewCanvasWrap');
    if (!wrap) return state.preview.zoom || 2;
    const availW = Math.max(120, wrap.clientWidth - 26);
    const availH = Math.max(60, wrap.clientHeight - 26);
    return Math.max(0.25, Math.min(availW / 480, availH / 222));
  }

  function applyZoom() {
    const z = state.preview.zoomMode === 'fit' ? computeFitZoom() : state.preview.zoom;
    const cv = $('previewCanvas');
    cv.style.width = Math.round(480 * z) + 'px';
    cv.style.height = Math.round(222 * z) + 'px';
  }

  function snapValue(v) {
    return $('snapGrid').checked ? Math.round(v / 5) * 5 : Math.round(v);
  }

  function canvasPoint(e) {
    const cv = $('previewCanvas');
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * 480;
    const y = (e.clientY - rect.top) / rect.height * 222;
    return { x, y };
  }

  function hitTest(x, y) {
    const regions = state.renderer.hitRegions;
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
    }
    return null;
  }

  function moveRegion(region, dx, dy, moveItem) {
    if (moveItem && region.item) {
      region.item.x = Math.round((region.item.x || 0) + dx);
      region.item.y = Math.round((region.item.y || 0) + dy);
    } else if (region.layer) {
      region.layer.x = Math.round((region.layer.x || 0) + dx);
      region.layer.y = Math.round((region.layer.y || 0) + dy);
    }
  }

  function bindPreviewInteraction() {
    const cv = $('previewCanvas');

    cv.addEventListener('mousedown', (e) => {
      const p = canvasPoint(e);
      const region = hitTest(p.x, p.y);
      if (!region) {
        state.selected = null;
        drawSelectionOutline();
        renderLayers();
        renderProperties();
        return;
      }
      if ($('editMode').checked) {
        history.push();
        state.selected = { layer: region.layer, item: region.item };
        state.drag = {
          region, startX: p.x, startY: p.y, moved: false,
          origLX: region.layer ? (region.layer.x || 0) : 0,
          origLY: region.layer ? (region.layer.y || 0) : 0,
          origIX: region.item ? (region.item.x || 0) : 0,
          origIY: region.item ? (region.item.y || 0) : 0
        };
        drawSelectionOutline();
        renderLayers();
        renderProperties();
      } else if ($('simulateMode').checked) {
        simulateClick(region);
      } else if (region.itemIndex >= 0) {
        state.preview.selectedIndex = region.itemIndex;
        renderPreview();
      }
    });

    cv.addEventListener('mousemove', (e) => {
      const p = canvasPoint(e);
      $('previewCoords').textContent = 'x: ' + Math.round(p.x) + ', y: ' + Math.round(p.y);
    });
    cv.addEventListener('mouseleave', () => {
      $('previewCoords').textContent = '';
    });

    window.addEventListener('mousemove', (e) => {
      if (!state.drag) return;
      const p = canvasPoint(e);
      const dx = p.x - state.drag.startX;
      const dy = p.y - state.drag.startY;
      const moveItem = e.shiftKey;
      const d = state.drag;
      if (moveItem && d.region.item) {
        d.region.item.x = snapValue(d.origIX + dx);
        d.region.item.y = snapValue(d.origIY + dy);
      } else if (d.region.layer) {
        d.region.layer.x = snapValue(d.origLX + dx);
        d.region.layer.y = snapValue(d.origLY + dy);
      }
      if (dx || dy) d.moved = true;
      requestPreviewRender();
    });

    window.addEventListener('mouseup', () => {
      if (state.drag) {
        const moved = state.drag.moved;
        state.drag = null;
        if (moved) markDirty();
        else if (history.undoStack.length && history.same(history.undoStack[history.undoStack.length - 1], history.snapshot())) {
          // Clicking an element without dragging should not create an undo step.
          history.undoStack.pop();
          updateHistoryButtons();
        }
      }
    });
  }

  function bindPreviewControls() {
    $('previewComponent').addEventListener('change', () => {
      state.preview.componentPath = $('previewComponent').value;
      state.preview.variantIndex = 0;
      state.preview.selectedIndex = 0;
      state.preview.pageIndex = 0;
      state.preview.frameIndex = 0;
      state.selected = null;
      renderPreview();
    });
    $('previewVariant').addEventListener('change', () => {
      state.preview.variantIndex = parseInt($('previewVariant').value, 10) || 0;
      state.preview.selectedIndex = 0;
      state.preview.pageIndex = 0;
      state.preview.frameIndex = 0;
      renderPreview();
    });
    $('previewPage').addEventListener('input', () => {
      state.preview.pageIndex = parseInt($('previewPage').value, 10) || 0;
      renderPreview();
    });
    $('previewFrame').addEventListener('input', () => {
      state.preview.frameIndex = parseInt($('previewFrame').value, 10) || 0;
      renderPreview();
    });
    $('previewSelectedItem').addEventListener('input', () => {
      state.preview.selectedIndex = parseInt($('previewSelectedItem').value, 10) || 0;
      renderPreview();
    });
    $('previewZoom').addEventListener('change', () => {
      const value = $('previewZoom').value;
      if (value === 'fit') {
        state.preview.zoomMode = 'fit';
      } else {
        state.preview.zoomMode = 'fixed';
        state.preview.zoom = parseFloat(value) || 2;
      }
      applyZoom();
    });
    $('editMode').addEventListener('change', () => {
      state.selected = null;
      renderPreview();
    });
    $('simulateMode').addEventListener('change', () => {
      renderPreview();
    });
    $('btnSimBack').addEventListener('click', popBack);
    $('btnAddLayer').addEventListener('click', addLayer);
  }

  function bindKeyboardNudge() {
    document.addEventListener('keydown', (e) => {
      if (!state.selected || !$('editMode').checked) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!map[e.key]) return;
      e.preventDefault();
      history.push();
      const [dx, dy] = map[e.key];
      moveRegion(state.selected, dx, dy, e.shiftKey);
      markDirty();
      requestPreviewRender();
    });
  }

  // ---- toolbar ------------------------------------------------------------
  function bindToolbar() {
    $('btnNew').addEventListener('click', startNewTheme);
    $('btnNewBlank').addEventListener('click', startBlankTheme);
    $('btnDuplicate').addEventListener('click', duplicateTheme);
    $('btnOpen').addEventListener('click', openFolder);
    $('btnOpenZip').addEventListener('click', openZip);
    $('btnUndo').addEventListener('click', () => history.undo());
    $('btnRedo').addEventListener('click', () => history.redo());
    $('btnSave').addEventListener('click', save);
    $('btnSaveAs').addEventListener('click', saveAs);
    $('btnExport').addEventListener('click', exportZip);
    $('btnSavePreview').addEventListener('click', savePreviewPng);
    $('btnValidate').addEventListener('click', () => setTab('validation'));
    $('btnRunValidation').addEventListener('click', runValidation);
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = (e.key || '').toLowerCase();
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

      if (key === 's') {
        e.preventDefault();
        if (e.shiftKey) saveAs(); else save();
        return;
      }
      if (key === 'e') { e.preventDefault(); exportZip(); return; }
      if (key === 'o') { e.preventDefault(); openFolder(); return; }
      if (typing) return; // let text fields keep their native undo history
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); }
      else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); history.redo(); }
    });
  }

  function bindNav() {
    document.querySelectorAll('.nav-item').forEach((b) => {
      b.addEventListener('click', () => setTab(b.dataset.tab));
    });
  }

  // ---- init ---------------------------------------------------------------
  async function init() {
    state.renderer = new PreviewRenderer($('previewCanvas'));
    state.renderer.setModel(state.model);
    applyZoom();

    bindNav();
    bindToolbar();
    bindShortcuts();
    bindMetadata();
    bindColors();
    bindThemeJson();
    bindComponents();
    bindAssets();
    bindPreviewControls();
    bindPreviewInteraction();
    bindKeyboardNudge();
    updateHistoryButtons();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (state.preview.zoomMode === 'fit') applyZoom();
      });
      ro.observe($('previewCanvasWrap'));
    }

    await startNewTheme();
  }

  // Exposed for the automated end-to-end test (test/interaction.js). Harmless
  // in normal use and handy for debugging from DevTools.
  window.__themeBuilder = {
    get state() { return state; },
    get history() { return history; },
    renderPreview,
    runValidation,
    serialize: () => state.model.serializeFiles(),
    importPaletteText,
    savePreviewPng,
    previewPngBase64,
    startBlankTheme,
    importComponentText,
    exportComponent,
    renameAsset,
    duplicateTheme
  };

  document.addEventListener('DOMContentLoaded', init);
})();
