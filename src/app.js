(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const hasElectron = !!(window.api);
  // Electron does not implement window.prompt(). The automated tests replace
  // it with a synchronous stub, so honor that when present and use a real
  // studio dialog otherwise.
  const nativePrompt = window.prompt;

  const state = {
    model: new ThemeModel(),
    renderer: null,
    simRenderer: null,
    imageLab: null,
    openedFolder: null,
    currentTab: 'design',
    selectedComponent: null,
    selectedAsset: null,
    preview: {
      componentPath: null,
      variantIndex: 0,
      selectedIndex: 0,
      pageIndex: 0,
      frameIndex: 0,
      zoom: 2,
      zoomMode: 'fit',
      statusStates: {},
      playing: false
    },
    selected: null,              // { layer, item } primary selection
    selection: [],               // multi-selection
    drag: null,
    pan: null,
    themeJsonDirty: false,
    manifestMode: 'form',
    componentMode: 'form',
    variables: {},
    backStack: [],
    hidden: new Set(),           // layer/item objects hidden from the preview
    locked: new Set(),
    dockTab: 'layers',
    recentComponents: [],
    validation: null,
    paletteFilter: '',
    paletteSort: 'luminance',
    extraction: null,
    harmony: null,
    library: { path: null, themes: [], recent: [] },
    clipboard: null,
    lastCanvasPoint: null,
    suppressRefresh: false
  };

  const UI_KEY = 'pinetheme.studio.ui.v1';
  const RECENT_KEY = 'pinetheme.studio.recent.v1';
  const REPO_KEY = 'pinetheme.studio.repo.v1';

  // ---- helpers ------------------------------------------------------------
  function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function opt(select, value, label, group) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    (group || select).appendChild(o);
    return o;
  }

  function isTyping(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
  }

  function nodeKey(node) {
    return node.layer ? 'L' + idOf(node.layer) : (node.item ? 'I' + idOf(node.item) : '?');
  }

  function selectionHas(layer, item) {
    return state.selection.some((n) => (layer && n.layer === layer) || (item && n.item === item));
  }

  function setSelection(nodes, additive) {
    const list = (nodes || []).filter(Boolean);
    if (!additive) {
      state.selection = list.slice();
    } else {
      for (const n of list) {
        const idx = state.selection.findIndex((x) => (n.layer && x.layer === n.layer) || (n.item && x.item === n.item));
        if (idx >= 0) state.selection.splice(idx, 1);
        else state.selection.push(n);
      }
    }
    const primary = state.selection[0] || null;
    state.selected = primary ? { layer: primary.layer || null, item: primary.item || null } : null;
    updateStatusSelection();
  }

  function clearSelection() {
    state.selection = [];
    state.selected = null;
    updateStatusSelection();
  }

  function updateStatusSelection() {
    const el = $('statusSelection');
    if (!el) return;
    const sel = state.selected;
    if (!sel || (!sel.layer && !sel.item)) {
      el.textContent = '—';
      return;
    }
    const obj = sel.layer || sel.item;
    if (sel.layer) {
      el.textContent = (sel.layer.image_path ? '🖼 ' : 'T ') +
        (sel.layer.text != null ? '“' + sel.layer.text + '”' : (sel.layer.variable_name || sel.layer.use_template || 'layer')) +
        ' · ' + (sel.layer.x || 0) + ',' + (sel.layer.y || 0) +
        (state.selection.length > 1 ? ' · +' + (state.selection.length - 1) : '');
    } else {
      el.textContent = 'item · ' + (sel.item.id || '?') +
        ' · ' + (sel.item.x || 0) + ',' + (sel.item.y || 0) +
        (state.selection.length > 1 ? ' · +' + (state.selection.length - 1) : '');
    }
  }

  function selectedNodes() {
    if (state.selection.length) return state.selection;
    if (state.selected) return [{ layer: state.selected.layer, item: state.selected.item }];
    return [];
  }

  // ---- undo / redo --------------------------------------------------------
  // Snapshots hold a shallow copy of the file map. File entries are immutable
  // (setFile always creates a new object), so this is cheap even for a large theme.
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
    if (state.simRenderer) state.simRenderer.setModel(state.model);
    clearSelection();

    syncMetaFromModel();
    refreshEnabled();
    renderColors();
    renderComponentList();
    renderComponentForm();
    renderAssets();
    renderManifestForm();
    renderValidation(state.validation);
    if (!state.themeJsonDirty) refreshThemeJsonEditor();
    renderOverview();
    if (state.imageLab) state.imageLab.refreshAssetList();

    if (state.selectedComponent && !state.model.has(state.selectedComponent)) {
      state.selectedComponent = null;
      $('componentPath').textContent = '—';
      $('componentEditor').value = '';
      $('componentStatus').textContent = 'Select a component to edit it.';
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
    updateReadmePreview();
  }

  // ---- toast --------------------------------------------------------------
  let toastTimer = null;
  function toast(msg, isError) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
  }

  // ---- dirty tracking -----------------------------------------------------
  function refreshEnabled() {
    const has = state.model.listAllFiles().length > 0;
    ['btnSave', 'btnSaveAs', 'btnExport', 'btnValidate', 'btnDuplicate'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !has;
    });
    const dirty = state.model.dirty || state.themeJsonDirty;
    const badge = $('dirtyBadge');
    if (badge) badge.classList.toggle('hidden', !dirty);
    const name = state.model.meta.name || state.model.themeDirName || 'No theme loaded';
    if ($('projectName')) $('projectName').textContent = name;
    if ($('frameworkBadge')) $('frameworkBadge').textContent = 'fw ' + (state.model.meta.frameworkVersion || '—');
    if ($('statusTheme')) $('statusTheme').textContent = has ? name : 'No theme';
    if ($('navThemeSize')) {
      const files = state.model.listAllFiles();
      let bytes = 0;
      for (const p of files) {
        const b = state.model.getBase64(p);
        if (b) bytes += Math.round(b.length * 3 / 4);
      }
      $('navThemeSize').textContent = files.length + ' files · ' + formatBytes(bytes);
    }
    if (window.api && window.api.setDirty) window.api.setDirty(dirty);
  }

  function markDirty() {
    state.model.dirty = true;
    refreshEnabled();
    schedulePreview();
    updateReadmePreview();
    scheduleOverview();
    scheduleValidation();
  }

  function scheduleValidation() {
    clearTimeout(scheduleValidation._t);
    scheduleValidation._t = setTimeout(() => runValidation(), 500);
  }

  function scheduleOverview() {
    clearTimeout(scheduleOverview._t);
    scheduleOverview._t = setTimeout(() => renderOverview(), 220);
  }

  // ---- preview scheduling -------------------------------------------------
  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => renderPreview(), 120);
  }

  let previewRaf = null;
  function requestPreviewRender() {
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(() => {
      previewRaf = null;
      renderPreview();
    });
  }

  // ---- layout -------------------------------------------------------------
  function loadUiPrefs() {
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (prefs.navW) {
        const nav = Math.max(52, Math.min(320, prefs.navW));
        document.documentElement.style.setProperty('--nav-w', nav + 'px');
      }
      if (prefs.dockW) {
        const max = Math.max(320, window.innerWidth - 520);
        const dock = Math.max(320, Math.min(max, prefs.dockW));
        document.documentElement.style.setProperty('--dock-w', dock + 'px');
      }
      if (prefs.dockCollapsed) document.body.classList.add('dock-collapsed');
    } catch (e) { /* ignore */ }
  }

  function saveUiPrefs() {
    try {
      const css = getComputedStyle(document.documentElement);
      localStorage.setItem(UI_KEY, JSON.stringify({
        navW: parseInt(css.getPropertyValue('--nav-w'), 10) || 196,
        dockW: parseInt(css.getPropertyValue('--dock-w'), 10) || 520,
        dockCollapsed: document.body.classList.contains('dock-collapsed')
      }));
    } catch (e) { /* ignore */ }
  }

  function initLayout() {
    loadUiPrefs();
    const resizer = $('dockResizer');
    const panel = $('preview-panel');
    if (resizer && panel) {
      resizer.addEventListener('pointerdown', (e) => {
        if (document.body.classList.contains('focus-preview')) return;
        e.preventDefault();
        resizer.classList.add('dragging');
        const startX = e.clientX;
        const startW = panel.getBoundingClientRect().width;
        const move = (ev) => {
          const w = Math.max(320, Math.min(window.innerWidth - 520, startW - (ev.clientX - startX)));
          document.documentElement.style.setProperty('--dock-w', w + 'px');
          if (state.preview.zoomMode === 'fit') applyZoom();
        };
        const up = () => {
          resizer.classList.remove('dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          saveUiPrefs();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      resizer.addEventListener('dblclick', () => {
        document.documentElement.style.setProperty('--dock-w', '520px');
        if (state.preview.zoomMode === 'fit') applyZoom();
        saveUiPrefs();
      });
    }
    const focusBtns = ['btnFocusPreview', 'btnPreviewFocus'];
    for (const id of focusBtns) {
      const b = $(id);
      if (b) b.addEventListener('click', toggleFocusPreview);
    }
    const toggleDock = $('btnToggleDock');
    if (toggleDock) {
      toggleDock.addEventListener('click', () => {
        document.body.classList.toggle('dock-collapsed');
        saveUiPrefs();
        setTimeout(() => { if (state.preview.zoomMode === 'fit') applyZoom(); }, 30);
      });
    }
  }

  function toggleFocusPreview() {
    const entering = !document.body.classList.contains('focus-preview');
    if (entering) document.body.classList.remove('dock-collapsed');
    document.body.classList.toggle('focus-preview');
    saveUiPrefs();
    setTimeout(() => { if (state.preview.zoomMode === 'fit') applyZoom(); }, 40);
  }

  // ---- tabs ---------------------------------------------------------------
  function setTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + tab));
    if (tab === 'validation') runValidation();
    if (tab === 'themejson') {
      if (!state.themeJsonDirty) refreshThemeJsonEditor();
      renderManifestForm();
    }
    if (tab === 'colors') { renderColors(); renderPaletteTools(); }
    if (tab === 'components') {
      renderComponentList();
      if (!state.selectedComponent) {
        const comps = state.model.listComponents();
        if (comps.length) selectComponent(comps[0]);
      }
      renderComponentForm();
    }
    if (tab === 'assets') renderAssets();
    if (tab === 'imagelab' && state.imageLab) {
      state.imageLab.refreshAssetList(state.selectedAsset || undefined);
      if (!state.imageLab.source && state.selectedAsset) state.imageLab.loadAsset(state.selectedAsset);
    }
    if (tab === 'design') renderOverview();
    if (tab === 'simulator') renderSimulator();
    if (tab === 'library') renderLibrary();
    updateStatusSelection();
    if (state.preview.zoomMode === 'fit') setTimeout(applyZoom, 30);
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
    refreshEnabled();
    setThemeJsonStatus('Edit the manifest, then click Apply.', false);
  }

  function syncMetaFromThemeJson() {
    const tj = state.model.getThemeJson();
    if (!tj) return;
    if (tj.theme_version != null) state.model.meta.version = String(tj.theme_version);
    if (tj.theme_framework_version != null) state.model.meta.frameworkVersion = String(tj.theme_framework_version);
    if (!state.model.meta.author && tj.author) state.model.meta.author = String(tj.author);
    if (!state.model.meta.name && (tj.theme_name || tj.name)) state.model.meta.name = String(tj.theme_name || tj.name);
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
    renderPaletteTools();
    renderComponentList();
    renderManifestForm();
    editor.value = JSON.stringify(obj, null, 2);
    setThemeJsonStatus('Applied ✓', false);

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
    refreshEnabled();
    setThemeJsonStatus('Formatted — click Apply to update the theme.', false);
  }

  function reloadThemeJson() {
    if (state.themeJsonDirty && !confirm('Discard unsaved theme.json edits?')) return;
    refreshThemeJsonEditor();
    renderManifestForm();
    toast('Reloaded theme.json from the current theme');
  }

  function bindThemeJson() {
    $('themeJsonEditor').addEventListener('input', () => {
      state.themeJsonDirty = true;
      refreshEnabled();
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
    $('btnManifestForm').addEventListener('click', () => {
      if (state.themeJsonDirty && !confirm('Discard unsaved raw JSON edits?')) return;
      state.themeJsonDirty = false;
      refreshEnabled();
      state.manifestMode = 'form';
      $('manifestForm').classList.remove('hidden');
      $('themeJsonEditor').classList.add('hidden');
      $('btnManifestForm').classList.add('active');
      $('btnManifestJson').classList.remove('active');
      renderManifestForm();
    });
    $('btnManifestJson').addEventListener('click', () => {
      state.manifestMode = 'json';
      $('manifestForm').classList.add('hidden');
      $('themeJsonEditor').classList.remove('hidden');
      $('btnManifestJson').classList.add('active');
      $('btnManifestForm').classList.remove('active');
      refreshThemeJsonEditor();
    });
  }

  // ---- project loading ----------------------------------------------------
  function confirmDiscard() {
    if (!state.model.dirty && !state.themeJsonDirty) return true;
    return confirm('Discard unsaved changes to "' +
      (state.model.meta.name || state.model.themeDirName) + '"?');
  }

  function applyLoaded() {
    state.renderer.setModel(state.model);
    if (state.simRenderer) state.simRenderer.setModel(state.model);
    clearSelection();
    state.hidden.clear();
    state.locked.clear();
    state.variables = {};
    state.backStack = [];
    state.clipboard = null;
    state.preview.statusStates = {};
    state.preview.playing = false;
    state.recentComponents = [];
    state.validation = null;
    state.extraction = null;
    state.harmony = null;
    if (state.imageLab) {
      state.imageLab.source = null;
      state.imageLab.sourcePath = null;
      state.imageLab.sourceDataUrl = null;
      state.imageLab.refreshAssetList();
    }
    syncMetaFromModel();
    refreshEnabled();
    renderColors();
    renderPaletteTools();
    renderComponentList();
    if (state.selectedComponent && state.model.has(state.selectedComponent)) {
      selectComponent(state.selectedComponent);
    } else {
      state.selectedComponent = null;
      if ($('componentPath')) $('componentPath').textContent = '—';
      if ($('componentEditor')) $('componentEditor').value = '';
      renderComponentForm();
    }
    renderAssets();
    renderManifestForm();
    refreshThemeJsonEditor();
    history.clear();
    const tj = state.model.getThemeJson() || {};
    const def = (tj.generic_menus && tj.generic_menus.dashboard_path) ||
      state.model.referencedComponentPaths()[0] ||
      state.model.listComponents()[0];
    state.preview.componentPath = def || null;
    state.preview.variantIndex = 0;
    state.preview.selectedIndex = 0;
    state.preview.pageIndex = 0;
    state.preview.frameIndex = 0;
    if (state.preview.zoomMode === 'fit') setTimeout(applyZoom, 20);
    populatePreviewComponentSelect();
    renderPreview();
    runValidation();
    renderOverview();
    updateReadmePreview();
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
    addRecent(res.tree.name, res.folderPath);
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
    addRecent(state.model.meta.name || state.model.themeDirName, target);
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
    // Export a clean frame: no selection handles, grid or hover overlays.
    const edit = $('editMode').checked;
    const grid = $('showGrid').checked;
    if (edit) $('editMode').checked = false;
    if (grid) $('showGrid').checked = false;
    if (edit || grid) await renderPreview();
    const base64 = previewPngBase64();
    if (edit) $('editMode').checked = true;
    if (grid) $('showGrid').checked = true;
    if (edit || grid) await renderPreview();
    const saved = await saveBase64File(base64, name, [
      { name: 'PNG image', extensions: ['png'] }
    ]);
    if (saved) toast('Saved preview to ' + saved);
  }

  async function exportZip() {
    state.model.ensureReadme();
    state.model.flushComponents();

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
    if ($('metaName')) $('metaName').value = m.name || '';
    if ($('metaAuthor')) $('metaAuthor').value = m.author || '';
    if ($('metaVersion')) $('metaVersion').value = m.version || '';
    if ($('metaFramework')) $('metaFramework').value = m.frameworkVersion || '';
    if ($('metaDescription')) $('metaDescription').value = m.description || '';
    if ($('metaDirName')) $('metaDirName').value = state.model.themeDirName || '';
    updateReadmePreview();
  }

  function updateReadmePreview() {
    const pre = $('readmePreview');
    if (!pre) return;
    try {
      pre.textContent = state.model.buildReadme();
    } catch (e) {
      pre.textContent = '';
    }
  }

  function bindMetadata() {
    const onField = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('focus', () => history.push());
      el.addEventListener('input', () => {
        state.model.meta[key] = el.value;
        if (key === 'name') state.model.themeDirName = state.model.slugify(el.value);
        if (key === 'version' || key === 'frameworkVersion') {
          const tj = Object.assign({}, state.model.getThemeJson() || {});
          if (key === 'version') tj.theme_version = el.value;
          else tj.theme_framework_version = el.value;
          state.model.setThemeJson(tj);
        }
        markDirty();
        if (key === 'name') {
          $('projectName').textContent = state.model.meta.name;
          $('metaDirName').value = state.model.themeDirName;
        }
        updateReadmePreview();
        refreshEnabled();
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
    $('btnCopyReadme').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.model.buildReadme());
        toast('README copied');
      } catch (e) { toast('Could not copy README', true); }
    });
  }

  // ---- palette ------------------------------------------------------------
  const colorCells = new Map();

  function renderColors() {
    const grid = $('colorGrid');
    if (!grid) return;
    grid.innerHTML = '';
    colorCells.clear();
    const palette = state.model.getPalette();
    let names = Object.keys(palette);
    if (state.paletteSort === 'luminance') {
      names.sort((a, b) => Palette.luminance(palette[b]) - Palette.luminance(palette[a]));
    } else if (state.paletteSort === 'hue') {
      names.sort((a, b) => {
        const ha = Palette.toHsl(palette[a]).h;
        const hb = Palette.toHsl(palette[b]).h;
        return ha - hb;
      });
    } else {
      names.sort();
    }
    const filter = (state.paletteFilter || '').toLowerCase();
    const shown = names.filter((n) => !filter || n.toLowerCase().includes(filter));
    if ($('paletteCount')) $('paletteCount').textContent = shown.length + ' / ' + names.length + ' colors';
    for (const name of shown) {
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
      colorCells.set(name, cell);

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
        if (state.imageLab) state.imageLab.render();
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
        if (state.imageLab) state.imageLab.render();
      });
      rm.addEventListener('click', () => {
        if (confirm('Remove color "' + name + '"?')) {
          history.push();
          state.model.removeColor(name);
          markDirty();
          renderColors();
          renderPaletteTools();
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
      renderPaletteTools();
      toast('Added color "' + name + '"');
    });
    $('btnImportPalette').addEventListener('click', importPalette);
    $('btnExportPalette').addEventListener('click', exportPalette);
    $('btnResetPalette').addEventListener('click', resetPalette);
    $('paletteFilter').addEventListener('input', () => {
      state.paletteFilter = $('paletteFilter').value;
      renderColors();
    });
    $('btnSortPalette').addEventListener('click', () => {
      state.paletteSort = state.paletteSort === 'luminance' ? 'hue' : (state.paletteSort === 'hue' ? 'name' : 'luminance');
      renderColors();
      toast('Sorted by ' + state.paletteSort);
    });
    $('contrastFg').addEventListener('change', updateContrast);
    $('contrastBg').addEventListener('change', updateContrast);
    $('harmonyBase').addEventListener('change', updateHarmony);
    $('harmonyScheme').addEventListener('change', updateHarmony);
    $('btnApplyHarmony').addEventListener('click', applyHarmony);
    $('btnExtractPalette').addEventListener('click', () => $('paletteExtractFile').click());
    $('paletteExtractFile').addEventListener('change', extractPaletteFromFile);
    $('btnApplyExtracted').addEventListener('click', applyExtractedPalette);
  }

  function renderPaletteTools() {
    const palette = state.model.getPalette();
    const names = Object.keys(palette).sort();
    for (const id of ['contrastFg', 'contrastBg', 'harmonyBase']) {
      const sel = $(id);
      if (!sel) continue;
      const cur = sel.value;
      sel.innerHTML = '';
      for (const n of names) opt(sel, n, n);
      if (names.includes(cur)) sel.value = cur;
      else if (id === 'contrastBg' && names.includes('black')) sel.value = 'black';
      else if (names.includes('soft_white')) sel.value = 'soft_white';
      else if (names.length) sel.value = names[0];
    }
    if (!$('contrastFg').value && names.length) $('contrastFg').value = names.find((n) => n === 'blue') || names[0];
    updateContrast();
    updateHarmony();
  }

  function updateContrast() {
    const palette = state.model.getPalette();
    const fg = palette[$('contrastFg').value] || { r: 255, g: 255, b: 255 };
    const bg = palette[$('contrastBg').value] || { r: 0, g: 0, b: 0 };
    const box = $('contrastPreview');
    if (box) {
      box.style.background = Palette.toCss(bg);
      box.style.color = Palette.toCss(fg);
    }
    const ratio = Palette.contrast(fg, bg);
    const aa = ratio >= 4.5 ? 'AA' : (ratio >= 3 ? 'AA large' : 'fails AA');
    const aaa = ratio >= 7 ? ' · AAA' : '';
    $('contrastResult').textContent = ratio.toFixed(2) + ':1 · ' + aa + aaa;
  }

  function updateHarmony() {
    const palette = state.model.getPalette();
    const base = palette[$('harmonyBase').value] || { r: 0, g: 255, b: 156 };
    const scheme = $('harmonyScheme').value;
    const colors = Palette.harmonies(base)[scheme] || [];
    state.harmony = { scheme, colors };
    const box = $('harmonyPreview');
    if (!box) return;
    box.innerHTML = '';
    colors.forEach((c, i) => {
      const d = mk('div', 'mini-swatch');
      d.style.background = Palette.toCss(c);
      d.title = Palette.toHex(c);
      box.appendChild(d);
    });
  }

  function applyHarmony() {
    if (!state.harmony || !state.harmony.colors.length) return;
    history.push();
    const palette = Object.assign({}, state.model.getPalette());
    state.harmony.colors.forEach((c, i) => {
      let name = 'harmony_' + i;
      while (palette[name]) name += '_';
      palette[name] = c;
    });
    state.model.setPalette(palette);
    markDirty();
    renderColors();
    renderPaletteTools();
    toast('Added ' + state.harmony.colors.length + ' harmony colors');
  }

  async function extractPaletteFromFile() {
    const f = $('paletteExtractFile').files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const colors = Palette.extract(ctx.getImageData(0, 0, c.width, c.height), 10);
      state.extraction = colors;
      const box = $('extractPreview');
      box.innerHTML = '';
      colors.forEach((col) => {
        const d = mk('div', 'mini-swatch');
        d.style.background = Palette.toCss(col);
        d.title = Palette.toHex(col);
        box.appendChild(d);
      });
      $('btnApplyExtracted').disabled = !colors.length;
      URL.revokeObjectURL(url);
      toast('Extracted ' + colors.length + ' colors from ' + f.name);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('Could not read that image', true);
    };
    img.src = url;
  }

  function applyExtractedPalette() {
    if (!state.extraction || !state.extraction.length) return;
    history.push();
    const palette = Object.assign({}, state.model.getPalette());
    state.extraction.forEach((c, i) => {
      let name = 'extracted_' + (i + 1);
      while (palette[name]) name += '_';
      palette[name] = c;
    });
    state.model.setPalette(palette);
    markDirty();
    renderColors();
    renderPaletteTools();
    toast('Added extracted colors');
  }

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
        renderPaletteTools();
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
    renderPaletteTools();
    if (state.imageLab) state.imageLab.render();
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
    for (const id of ['btnDuplicateComponent', 'btnRenameComponent', 'btnDeleteComponent', 'btnExportComponent']) {
      const el = $(id);
      if (el) el.disabled = !has;
    }
  }

  function newComponentTemplate(path) {
    const palette = Object.keys(state.model.getPalette());
    const color = palette.includes('blue') ? 'blue' : (palette[0] || 'soft_white');
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
          layers: [{ text: 'New Item', text_size: 'medium', text_color_palette: color }],
          selected_layers: [{ text: 'New Item', text_size: 'medium', text_color_palette: selectedColor }],
          target: 'back'
        }]
      }]
    };
  }

  async function createComponent() {
    const raw = await askText({ title: 'New component', label: 'Component path (under components/)', value: 'components/new_component.json' });
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
    runValidation();
    toast('Created ' + path);
  }

  async function duplicateComponent() {
    const src = state.selectedComponent;
    if (!src || !state.model.has(src)) return;
    const suggested = src.replace(/\.json$/i, '_copy.json');
    const raw = await askText({ title: 'Duplicate component', label: 'New component path', value: suggested });
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
    runValidation();
    toast('Duplicated to ' + path);
  }

  async function renameComponent() {
    const oldPath = state.selectedComponent;
    if (!oldPath || !state.model.has(oldPath)) return;
    const raw = await askText({ title: 'Rename component', label: 'New component path', value: oldPath });
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
    renderOverview();
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
    $('componentStatus').textContent = 'Select a component to edit it.';
    $('componentStatus').style.color = '';
    markDirty();
    renderComponentList();
    renderComponentForm();

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
    renderOverview();
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
    runValidation();
    renderOverview();
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
      const raw = await askText({ title: 'Import component', label: 'Component path', value: defaultPath });
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
    if (!list) return;
    list.innerHTML = '';
    if (state.selectedComponent && !state.model.has(state.selectedComponent)) state.selectedComponent = null;
    const referenced = new Set(state.model.referencedComponentPaths());
    const filter = ($('componentFilter').value || '').toLowerCase();
    const comps = state.model.listComponents().filter((p) => !filter || p.toLowerCase().includes(filter));
    for (const path of comps) {
      const li = document.createElement('li');
      li.dataset.path = path;
      const comp = state.model.getComponent(path);
      const meta = ThemeTemplates.typeMeta(comp);
      const name = mk('span', 'cname', path);
      const icon = mk('span', 'type', meta.icon || '·');
      li.appendChild(name);
      li.appendChild(icon);
      if (referenced.has(path)) {
        const b = mk('span', 'badge', '●');
        b.title = 'Referenced in theme.json';
        li.appendChild(b);
      }
      li.classList.toggle('active', path === state.selectedComponent);
      li.addEventListener('click', () => selectComponent(path));
      li.addEventListener('dblclick', () => {
        state.preview.componentPath = path;
        state.preview.variantIndex = 0;
        state.preview.selectedIndex = 0;
        state.preview.pageIndex = 0;
        state.preview.frameIndex = 0;
        $('previewComponent').value = path;
        renderPreview();
      });
      list.appendChild(li);
    }
    updateComponentButtons();
  }

  function selectComponent(path) {
    state.selectedComponent = path;
    state.model.flushComponents();
    const raw = state.model.getComponentRaw(path) || '';
    if ($('componentPath')) $('componentPath').textContent = path;
    if ($('componentEditor')) $('componentEditor').value = raw;
    if ($('componentStatus')) {
      $('componentStatus').textContent = '';
      $('componentStatus').style.color = '';
    }
    const comp = state.model.getComponent(path);
    const meta = ThemeTemplates.typeMeta(comp);
    const badge = $('componentTypeBadge');
    if (badge) {
      badge.textContent = meta.icon + ' ' + meta.label;
      badge.classList.remove('hidden');
    }
    if (!state.recentComponents.includes(path)) state.recentComponents.unshift(path);
    state.recentComponents = state.recentComponents.slice(0, 8);
    renderComponentList();
    renderComponentForm();
    updateComponentButtons();
    updateReadmePreview();
  }

  function renderComponentForm() {
    const box = $('componentForm');
    if (!box) return;
    box.innerHTML = '';
    const path = state.selectedComponent;
    if (!path || !state.model.has(path)) {
      box.innerHTML = '<div class="muted">Select a component to edit its structured fields.</div>';
      const badge = $('componentTypeBadge');
      if (badge) badge.classList.add('hidden');
      return;
    }
    const comp = state.model.getComponent(path);
    if (!comp || comp.__parseError) {
      box.innerHTML = '<div class="muted" style="color:var(--danger)">This component has invalid JSON. Use the JSON tab to fix it.</div>';
      return;
    }
    const root = comp.template && typeof comp.template === 'object' ? comp.template : comp;
    const setRoot = (key, value) => {
      history.push();
      if (value === undefined || value === '') delete root[key]; else root[key] = value;
      state.model.setComponentRaw(path, JSON.stringify(comp, null, 2));
      markDirty();
      renderPreview();
      runValidation();
      renderOverview();
    };
    const addRow = (parent, label, control) => {
      const row = mk('div', 'form-row');
      row.appendChild(mk('label', '', label));
      row.appendChild(control);
      parent.appendChild(row);
      return row;
    };
    const text = (parent, key, label, placeholder) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = root[key] != null ? root[key] : '';
      input.placeholder = placeholder || '';
      input.addEventListener('change', () => setRoot(key, input.value));
      addRow(parent, label, input);
    };
    const number = (parent, key, label) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.value = root[key] != null ? root[key] : '';
      input.addEventListener('change', () => setRoot(key, input.value === '' ? undefined : Math.round(parseFloat(input.value) || 0)));
      addRow(parent, label, input);
    };
    const check = (parent, key, label) => {
      const wrap = mk('label', 'check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!root[key];
      input.addEventListener('change', () => setRoot(key, input.checked));
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(' ' + label));
      addRow(parent, '', wrap);
    };
    const select = (parent, key, label, options) => {
      const sel = document.createElement('select');
      opt(sel, '', '—');
      for (const o of options) opt(sel, o.value, o.label);
      if (root[key] != null) sel.value = root[key];
      sel.addEventListener('change', () => setRoot(key, sel.value || undefined));
      addRow(parent, label, sel);
    };

    const section = (title) => {
      const s = mk('div', 'form-section');
      s.appendChild(mk('h4', '', title));
      box.appendChild(s);
      return s;
    };

    const meta = ThemeTemplates.typeMeta(comp);
    const head = mk('div', 'form-section');
    head.appendChild(mk('h4', '', meta.icon + ' ' + meta.label + ' · ' + path));
    head.appendChild(mk('div', 'muted', 'Structured fields update theme.json components directly. Use JSON for advanced structures.'));
    box.appendChild(head);

    if (comp.template && typeof comp.template === 'object') {
      const note = mk('div', 'muted', 'This component wraps its screen in a "template" object; fields below edit that inner screen.');
      box.appendChild(note);
    }

    const basic = section('Screen');
    text(basic, 'screen_name', 'Screen name');
    const statusOptions = [{ value: '', label: '— none —' }];
    const tj = state.model.getThemeJson() || {};
    for (const k of Object.keys(tj.status_bars || {})) statusOptions.push({ value: k, label: k });
    select(basic, 'status_bar', 'Status bar', statusOptions);
    check(basic, 'windowed_canvas', 'Windowed canvas');
    check(basic, 'cache_canvases', 'Cache canvases');

    const layout = section('Layout & runtime');
    number(layout, 'refresh_interval', 'Refresh interval');
    number(layout, 'visible_lines', 'Visible lines');
    number(layout, 'title_x', 'Title X');
    number(layout, 'title_y', 'Title Y');
    number(layout, 'start_x', 'Text start X');
    number(layout, 'start_y', 'Text start Y');
    number(layout, 'max_chars', 'Max chars');
    if (root.text_size != null) {
      const sel = document.createElement('select');
      for (const s of ['small', 'medium', 'large']) opt(sel, s, s);
      sel.value = root.text_size;
      sel.addEventListener('change', () => setRoot('text_size', sel.value));
      addRow(layout, 'Text size', sel);
    }
    const colorField = (key, label) => {
      const c = root[key];
      if (!c || typeof c !== 'object') return;
      const color = document.createElement('input');
      color.type = 'color';
      color.value = Palette.toHex(c);
      color.addEventListener('input', () => {
        root[key] = Object.assign({}, c, Palette.fromHex(color.value));
        state.model.setComponentRaw(path, JSON.stringify(comp, null, 2));
        markDirty();
        renderPreview();
      });
      addRow(layout, label, color);
    };
    colorField('default_text_color', 'Default text color');
    colorField('error_text_color', 'Error text color');
    if (root.background && root.background.background_color) {
      const color = document.createElement('input');
      color.type = 'color';
      color.value = Palette.toHex(root.background.background_color);
      color.addEventListener('input', () => {
        root.background.background_color = Palette.fromHex(color.value);
        state.model.setComponentRaw(path, JSON.stringify(comp, null, 2));
        markDirty();
        renderPreview();
      });
      addRow(layout, 'Background color', color);
    }

    if (root.graph_width != null) {
      const graph = section('Recon graph');
      for (const [key, label] of [
        ['graph_width', 'Graph width'], ['bar_w', 'Bar width'], ['bar_gap', 'Bar gap'],
        ['x_start', 'Start X'], ['y_top', 'Top Y'], ['y_bottom', 'Bottom Y'],
        ['y_label_x', 'Label X'], ['y_label_y', 'Label Y']
      ]) number(graph, key, label);
      const sel = document.createElement('select');
      for (const n of Object.keys(state.model.getPalette()).sort()) opt(sel, n, n);
      sel.value = root.bar_color_palette || '';
      sel.addEventListener('change', () => setRoot('bar_color_palette', sel.value));
      addRow(graph, 'Bar color', sel);
    }

    const buttons = section('Button map');
    const bm = document.createElement('textarea');
    bm.value = JSON.stringify(root.button_map || {}, null, 2);
    bm.spellcheck = false;
    bm.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(bm.value);
        setRoot('button_map', parsed && typeof parsed === 'object' ? parsed : undefined);
      } catch (e) {
        toast('Button map must be valid JSON', true);
      }
    });
    addRow(buttons, 'button_map', bm);

    const actions = section('Actions');
    const row = mk('div', 'lab-buttons');
    const previewBtn = mk('button', 'mini', 'Preview this component');
    previewBtn.addEventListener('click', () => {
      state.preview.componentPath = path;
      state.preview.variantIndex = 0;
      state.preview.selectedIndex = 0;
      state.preview.pageIndex = 0;
      state.preview.frameIndex = 0;
      $('previewComponent').value = path;
      renderPreview();
    });
    const jsonBtn = mk('button', 'mini', 'Open JSON');
    jsonBtn.addEventListener('click', () => setComponentMode('json'));
    const simBtn = mk('button', 'mini', 'Simulate');
    simBtn.addEventListener('click', () => {
      state.preview.componentPath = path;
      populatePreviewComponentSelect();
      renderPreview();
      setTab('simulator');
    });
    row.appendChild(previewBtn);
    row.appendChild(jsonBtn);
    row.appendChild(simBtn);
    actions.appendChild(row);
  }

  function setComponentMode(mode) {
    state.componentMode = mode;
    const form = $('componentForm');
    const editor = $('componentEditor');
    const formBtn = $('btnComponentForm');
    const jsonBtn = $('btnComponentJson');
    if (mode === 'form') {
      form.classList.remove('hidden');
      editor.classList.add('hidden');
      formBtn.classList.add('active');
      jsonBtn.classList.remove('active');
      renderComponentForm();
    } else {
      form.classList.add('hidden');
      editor.classList.remove('hidden');
      jsonBtn.classList.add('active');
      formBtn.classList.remove('active');
      if (state.selectedComponent) editor.value = state.model.getComponentRaw(state.selectedComponent) || '';
    }
  }

  function bindComponents() {
    $('componentFilter').addEventListener('input', renderComponentList);
    $('btnNewComponent').addEventListener('click', createComponent);
    $('btnDuplicateComponent').addEventListener('click', duplicateComponent);
    $('btnRenameComponent').addEventListener('click', renameComponent);
    $('btnDeleteComponent').addEventListener('click', deleteComponent);
    $('btnImportComponent').addEventListener('click', importComponent);
    $('btnExportComponent').addEventListener('click', exportComponent);
    $('btnComponentTemplates').addEventListener('click', openTemplateGallery);
    $('btnComponentForm').addEventListener('click', () => setComponentMode('form'));
    $('btnComponentJson').addEventListener('click', () => setComponentMode('json'));
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
        renderComponentForm();
        renderPreview();
        runValidation();
        renderOverview();
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

  function createFromTemplate(type) {
    const comps = state.model.listComponents();
    const meta = ThemeTemplates.TYPE_META[type] || ThemeTemplates.TYPE_META.blank;
    const base = type + '.json';
    let path = meta.folder + '/' + base;
    let n = 2;
    while (state.model.has(path)) path = meta.folder + '/' + type + '_' + (n++) + '.json';
    const json = ThemeTemplates.generate(type, {
      palette: state.model.getPalette(),
      assets: state.model.listAssets(),
      theme: state.model.getThemeJson() || {}
    });
    // Use a friendlier screen name based on the final path.
    if (json.screen_name) json.screen_name = componentBaseName(path).split('/').pop();
    history.push();
    state.model.setComponentRaw(path, JSON.stringify(json, null, 2));
    markDirty();
    renderComponentList();
    selectComponent(path);
    populatePreviewComponentSelect();
    runValidation();
    renderOverview();
    toast('Created ' + path);
    return path;
  }

  function openTemplateGallery() {
    const grid = mk('div', 'template-grid');
    for (const t of ThemeTemplates.templateGallery()) {
      const card = mk('div', 'template-card');
      const meta = ThemeTemplates.TYPE_META[t.type] || ThemeTemplates.TYPE_META.blank;
      card.appendChild(mk('div', 'ic', meta.icon || '·'));
      card.appendChild(mk('h4', '', t.name));
      card.appendChild(mk('p', '', t.desc));
      card.appendChild(mk('div', 'muted mono', meta.folder + '/'));
      card.addEventListener('click', () => {
        closeModal();
        createFromTemplate(t.type);
      });
      grid.appendChild(card);
    }
    openModal({
      title: 'Component templates',
      body: grid,
      actions: [modalButton('Close', closeModal, false)]
    });
  }

  // ---- manifest form ------------------------------------------------------
  function renderManifestForm() {
    const box = $('manifestForm');
    if (!box) return;
    box.innerHTML = '';
    const tj = state.model.getThemeJson();
    if (!tj) {
      box.innerHTML = '<div class="muted">No theme.json loaded.</div>';
      return;
    }
    const comps = state.model.listComponents();
    const assets = state.model.listAssets();
    const optionsFor = (valueType) => {
      const list = [];
      list.push({ value: '', label: '— none —' });
      const compGroup = document.createElement('div');
      for (const p of comps) list.push({ value: p, label: p, group: 'components' });
      for (const p of assets) {
        if (/_path$|_image$|_background$/.test(p) || /image|background|qr|warn|icon/i.test(p)) {
          list.push({ value: p, label: p, group: 'assets' });
        }
      }
      return list;
    };
    const buildRow = (label, value, onChange, valueType) => {
      const row = mk('div', 'manifest-row');
      row.appendChild(mk('label', '', label));
      const sel = document.createElement('select');
      opt(sel, '', '— none —');
      const compOpts = [];
      const assetOpts = [];
      for (const p of comps) compOpts.push(p);
      for (const p of assets) assetOpts.push(p);
      if (value && !compOpts.includes(value) && !assetOpts.includes(value)) opt(sel, value, value + ' (missing)');
      if (compOpts.length) {
        const g = document.createElement('optgroup');
        g.label = 'Components';
        for (const p of compOpts) opt(g, p, p);
        sel.appendChild(g);
      }
      if (assetOpts.length) {
        const g = document.createElement('optgroup');
        g.label = 'Assets';
        for (const p of assetOpts) opt(g, p, p);
        sel.appendChild(g);
      }
      sel.value = value || '';
      sel.addEventListener('change', () => onChange(sel.value));
      row.appendChild(sel);
      const open = mk('button', 'mini', 'Open');
      open.addEventListener('click', () => {
        const v = sel.value;
        if (!v) return;
        if (v.startsWith('components/')) {
          setTab('components');
          selectComponent(v);
        } else if (v.startsWith('assets/')) {
          setTab('assets');
          $('assetFilter').value = v;
          renderAssets();
          if (state.model.has(v)) selectAsset(v);
        }
      });
      row.appendChild(open);
      return row;
    };
    const setTop = (key, value) => {
      history.push();
      if (value === '') delete tj[key]; else tj[key] = value;
      state.model.setThemeJson(tj);
      markDirty();
      renderColors();
      renderPaletteTools();
      renderComponentList();
      renderPreview();
      runValidation();
      renderOverview();
      if (!state.themeJsonDirty) refreshThemeJsonEditor();
    };
    const setMap = (mapKey, key, value) => {
      history.push();
      if (!tj[mapKey] || typeof tj[mapKey] !== 'object') tj[mapKey] = {};
      if (value === '') delete tj[mapKey][key]; else tj[mapKey][key] = value;
      state.model.setThemeJson(tj);
      markDirty();
      renderComponentList();
      renderPreview();
      runValidation();
      renderOverview();
      if (!state.themeJsonDirty) refreshThemeJsonEditor();
    };

    const sections = ThemeTemplates.manifestSections(tj);
    for (const section of sections) {
      const det = document.createElement('details');
      det.className = 'manifest-section';
      if (section.id === 'identity' || section.id === 'status_bars' || section.id === 'generic_menus') det.open = true;
      const summary = document.createElement('summary');
      summary.textContent = (section.icon || '·') + '  ' + section.title;
      det.appendChild(summary);
      const body = mk('div', 'manifest-body');
      det.appendChild(body);

      if (section.kind === 'fields') {
        for (const item of section.items) {
          const row = mk('div', 'manifest-row');
          row.appendChild(mk('label', '', item.label || ThemeTemplates.prettyKey(item.key)));
          const input = document.createElement('input');
          input.type = 'text';
          input.value = tj[item.key] != null ? tj[item.key] : '';
          input.addEventListener('change', () => setTop(item.key, input.value));
          row.appendChild(input);
          row.appendChild(mk('span', '', ''));
          body.appendChild(row);
        }
      } else if (section.kind === 'map') {
        body.appendChild(mk('p', 'manifest-note', section.note || ''));
        const map = tj[section.key] || {};
        for (const [k, v] of Object.entries(map)) {
          body.appendChild(buildRow(k, v, (val) => setMap(section.key, k, val), section.valueType));
        }
        const add = mk('div', 'manifest-add');
        const keyInput = document.createElement('input');
        keyInput.placeholder = 'new_key';
        const sel = document.createElement('select');
        opt(sel, '', '— choose target —');
        for (const p of state.model.listComponents()) opt(sel, p, p);
        const btn = mk('button', 'mini', 'Add binding');
        btn.addEventListener('click', () => {
          const k = keyInput.value.trim();
          if (!k) return;
          setMap(section.key, k, sel.value || '');
          renderManifestForm();
        });
        add.appendChild(keyInput);
        add.appendChild(sel);
        add.appendChild(btn);
        body.appendChild(add);
      } else if (section.kind === 'maps') {
        for (const mapDef of section.maps) {
          body.appendChild(mk('div', 'prop-section', mapDef.label));
          const map = tj[mapDef.key] || {};
          for (const [k, v] of Object.entries(map)) {
            body.appendChild(buildRow(k, v, (val) => setMap(mapDef.key, k, val), mapDef.valueType));
          }
          const add = mk('div', 'manifest-add');
          const keyInput = document.createElement('input');
          keyInput.placeholder = 'new_key';
          const sel = document.createElement('select');
          opt(sel, '', '— choose target —');
          for (const p of state.model.listComponents()) opt(sel, p, p);
          const btn = mk('button', 'mini', 'Add');
          btn.addEventListener('click', () => {
            const k = keyInput.value.trim();
            if (!k) return;
            setMap(mapDef.key, k, sel.value || '');
            renderManifestForm();
          });
          add.appendChild(keyInput);
          add.appendChild(sel);
          add.appendChild(btn);
          body.appendChild(add);
        }
      } else if (section.kind === 'paths') {
        for (const key of section.keys) {
          body.appendChild(buildRow(ThemeTemplates.prettyKey(key), tj[key] || '', (val) => setTop(key, val)));
        }
      }
      box.appendChild(det);
    }

    const extra = document.createElement('details');
    extra.className = 'manifest-section';
    const summary = document.createElement('summary');
    summary.textContent = '⋯  Other top-level keys';
    extra.appendChild(summary);
    const body = mk('div', 'manifest-body');
    const known = new Set();
    for (const s of sections) {
      if (s.items) for (const i of s.items) known.add(i.key);
      if (s.key) known.add(s.key);
      if (s.maps) for (const m of s.maps) known.add(m.key);
      if (s.keys) for (const k of s.keys) known.add(k);
    }
    known.add('color_palette');
    known.add('_unused');
    const others = Object.keys(tj).filter((k) => !known.has(k));
    if (!others.length) body.appendChild(mk('p', 'manifest-note', 'No additional keys.'));
    for (const k of others) {
      const row = mk('div', 'manifest-row');
      row.appendChild(mk('label', '', k));
      const input = document.createElement('input');
      input.type = 'text';
      input.value = typeof tj[k] === 'object' ? JSON.stringify(tj[k]) : String(tj[k]);
      input.addEventListener('change', () => {
        let value = input.value;
        if (/^\s*[\[{]/.test(value)) {
          try { value = JSON.parse(value); } catch (e) { toast('Invalid JSON for ' + k, true); return; }
        }
        setTop(k, value);
      });
      row.appendChild(input);
      row.appendChild(mk('span', '', ''));
      body.appendChild(row);
    }
    extra.appendChild(body);
    box.appendChild(extra);
  }

  // ---- assets -------------------------------------------------------------
  const assetCells = new Map();
  let assetUsage = new Map();
  let assetDims = new Map();

  function assetMime(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp'
    }[ext] || 'image/png';
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
    for (const id of ['btnReplaceAsset', 'btnRenameAsset', 'btnDeleteAsset', 'btnAssetImageLab', 'btnAssetUsage']) {
      const b = $(id);
      if (b) b.disabled = !path;
    }
    const info = $('assetInfo');
    const detail = $('assetDetailBody');
    if (!path) {
      if (info) info.textContent = 'Select an asset to see its size, dimensions and usage.';
      if (detail) detail.innerHTML = '<div class="muted">Select an asset.</div>';
      return;
    }
    const b64 = state.model.getBase64(path) || '';
    const size = formatBytes(Math.round(b64.length * 3 / 4));
    const refs = countAssetReferences(path);
    const usage = refs ? 'used ' + refs + '×' : 'unused';
    if (info) info.textContent = path + ' — ' + size + ' — ' + usage;
    if (detail) {
      detail.innerHTML = '';
      if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(path)) {
        const prev = mk('div', 'preview');
        const img = document.createElement('img');
        img.src = 'data:' + assetMime(path) + ';base64,' + b64;
        prev.appendChild(img);
        detail.appendChild(prev);
      }
      const dl = document.createElement('dl');
      const add = (k, v) => { dl.appendChild(mk('dt', '', k)); dl.appendChild(mk('dd', '', v)); };
      add('Path', path);
      add('Size', size);
      add('Usage', usage);
      const dims = assetDims.get(path);
      if (dims) add('Dimensions', dims.w + '×' + dims.h);
      detail.appendChild(dl);
      if (!dims && /\.(png|jpe?g|gif|bmp|webp)$/i.test(path)) {
        const img = new Image();
        img.onload = () => {
          assetDims.set(path, { w: img.naturalWidth, h: img.naturalHeight });
          if (state.selectedAsset === path) selectAsset(path);
        };
        img.src = 'data:' + assetMime(path) + ';base64,' + b64;
      }
      if (refs) {
        const usageTitle = mk('div', 'prop-section', 'Referenced by');
        detail.appendChild(usageTitle);
        const list = mk('div', 'usage-list');
        for (const ref of findAssetRefs(path)) list.appendChild(mk('div', '', ref));
        detail.appendChild(list);
      }
    }
  }

  function findAssetRefs(path) {
    const out = [];
    const tj = state.model.getThemeJson();
    if (tj && JSON.stringify(tj).includes(path)) out.push('theme.json');
    for (const p of state.model.listComponents()) {
      const raw = state.model.getComponentRaw(p) || '';
      if (raw.includes(path)) out.push(p);
    }
    return out;
  }

  function renderAssets() {
    const grid = $('assetGrid');
    if (!grid) return;
    grid.innerHTML = '';
    assetCells.clear();
    const usage = refreshAssetUsage();
    const all = state.model.listAssets();
    const filter = ($('assetFilter').value || '').toLowerCase();
    let assets = all.filter((p) => !filter || p.toLowerCase().includes(filter));
    const sort = $('assetSort') ? $('assetSort').value : 'path';
    if (sort === 'path') assets.sort();
    else if (sort === 'usage') assets.sort((a, b) => (usage.get(b) || 0) - (usage.get(a) || 0) || a.localeCompare(b));
    else if (sort === 'size') {
      assets.sort((a, b) => {
        const ba = (state.model.getBase64(a) || '').length;
        const bb = (state.model.getBase64(b) || '').length;
        return bb - ba;
      });
    } else if (sort === 'dims') {
      assets.sort((a, b) => {
        const da = assetDims.get(a) || { w: 0, h: 0 };
        const db = assetDims.get(b) || { w: 0, h: 0 };
        return db.w * db.h - da.w * da.h || a.localeCompare(b);
      });
    }
    const unusedCount = all.filter((p) => !usage.has(p) || usage.get(p) === 0).length;
    if ($('assetCount')) {
      $('assetCount').textContent = assets.length + (filter ? ' of ' + all.length : '') +
        ' files' + (unusedCount ? ' · ' + unusedCount + ' unused' : '');
    }
    for (const path of assets) {
      const b64 = state.model.getBase64(path);
      const used = usage.has(path) && usage.get(path) > 0;
      const cell = document.createElement('div');
      cell.className = 'asset-cell';
      cell.dataset.path = path;
      cell.classList.toggle('selected', path === state.selectedAsset);
      cell.classList.toggle('unused', !used);

      const thumb = mk('div', 'asset-thumb');
      if (b64) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = 'data:' + assetMime(path) + ';base64,' + b64;
        img.onload = () => { assetDims.set(path, { w: img.naturalWidth, h: img.naturalHeight }); };
        thumb.appendChild(img);
      } else {
        thumb.textContent = '?';
      }

      const name = mk('div', 'asset-name', path);
      cell.appendChild(thumb);
      cell.appendChild(name);
      if (!used) cell.appendChild(mk('span', 'unused-badge', 'unused'));
      cell.addEventListener('click', () => selectAsset(path));
      cell.addEventListener('dblclick', () => openAssetInImageLab(path));
      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selectAsset(path);
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Open in Image Lab', action: () => openAssetInImageLab(path) },
          { label: 'Find usages', action: () => showAssetUsage(path) },
          { label: 'Rename…', action: () => renameAsset() },
          { label: 'Delete', action: () => deleteSelectedAsset() },
          { sep: true },
          { label: 'Copy path', action: () => navigator.clipboard.writeText(path).then(() => toast('Copied path')).catch(() => toast('Could not copy path', true)) }
        ]);
      });
      assetCells.set(path, cell);
      grid.appendChild(cell);
    }
    if (state.selectedAsset && !state.model.has(state.selectedAsset)) state.selectedAsset = null;
    selectAsset(state.selectedAsset);
  }

  function invalidateAsset(path) {
    if (state.renderer) state.renderer.invalidate(path);
    if (state.simRenderer) state.simRenderer.invalidate(path);
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
          invalidateAsset(assetPath);
          state.model.setFile(assetPath, Zip.bytesToBase64(new Uint8Array(buf)), true);
        }
        markDirty();
        renderAssets();
        renderOverview();
        if (state.imageLab) state.imageLab.refreshAssetList();
      };
      input.click();
      return;
    }
    const picked = await window.api.pickAssetFiles();
    if (!picked.length) return;
    history.push();
    for (const p of picked) {
      const assetPath = 'assets/' + p.name;
      invalidateAsset(assetPath);
      state.model.setFile(assetPath, p.base64, true);
    }
    markDirty();
    renderAssets();
    renderOverview();
    if (state.imageLab) state.imageLab.refreshAssetList();
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
        invalidateAsset(state.selectedAsset);
        assetDims.delete(state.selectedAsset);
        state.model.setFile(state.selectedAsset, Zip.bytesToBase64(new Uint8Array(buf)), true);
        markDirty();
        renderAssets();
        renderPreview();
        if (state.imageLab) state.imageLab.refreshAssetList(state.selectedAsset);
      };
      input.click();
      return;
    }
    const picked = await window.api.pickAssetFiles();
    if (!picked.length) return;
    history.push();
    invalidateAsset(state.selectedAsset);
    assetDims.delete(state.selectedAsset);
    state.model.setFile(state.selectedAsset, picked[0].base64, true);
    markDirty();
    renderAssets();
    renderPreview();
    if (state.imageLab) state.imageLab.refreshAssetList(state.selectedAsset);
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
      invalidateAsset(assetPath);
      state.model.setFile(assetPath, Zip.bytesToBase64(new Uint8Array(buf)), true);
    }
    markDirty();
    renderAssets();
    renderOverview();
    if (state.imageLab) state.imageLab.refreshAssetList();
    toast('Imported ' + files.length + ' dropped asset' + (files.length === 1 ? '' : 's'));
  }

  async function renameAsset() {
    const oldPath = state.selectedAsset;
    if (!oldPath || !state.model.has(oldPath)) return;
    const raw = await askText({ title: 'Rename asset', label: 'New asset path', value: oldPath });
    if (raw == null) return;
    const newPath = normalizeAssetPath(raw);
    if (!newPath) { toast('Invalid asset path', true); return; }
    if (newPath === oldPath) return;
    if (state.model.has(newPath)) { toast(newPath + ' already exists', true); return; }

    history.push();
    const entry = state.model.files.get(oldPath);
    let content;
    if (entry.binary) content = entry.base64;
    else content = state.model.getText(oldPath) || '';
    state.model.deleteFile(oldPath);
    state.model.setFile(newPath, content, !!entry.binary);
    assetDims.delete(oldPath);
    assetDims.delete(newPath);
    invalidateAsset(oldPath);
    invalidateAsset(newPath);
    const refs = replacePathReferences(oldPath, newPath);

    state.selectedAsset = newPath;
    markDirty();
    renderAssets();
    selectAsset(newPath);
    renderPreview();
    runValidation();
    renderOverview();
    if (state.imageLab) state.imageLab.refreshAssetList(newPath);
    toast('Renamed to ' + newPath + (refs ? ' (' + refs + ' reference' + (refs === 1 ? '' : 's') + ' updated)' : ''));
  }

  function deleteSelectedAsset() {
    if (!state.selectedAsset) return;
    if (confirm('Delete ' + state.selectedAsset + '?')) {
      history.push();
      invalidateAsset(state.selectedAsset);
      state.model.deleteFile(state.selectedAsset);
      state.selectedAsset = null;
      markDirty();
      renderAssets();
      renderPreview();
      renderOverview();
      if (state.imageLab) state.imageLab.refreshAssetList();
    }
  }

  function deleteUnusedAssets() {
    const usage = refreshAssetUsage();
    const unused = state.model.listAssets().filter((p) => !usage.has(p) || usage.get(p) === 0);
    if (!unused.length) { toast('No unused assets'); return; }
    if (!confirm('Delete ' + unused.length + ' unused asset' + (unused.length === 1 ? '' : 's') + '?')) return;
    history.push();
    for (const p of unused) {
      invalidateAsset(p);
      state.model.deleteFile(p);
    }
    state.selectedAsset = null;
    for (const id of ['btnReplaceAsset', 'btnRenameAsset', 'btnDeleteAsset', 'btnAssetImageLab', 'btnAssetUsage']) {
      const b = $(id); if (b) b.disabled = true;
    }
    markDirty();
    renderAssets();
    renderPreview();
    renderOverview();
    if (state.imageLab) state.imageLab.refreshAssetList();
    toast('Deleted ' + unused.length + ' unused asset' + (unused.length === 1 ? '' : 's'));
  }

  function showAssetUsage(path) {
    const list = findAssetRefs(path);
    const body = mk('div', '');
    body.appendChild(mk('div', 'muted', list.length ? 'Referenced by ' + list.length + ' file(s):' : 'Not referenced by any file.'));
    const ul = mk('div', 'mini-list');
    for (const p of list) {
      const item = mk('div', 'item', p);
      item.addEventListener('click', () => {
        closeModal();
        if (p.startsWith('components/') && state.model.has(p)) {
          setTab('components');
          selectComponent(p);
        } else {
          setTab('themejson');
        }
      });
      ul.appendChild(item);
    }
    body.appendChild(ul);
    openModal({ title: 'Asset usages · ' + path, body, actions: [modalButton('Close', closeModal, false)] });
  }

  function openAssetInImageLab(path) {
    if (!state.imageLab) return;
    state.selectedAsset = path;
    state.imageLab.refreshAssetList(path);
    state.imageLab.loadAsset(path);
    setTab('imagelab');
  }

  function bindAssets() {
    $('btnImportAssets').addEventListener('click', importAssets);
    $('btnReplaceAsset').addEventListener('click', replaceAsset);
    $('btnRenameAsset').addEventListener('click', renameAsset);
    $('btnDeleteUnusedAssets').addEventListener('click', deleteUnusedAssets);
    $('assetFilter').addEventListener('input', renderAssets);
    if ($('assetSort')) $('assetSort').addEventListener('change', renderAssets);
    $('btnDeleteAsset').addEventListener('click', deleteSelectedAsset);
    $('btnAssetImageLab').addEventListener('click', () => state.selectedAsset && openAssetInImageLab(state.selectedAsset));
    $('btnAssetUsage').addEventListener('click', () => state.selectedAsset && showAssetUsage(state.selectedAsset));

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
    if (!box) return;
    box.innerHTML = '';
    if (!results || !results.errors || !results.warnings) {
      if ($('validationSummary')) $('validationSummary').textContent = '';
      if (badge) {
        badge.classList.add('hidden');
        badge.textContent = '';
      }
      return;
    }
    const errors = results.errors || [];
    const warnings = results.warnings || [];
    const info = results.info || [];
    const total = errors.length + warnings.length;
    if (badge) {
      badge.classList.toggle('hidden', total === 0);
      badge.classList.toggle('error', errors.length > 0);
      badge.textContent = total ? String(total) : '';
      badge.title = total
        ? errors.length + ' error(s), ' + warnings.length + ' warning(s)'
        : 'No validation problems';
    }
    if ($('validationSummary')) {
      $('validationSummary').textContent = errors.length + ' error(s), ' + warnings.length +
        ' warning(s)' + (info.length ? ', ' + info.length + ' info' : '');
    }
    const filter = $('validationFilter') ? $('validationFilter').value : 'all';
    const entries = [];
    for (const e of errors) entries.push(['error', e]);
    for (const w of warnings) entries.push(['warn', w]);
    for (const i of info) entries.push(['info', i]);
    if (!errors.length && !warnings.length) {
      const ok = mk('div', 'v-entry ok');
      ok.appendChild(mk('span', 'tag', 'OK'));
      ok.appendChild(mk('span', 'vtext', 'Theme looks good — no errors or warnings.'));
      box.appendChild(ok);
    }
    for (const [kind, text] of entries) {
      if (filter !== 'all' && filter !== kind) continue;
      box.appendChild(vEntry(kind, text));
    }
    if (!box.children.length) box.appendChild(mk('div', 'muted', 'No results match this filter.'));
  }

  function validationJump(text) {
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
    if (/theme\.json|manifest|theme_version|framework/i.test(text)) return () => setTab('themejson');
    return null;
  }

  function vEntry(kind, text) {
    const d = mk('div', 'v-entry ' + kind);
    const tag = mk('span', 'tag', kind === 'error' ? '✖' : (kind === 'warn' ? '⚠' : (kind === 'info' ? 'ℹ' : '✓')));
    d.appendChild(tag);
    d.appendChild(mk('span', 'vtext', text));
    const jump = validationJump(text);
    if (jump) {
      const btn = mk('button', 'v-open', 'Open');
      btn.title = 'Open the relevant editor';
      btn.addEventListener('click', jump);
      d.appendChild(btn);
    }
    return d;
  }

  function runValidation() {
    state.model.flushComponents();
    const results = Validators.validate(state.model);
    state.validation = results;
    renderValidation(results);
    renderOverview();
    const status = $('statusValidation');
    if (status) {
      const errors = results.errors.length;
      const warnings = results.warnings.length;
      status.textContent = errors || warnings
        ? errors + ' error(s) · ' + warnings + ' warning(s)'
        : 'valid';
      status.classList.toggle('has-errors', errors > 0);
      status.classList.toggle('has-warnings', !errors && warnings > 0);
    }
    return results;
  }

  // ---- preview ------------------------------------------------------------
  function populatePreviewComponentSelect() {
    const comps = state.model.listComponents();
    const current = state.preview.componentPath;
    for (const id of ['previewComponent', 'simComponent']) {
      const sel = $(id);
      if (!sel) continue;
      sel.innerHTML = '';
      for (const p of comps) opt(sel, p, p);
      if (current && comps.includes(current)) sel.value = current;
      else if (comps.length) {
        sel.value = comps[0];
        if (id === 'previewComponent') state.preview.componentPath = comps[0];
      }
    }
  }

  function currentItems(screen) {
    if (!screen) return [];
    if (screen.menu_items) return screen.menu_items;
    if (screen.pages) {
      const page = screen.pages[state.preview.pageIndex] || screen.pages[0];
      return page && page.menu_items ? page.menu_items : [];
    }
    if (screen.rows) {
      const flat = [];
      for (const r of screen.rows) for (const it of r || []) flat.push(it);
      return flat;
    }
    return [];
  }

  function currentScreenItemCount() {
    const s = state.renderer && state.renderer.lastScreen;
    return currentItems(s).length;
  }

  let previewChain = Promise.resolve();

  function renderPreview() {
    const run = () => renderPreviewNow().catch((e) => {
      console.error('Preview render failed:', e);
    });
    previewChain = previewChain.then(run, run);
    return previewChain;
  }

  async function renderPreviewNow() {
    if (!state.preview.componentPath) {
      const cv = $('previewCanvas');
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
      state.renderer.lastScreen = null;
      state.renderer.hitRegions = [];
      lastLayerSig = null;
      renderLayers();
      renderProperties();
      renderVariables();
      updatePreviewStatus();
      return;
    }
    state.renderer.setVariables(state.variables);
    state.renderer.setStatusStates(state.preview.statusStates);
    const comp = state.model.getComponent(state.preview.componentPath);
    const screens = state.renderer.listScreens(comp);
    if (state.preview.variantIndex > screens.length - 1) state.preview.variantIndex = Math.max(0, screens.length - 1);

    const vSel = $('previewVariant');
    const showVariant = screens.length > 1 && screens[0].name !== '';
    $('variantRow').classList.toggle('hidden', !showVariant);
    if (showVariant) {
      vSel.innerHTML = '';
      screens.forEach((s, i) => opt(vSel, i, s.name || ('Screen ' + (i + 1))));
      vSel.value = state.preview.variantIndex;
    }

    await state.renderer.render(state.preview.componentPath, {
      variantIndex: state.preview.variantIndex,
      selectedIndex: state.preview.selectedIndex,
      pageIndex: state.preview.pageIndex,
      frameIndex: state.preview.frameIndex,
      hidden: state.hidden,
      statusStates: state.preview.statusStates
    });

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
    updatePreviewStatus();

    if (state.currentTab === 'simulator') {
      await renderSimulatorPreview();
      renderSimulatorUI();
    }
  }

  function updatePreviewStatus() {
    const screen = state.renderer.lastScreen;
    const items = currentItems(screen);
    if ($('dockInfo')) {
      $('dockInfo').textContent = items.length ? items.length + ' items' : '';
    }
    if ($('simScreenName')) {
      const name = screen && screen.screen_name ? screen.screen_name : (state.preview.componentPath || '—');
      $('simScreenName').textContent = name;
    }
    if ($('simStackInfo')) $('simStackInfo').textContent = state.backStack.length + ' back';
    const statusScreen = $('statusScreen');
    if (statusScreen) {
      const comp = state.model.getComponent(state.preview.componentPath);
      const meta = ThemeTemplates.typeMeta(comp);
      const variant = $('previewVariant');
      const vName = state.renderer.listScreens(comp)[state.preview.variantIndex];
      statusScreen.textContent = meta.icon + ' ' + meta.label +
        (vName && vName.name ? ' · ' + vName.name : '') +
        (items.length ? ' · item ' + state.preview.selectedIndex : '');
    }
    if ($('simButtonMap')) {
      const items = currentItems(screen);
      const activeItem = items[state.preview.selectedIndex] || {};
      $('simButtonMap').textContent = JSON.stringify(
        Object.assign({}, (screen && screen.button_map) || {}, activeItem.button_map || {}), null, 2);
    }
  }

  // ---- zoom / pan ---------------------------------------------------------
  function computeFitZoom() {
    const wrap = $('previewCanvasWrap');
    if (!wrap) return state.preview.zoom || 1;
    const availW = Math.max(80, wrap.clientWidth - 26);
    const availH = Math.max(40, wrap.clientHeight - 26);
    return Math.max(0.1, Math.min(6, Math.min(availW / 480, availH / 222)));
  }

  function applyZoom() {
    const z = state.preview.zoomMode === 'fit' ? computeFitZoom() : state.preview.zoom;
    const cv = $('previewCanvas');
    if (!cv) return;
    cv.style.width = Math.round(480 * z) + 'px';
    cv.style.height = Math.round(222 * z) + 'px';
    if ($('zoomLabel')) $('zoomLabel').textContent = Math.round(z * 100) + '%';
    if ($('zoomRange') && document.activeElement !== $('zoomRange')) {
      $('zoomRange').value = String(Math.max(0.25, Math.min(6, z)));
    }
    if ($('previewZoom')) {
      if (state.preview.zoomMode === 'fit') {
        $('previewZoom').value = 'fit';
      } else {
        const match = Array.from($('previewZoom').options).find((o) => Math.abs(parseFloat(o.value) - z) < 0.01);
        if (match) $('previewZoom').value = match.value;
      }
    }
    if ($('statusZoom')) $('statusZoom').textContent = Math.round(z * 100) + '%';
  }

  function setZoom(mode, value) {
    state.preview.zoomMode = mode;
    if (value) state.preview.zoom = value;
    if ($('previewZoom') && mode === 'fit') $('previewZoom').value = 'fit';
    else if ($('previewZoom') && value) {
      const options = Array.from($('previewZoom').options).map((o) => o.value);
      if (options.includes(String(value))) $('previewZoom').value = String(value);
    }
    applyZoom();
  }

  function zoomBy(factor) {
    const current = state.preview.zoomMode === 'fit' ? computeFitZoom() : state.preview.zoom;
    setZoom('fixed', Math.max(0.25, Math.min(6, current * factor)));
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

  function snapValue(v) {
    return $('snapGrid').checked ? Math.round(v / 5) * 5 : Math.round(v);
  }

  function bindPreviewInteraction() {
    const cv = $('previewCanvas');

    const onCanvasPress = (e) => {
      if (state.pan || state.spaceDown || e.button === 1) return;
      const p = canvasPoint(e);
      const region = hitTest(p.x, p.y);
      if (!region) {
        clearSelection();
        drawSelectionOutline();
        renderLayers();
        renderProperties();
        return;
      }
      if ($('editMode').checked) {
        const node = { layer: region.layer || null, item: region.item || null };
        if (e.shiftKey) {
          setSelection([node], true);
        } else if (selectionHas(region.layer, region.item) && state.selection.length > 1) {
          state.selected = node;
        } else {
          setSelection([node], false);
        }
        history.push();
        const nodes = selectedNodes();
        state.drag = {
          region, startX: p.x, startY: p.y, moved: false, shift: e.shiftKey,
          nodes: nodes.map((n) => ({
            node: n,
            origLX: n.layer ? (n.layer.x || 0) : 0,
            origLY: n.layer ? (n.layer.y || 0) : 0,
            origIX: n.item ? (n.item.x || 0) : 0,
            origIY: n.item ? (n.item.y || 0) : 0
          }))
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
    };
    cv.addEventListener('mousedown', onCanvasPress);

    cv.addEventListener('mousemove', (e) => {
      const p = canvasPoint(e);
      state.lastCanvasPoint = p;
      if ($('previewCoords')) $('previewCoords').textContent = 'x: ' + Math.round(p.x) + ', y: ' + Math.round(p.y);
      const region = hitTest(p.x, p.y);
      const tag = $('previewHoverTag');
      if (tag) {
        if (region) {
          tag.textContent = hoverLabel(region);
          tag.classList.remove('hidden');
          const wrap = $('previewCanvasWrap');
          const wr = wrap.getBoundingClientRect();
          tag.style.left = (e.clientX - wr.left) + 'px';
          tag.style.top = (e.clientY - wr.top) + 'px';
        } else {
          tag.classList.add('hidden');
        }
      }
    });
    cv.addEventListener('mouseleave', () => {
      if ($('previewCoords')) $('previewCoords').textContent = '';
      const tag = $('previewHoverTag');
      if (tag) tag.classList.add('hidden');
    });

    // Space / middle-drag panning
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 1 && !(e.button === 0 && state.spaceDown)) return;
      const wrap = $('previewCanvasWrap');
      if (!wrap || !wrap.contains(e.target)) return;
      e.preventDefault();
      state.pan = { startX: e.clientX, startY: e.clientY, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop };
      wrap.classList.add('panning');
    });

    window.addEventListener('mousemove', (e) => {
      if (state.pan) {
        const wrap = $('previewCanvasWrap');
        wrap.scrollLeft = state.pan.scrollLeft - (e.clientX - state.pan.startX);
        wrap.scrollTop = state.pan.scrollTop - (e.clientY - state.pan.startY);
        return;
      }
      if (!state.drag) return;
      applyDrag(e);
    });

    function applyDrag(e) {
      const p = canvasPoint(e);
      const dx = p.x - state.drag.startX;
      const dy = p.y - state.drag.startY;
      const moveItem = e.shiftKey;
      for (const item of state.drag.nodes) {
        const n = item.node;
        if (moveItem && n.item) {
          if (n.item.x !== undefined || n.layer === null) {
            n.item.x = snapValue(item.origIX + dx);
            n.item.y = snapValue(item.origIY + dy);
            continue;
          }
        }
        if (n.layer) {
          n.layer.x = snapValue(item.origLX + dx);
          n.layer.y = snapValue(item.origLY + dy);
        } else if (n.item) {
          n.item.x = snapValue(item.origIX + dx);
          n.item.y = snapValue(item.origIY + dy);
        }
      }
      if (dx || dy) state.drag.moved = true;
      updateStatusSelection();
      requestPreviewRender();
    }

    window.addEventListener('mouseup', () => {
      endGesture();
    });

    function endGesture() {
      if (state.pan) {
        const wrap = $('previewCanvasWrap');
        if (wrap) wrap.classList.remove('panning');
        state.pan = null;
      }
      if (state.drag) {
        const moved = state.drag.moved;
        state.drag = null;
        if (moved) markDirty();
        else if (history.undoStack.length && history.same(history.undoStack[history.undoStack.length - 1], history.snapshot())) {
          history.undoStack.pop();
          updateHistoryButtons();
        }
      }
    }

    // ---- touch: same gestures as the mouse, for the Android build -------
    // The CSS keeps `touch-action: none` on the canvas while Edit is on, so a
    // one-finger drag moves the selection instead of scrolling the wrapper.
    cv.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || !$('editMode').checked) return;
      e.preventDefault();
      const t = e.touches[0];
      onCanvasPress({ clientX: t.clientX, clientY: t.clientY, button: 0, shiftKey: false });
    }, { passive: false });

    cv.addEventListener('touchmove', (e) => {
      if (!state.drag || e.touches.length !== 1) return;
      e.preventDefault();
      const t = e.touches[0];
      applyDrag({ clientX: t.clientX, clientY: t.clientY, shiftKey: false });
    }, { passive: false });

    cv.addEventListener('touchend', (e) => {
      if (!state.drag) return;
      e.preventDefault();
      endGesture();
    }, { passive: false });

    cv.addEventListener('touchcancel', () => {
      if (state.drag) endGesture();
    });

    // Drag an image file onto the canvas to import it as a layer.
    cv.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      cv.classList.add('drop-target');
    });
    cv.addEventListener('dragleave', () => cv.classList.remove('drop-target'));
    cv.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      cv.classList.remove('drop-target');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const p = canvasPoint(e);
      dropImageAsLayer(f, p.x, p.y);
    });

    // Context menu
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = canvasPoint(e);
      const region = hitTest(p.x, p.y);
      if (region) {
        if (!selectionHas(region.layer, region.item)) {
          setSelection([{ layer: region.layer, item: region.item }], false);
          renderLayers();
          renderProperties();
          drawSelectionOutline();
        }
      }
      const items = [];
      if (region) {
        items.push({ label: 'Duplicate', action: duplicateSelection });
        items.push({ label: 'Copy', action: copySelection });
        items.push({ label: 'Delete', action: deleteSelection });
        items.push({ sep: true });
        items.push({ label: 'Bring forward', action: () => reorderSelection(1) });
        items.push({ label: 'Send backward', action: () => reorderSelection(-1) });
        items.push({ sep: true });
        items.push({ label: 'Align left', action: () => alignSelection('left', false) });
        items.push({ label: 'Align center H', action: () => alignSelection('centerH', false) });
        items.push({ label: 'Align right', action: () => alignSelection('right', false) });
        items.push({ label: 'Align middle', action: () => alignSelection('middle', false) });
        items.push({ label: 'Distribute horizontally', action: () => distributeSelection('h') });
        items.push({ label: 'Distribute vertically', action: () => distributeSelection('v') });
        if (region.item) items.push({ label: 'Select parent item', action: () => { setSelection([{ layer: null, item: region.item }], false); renderLayers(); renderProperties(); drawSelectionOutline(); } });
        items.push({ sep: true });
      }
      items.push({ label: 'Add text layer', action: () => addLayer('text') });
      items.push({ label: 'Add image layer', action: () => addLayer('image') });
      if (state.clipboard) items.push({ label: 'Paste', action: pasteSelection });
      items.push({ sep: true });
      items.push({ label: 'Open component JSON', action: () => { setTab('components'); if (state.preview.componentPath) selectComponent(state.preview.componentPath); } });
      showContextMenu(e.clientX, e.clientY, items);
    });

    // Wheel zoom
    const wrap = $('previewCanvasWrap');
    wrap.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const current = state.preview.zoomMode === 'fit' ? computeFitZoom() : state.preview.zoom;
      const next = Math.max(0.25, Math.min(6, current * (dir > 0 ? 1.12 : 0.89)));
      const rect = wrap.getBoundingClientRect();
      const rx = (e.clientX - rect.left + wrap.scrollLeft) / wrap.scrollWidth;
      const ry = (e.clientY - rect.top + wrap.scrollTop) / wrap.scrollHeight;
      setZoom('fixed', next);
      requestAnimationFrame(() => {
        wrap.scrollLeft = rx * wrap.scrollWidth - (e.clientX - rect.left);
        wrap.scrollTop = ry * wrap.scrollHeight - (e.clientY - rect.top);
      });
    }, { passive: false });
  }

  function hoverLabel(region) {
    if (!region) return '';
    if (region.layer) {
      if (region.layer.image_path) return '🖼 ' + region.layer.image_path;
      if (region.layer.text != null) return 'T “' + region.layer.text + '”';
      if (region.layer.variable_name) return 'T ' + region.layer.variable_name;
      if (region.layer.use_template) return '⧉ ' + region.layer.use_template;
      if (region.layer.toggle_template) return '◑ toggle';
      if (region.layer.radio_template) return '◉ radio';
      return 'layer';
    }
    if (region.item) return 'item · ' + (region.item.id || '#' + region.itemIndex);
    return '';
  }

  // ---- simulation ---------------------------------------------------------
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
        const row = mk('div', 'variable-row');
        const label = mk('label', '', name);
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
    const b = $('btnSimBack');
    if (b) b.disabled = state.backStack.length === 0;
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
    renderSimulatorUI();
  }

  function popBack() {
    const s = state.backStack.pop();
    if (!s) { toast('No previous screen to return to', true); return; }
    state.preview.componentPath = s.componentPath;
    state.preview.variantIndex = s.variantIndex;
    state.preview.pageIndex = s.pageIndex;
    state.preview.selectedIndex = s.selectedIndex;
    state.preview.frameIndex = s.frameIndex;
    populatePreviewComponentSelect();
    renderPreview();
    updateSimBack();
    renderSimulatorUI();
  }

  function jumpToComponent(path) {
    pushBack();
    state.preview.componentPath = path;
    state.preview.variantIndex = 0;
    state.preview.selectedIndex = 0;
    state.preview.pageIndex = 0;
    state.preview.frameIndex = 0;
    populatePreviewComponentSelect();
    renderPreview();
    renderSimulatorUI();
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
      let offset = 0;
      for (let r = 0; r < screen.rows.length; r++) {
        const idx = find(screen.rows[r]);
        if (idx >= 0) { state.preview.selectedIndex = offset + idx; renderPreview(); return; }
        offset += (screen.rows[r] || []).length;
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
      if (target.startsWith('status:')) return;
    }
    state.preview.selectedIndex = region.itemIndex;
    renderPreview();
  }

  function simButton(dir) {
    const screen = state.renderer.lastScreen;
    const items = currentItems(screen);
    const activeItem = items[state.preview.selectedIndex] || {};
    const map = Object.assign({}, (screen && screen.button_map) || {}, activeItem.button_map || {});
    const action = map[dir] || (dir === 'b' ? 'back' : null);
    if (action === 'select' || (dir === 'a' && !action)) {
      const region = state.renderer.hitRegions.slice().reverse()
        .find((r) => r.itemIndex === state.preview.selectedIndex && r.item);
      if (region) simulateClick(region);
      return;
    }
    if (dir === 'b' || action === 'back') { popBack(); return; }
    if (action === 'noop') return;
    if (action === 'previous_page') {
      state.preview.pageIndex = Math.max(0, state.preview.pageIndex - 1);
      renderPreview();
      return;
    }
    if (action === 'next_page') {
      state.preview.pageIndex++;
      renderPreview();
      return;
    }
    if (action === 'previous' || (dir === 'up' && !map.up)) {
      state.preview.selectedIndex = Math.max(0, state.preview.selectedIndex - 1);
      renderPreview();
      return;
    }
    if (action === 'next' || (dir === 'down' && !map.down)) {
      state.preview.selectedIndex = Math.min(Math.max(0, items.length - 1), state.preview.selectedIndex + 1);
      renderPreview();
      return;
    }
    if (dir === 'left' && !map.left) {
      state.preview.pageIndex = Math.max(0, state.preview.pageIndex - 1);
      renderPreview();
      return;
    }
    if (dir === 'right' && !map.right) {
      state.preview.pageIndex++;
      renderPreview();
    }
  }

  // ---- layers panel + properties inspector --------------------------------
  const nodeIds = new WeakMap();
  let nodeIdSeq = 0;
  function idOf(obj) {
    if (!obj) return 0;
    if (!nodeIds.has(obj)) nodeIds.set(obj, ++nodeIdSeq);
    return nodeIds.get(obj);
  }

  function layerGlyph(layer) {
    if (layer.image_path) return '🖼';
    if (layer.toggle_template) return '◉';
    if (layer.radio_template) return '◉';
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
    else if (layer.radio_template) t = 'radio';
    else if (layer.string_template) t = 'string';
    else t = 'layer';
    return (prefix ? prefix + ' · ' : '') + t;
  }

  function buildLayerNodes(screen) {
    const nodes = [];
    if (!screen) return nodes;
    if (screen.__syntheticLayers) {
      screen.__syntheticLayers.forEach((layer, index) => {
        nodes.push({ layer, item: null, parent: screen.__syntheticLayers, index, label: layerLabel(layer, 'state'), group: 'State' });
      });
      return nodes;
    }
    if (screen.status_bar_items) {
      for (const [name, item] of Object.entries(screen.status_bar_items)) {
        const states = item.layers || {};
        for (const [stateName, layers] of Object.entries(states)) {
          if (!Array.isArray(layers)) continue;
          layers.forEach((layer, index) => {
            nodes.push({ layer, item: null, parent: layers, index, label: layerLabel(layer, name + '/' + stateName), group: 'Status bar' });
          });
        }
      }
      return nodes;
    }
    const bg = screen.background || {};
    const bgLayers = Array.isArray(bg.layers) ? bg.layers : [];
    bgLayers.forEach((layer, index) => {
      nodes.push({ layer, item: null, parent: bgLayers, index, label: layerLabel(layer, 'bg'), group: 'Background' });
    });
    const items = currentItems(screen);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      nodes.push({ layer: null, item, parent: items, index: i, label: 'item · ' + (item.id || ('#' + i)), group: 'Items', kind: 'item' });
      const layers = Array.isArray(item.layers) ? item.layers : [];
      const selLayers = Array.isArray(item.selected_layers) ? item.selected_layers : [];
      layers.forEach((layer, index) => nodes.push({ layer, item, parent: layers, index, label: layerLabel(layer, ''), group: 'Items', group2: item.id }));
      selLayers.forEach((layer, index) => nodes.push({ layer, item, parent: selLayers, index, label: layerLabel(layer, 'sel'), group: 'Items', group2: item.id }));
    }
    return nodes;
  }

  let currentLayerNodes = [];
  let lastLayerSig = null;

  function renderLayers() {
    const box = $('layersBox');
    const list = $('layerList');
    if (!box || !list) return;
    const allNodes = buildLayerNodes(state.renderer.lastScreen);
    const filter = ($('layerFilter') ? $('layerFilter').value : '').toLowerCase();
    const nodes = allNodes.filter((n) => !filter || n.label.toLowerCase().includes(filter));
    const sig = nodes.map((n) => (n.layer ? 'L' + idOf(n.layer) : 'I' + idOf(n.item)) + '|' + n.label).join(',');
    if (sig !== lastLayerSig) {
      lastLayerSig = sig;
      currentLayerNodes = nodes;
      list.innerHTML = '';
      let lastGroup = null;
      for (const node of nodes) {
        if (node.group && node.group !== lastGroup) {
          lastGroup = node.group;
          const gh = mk('li', 'layer-group', node.group);
          gh.style.listStyle = 'none';
          gh.style.font = '700 8px/1.6 var(--mono)';
          gh.style.letterSpacing = '.12em';
          gh.style.textTransform = 'uppercase';
          gh.style.color = 'var(--muted)';
          gh.style.padding = '3px 5px 1px';
          list.appendChild(gh);
        }
        const li = mk('li', 'layer-row');
        li.draggable = true;
        li.dataset.key = nodeKey(node);

        const eye = mk('button', 'mini eye', state.hidden.has(node.layer || node.item) ? '▫' : '▮');
        eye.title = 'Show / hide in preview (still exported)';
        eye.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = node.layer || node.item;
          if (state.hidden.has(key)) state.hidden.delete(key); else state.hidden.add(key);
          renderPreview();
        });

        const lock = mk('button', 'mini lock', state.locked.has(node.layer || node.item) ? '🔒' : '🔓');
        lock.title = 'Lock / unlock dragging';
        lock.addEventListener('click', (e) => {
          e.stopPropagation();
          const key = node.layer || node.item;
          if (state.locked.has(key)) state.locked.delete(key); else state.locked.add(key);
          renderLayers();
        });

        const glyph = mk('span', 'glyph', node.layer ? layerGlyph(node.layer) : '☰');
        const label = mk('span', 'lname', node.label);

        li.appendChild(eye);
        li.appendChild(lock);
        li.appendChild(glyph);
        li.appendChild(label);

        const move = mk('span', 'move');
        const up = mk('button', 'mini', '↑'); up.title = 'Move up';
        up.addEventListener('click', (e) => { e.stopPropagation(); moveLayerNode(node, -1); });
        const down = mk('button', 'mini', '↓'); down.title = 'Move down';
        down.addEventListener('click', (e) => { e.stopPropagation(); moveLayerNode(node, 1); });
        const del = mk('button', 'mini', '✕'); del.title = 'Delete';
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteLayerNode(node); });
        move.appendChild(up);
        move.appendChild(down);
        move.appendChild(del);
        li.appendChild(move);

        li.classList.toggle('locked', state.locked.has(node.layer || node.item));
        li.addEventListener('click', (e) => {
          setSelection([node], e.shiftKey);
          renderLayers();
          renderProperties();
          drawSelectionOutline();
        });
        li.addEventListener('dblclick', () => {
          setDockTab('inspect');
        });
        li.addEventListener('dragstart', (e) => {
          li.classList.add('dragging');
          e.dataTransfer.setData('text/plain', nodeKey(node));
          e.dataTransfer.effectAllowed = 'move';
        });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
        li.addEventListener('drop', (e) => {
          e.preventDefault();
          const fromKey = e.dataTransfer.getData('text/plain');
          const fromNode = currentLayerNodes.find((n) => nodeKey(n) === fromKey);
          if (fromNode && fromNode.parent === node.parent && fromNode.index !== node.index) {
            history.push();
            const arr = node.parent;
            const [moved] = arr.splice(fromNode.index, 1);
            arr.splice(node.index, 0, moved);
            markDirty();
            renderPreview();
          }
        });

        list.appendChild(li);
      }
    }
    box.classList.toggle('hidden', allNodes.length === 0);
    // Refresh active + eye/lock state without rebuilding (preserves scroll/focus).
    const lis = list.querySelectorAll('.layer-row');
    for (let i = 0; i < currentLayerNodes.length && i < lis.length; i++) {
      const node = currentLayerNodes[i];
      const li = lis[i];
      const isSel = selectionHas(node.layer, node.item);
      li.classList.toggle('active', !!isSel);
      const eye = li.querySelector('.eye');
      if (eye) eye.textContent = state.hidden.has(node.layer || node.item) ? '▫' : '▮';
      const lock = li.querySelector('.lock');
      if (lock) lock.textContent = state.locked.has(node.layer || node.item) ? '🔒' : '🔓';
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
      if (selectionHas(node.layer, null)) clearSelection();
    } else if (node.item && node.parent) {
      node.parent.splice(node.index, 1);
      if (selectionHas(null, node.item)) clearSelection();
    } else {
      history.undoStack.pop();
      return;
    }
    markDirty();
    renderPreview();
    toast('Deleted ' + (node.layer ? 'layer' : 'item'));
  }

  function addLayer(type) {
    const screen = state.renderer.lastScreen;
    if (!screen) { toast('Select a component to add a layer', true); return; }
    const assets = state.model.listAssets();
    const palette = Object.keys(state.model.getPalette()).sort();
    const sel = state.selected;
    let container;
    if (screen.__syntheticLayers) {
      container = screen.__syntheticLayers;
    } else if (sel && sel.item) {
      container = Array.isArray(sel.item.layers) ? sel.item.layers : (sel.item.layers = []);
    } else {
      container = screen.background && Array.isArray(screen.background.layers)
        ? screen.background.layers
        : (screen.background = Object.assign({}, screen.background, { layers: [] })).layers;
    }
    let layer;
    if (type === 'image' && assets.length) {
      layer = { image_path: assets[0], x: 0, y: 0 };
    } else if (type === 'image') {
      toast('Import an image asset first', true);
      return;
    } else {
      layer = { text: 'New text', x: 0, y: 0, text_size: 'medium', text_color_palette: palette.includes('soft_white') ? 'soft_white' : (palette[0] || 'soft_white') };
    }
    history.push();
    container.push(layer);
    setSelection([{ layer, item: sel && sel.item ? sel.item : null }], false);
    markDirty();
    renderPreview();
    setDockTab('inspect');
    toast('Added ' + (type === 'image' ? 'image' : 'text') + ' layer');
  }

  async function dropImageAsLayer(file, x, y) {
    if (!file) return;
    if (!(/^image\//i.test(file.type || '') || /\.(png|jpe?g|gif|bmp|webp)$/i.test(file.name || ''))) {
      toast('Drop an image file to add it as a layer', true);
      return;
    }
    const screen = state.renderer.lastScreen;
    if (!screen) { toast('Select a component first', true); return; }
    history.push();
    const buf = await file.arrayBuffer();
    const path = 'assets/' + file.name;
    invalidateAsset(path);
    state.model.setFile(path, Zip.bytesToBase64(new Uint8Array(buf)), true);
    let container;
    if (screen.__syntheticLayers) container = screen.__syntheticLayers;
    else if (state.selected && state.selected.item) {
      const it = state.selected.item;
      container = Array.isArray(it.layers) ? it.layers : (it.layers = []);
    } else {
      container = screen.background && Array.isArray(screen.background.layers)
        ? screen.background.layers
        : (screen.background = Object.assign({}, screen.background, { layers: [] })).layers;
    }
    let lx = x, ly = y;
    if (state.selected && state.selected.item && container === state.selected.item.layers) {
      lx -= state.selected.item.x || 0;
      ly -= state.selected.item.y || 0;
    }
    const layer = { image_path: path, x: Math.round(lx), y: Math.round(ly) };
    container.push(layer);
    state.selectedAsset = path;
    setSelection([{ layer, item: state.selected && state.selected.item ? state.selected.item : null }], false);
    markDirty();
    renderAssets();
    if (state.imageLab) state.imageLab.refreshAssetList();
    renderPreview();
    runValidation();
    renderOverview();
    setDockTab('layers');
    toast('Imported ' + path + ' as a layer');
  }

  function duplicateLayerNode(node) {
    if (!node || !node.parent || (!node.layer && !node.item)) return;
    history.push();
    const copy = JSON.parse(JSON.stringify(node.layer || node.item));
    if (copy.x != null) copy.x = (copy.x || 0) + 6;
    if (copy.y != null) copy.y = (copy.y || 0) + 6;
    node.parent.splice(node.index + 1, 0, copy);
    if (node.layer) setSelection([{ layer: copy, item: node.item || null }], false);
    else setSelection([{ layer: null, item: copy }], false);
    markDirty();
    renderPreview();
    toast('Duplicated ' + (node.layer ? 'layer' : 'item'));
  }

  // ---- properties inspector -----------------------------------------------
  let lastPropsKey = null;
  let propBindings = [];

  function propRow(fields, labelText) {
    const row = mk('div', 'prop-row');
    row.appendChild(mk('label', '', labelText));
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
    opt(sel, '', '—');
    for (const o of options) {
      if (typeof o === 'object') opt(sel, o.value, o.label);
      else opt(sel, o, o);
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

  function propPalette(fields, labelText, obj, key, aliasKey) {
    const row = propRow(fields, labelText);
    const wrap = mk('span', '');
    wrap.style.display = 'flex';
    wrap.style.flex = '1';
    wrap.style.gap = '4px';
    wrap.style.alignItems = 'center';
    const sw = mk('span', 'swatch');
    const palette = state.model.getPalette();
    const current = obj[key] || (aliasKey ? obj[aliasKey] : '') || '';
    sw.style.background = Palette.toCss(Palette.resolve(current, palette) || { r: 0, g: 0, b: 0 });
    const sel = document.createElement('select');
    opt(sel, '', '—');
    for (const n of Object.keys(palette).sort()) opt(sel, n, n);
    sel.value = current;
    sel.style.flex = '1';
    sel.addEventListener('focus', () => history.push());
    sel.addEventListener('change', () => {
      if (sel.value === '') delete obj[key]; else obj[key] = sel.value;
      if (aliasKey) delete obj[aliasKey];
      sw.style.background = Palette.toCss(Palette.resolve(sel.value, palette) || { r: 0, g: 0, b: 0 });
      markDirty();
      renderPreview();
    });
    wrap.appendChild(sw);
    wrap.appendChild(sel);
    row.appendChild(wrap);
    bindProp(sel, () => obj[key] || (aliasKey ? obj[aliasKey] : '') || '');
  }

  function propAsset(fields, labelText, obj, key) {
    const row = propRow(fields, labelText);
    const wrap = mk('span', '');
    wrap.style.display = 'flex';
    wrap.style.flex = '1';
    wrap.style.gap = '4px';
    const sel = document.createElement('select');
    opt(sel, '', '—');
    for (const p of state.model.listAssets()) opt(sel, p, p);
    sel.value = obj[key] || '';
    sel.style.flex = '1';
    sel.addEventListener('focus', () => history.push());
    sel.addEventListener('change', () => {
      if (sel.value === '') delete obj[key]; else obj[key] = sel.value;
      markDirty();
      renderPreview();
    });
    const pick = mk('button', 'mini', '…');
    pick.addEventListener('click', async () => {
      const raw = await askText({ title: 'Image asset', label: 'Asset path', value: sel.value || (state.model.listAssets()[0] || 'assets/') });
      if (raw == null) return;
      const p = raw.startsWith('assets/') ? raw : 'assets/' + raw;
      if (!state.model.has(p)) { toast('Asset not found: ' + p, true); return; }
      obj[key] = p;
      sel.value = p;
      markDirty();
      renderPreview();
    });
    wrap.appendChild(sel);
    wrap.appendChild(pick);
    row.appendChild(wrap);
    bindProp(sel, () => obj[key] || '');
  }

  function propCheck(fields, labelText, obj, key) {
    const row = propRow(fields, labelText);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!obj[key];
    input.addEventListener('change', () => {
      history.push();
      if (input.checked) obj[key] = true; else delete obj[key];
      markDirty();
      renderPreview();
    });
    row.appendChild(input);
    bindProp(input, () => !!obj[key]);
  }

  function propCenter(fields, layer) {
    const row = propRow(fields, 'Center');
    const box = mk('span', '');
    box.style.display = 'grid';
    box.style.gridTemplateColumns = 'repeat(4, 1fr)';
    box.style.gap = '3px';
    box.style.flex = '1';
    if (!layer.center_text_within) layer.center_text_within = { start_x: 0, start_y: 0, end_x: 480, end_y: 222 };
    for (const k of ['start_x', 'start_y', 'end_x', 'end_y']) {
      const input = document.createElement('input');
      input.type = 'number';
      input.placeholder = k;
      input.title = k;
      input.value = layer.center_text_within[k] || 0;
      input.style.width = '100%';
      input.addEventListener('change', () => {
        history.push();
        layer.center_text_within[k] = Math.round(parseFloat(input.value) || 0);
        markDirty();
        renderPreview();
      });
      box.appendChild(input);
      bindProp(input, () => layer.center_text_within[k] || 0);
    }
    row.appendChild(box);
  }

  function buildLayerProps(fields, layer) {
    propNumber(fields, 'X', layer, 'x');
    propNumber(fields, 'Y', layer, 'y');

    const imageLike = layer.image_path || (!layer.text && !layer.variable_name && !layer.use_template && !layer.toggle_template && !layer.radio_template && !layer.string_template && !layer.variable);
    if (imageLike) {
      propAsset(fields, 'Image', layer, 'image_path');
      propPalette(fields, 'Recolor', layer, 'recolor_palette');
      const row = propRow(fields, 'RGB');
      const input = document.createElement('input');
      input.type = 'color';
      const rgb = layer.recolor_rgb;
      input.value = rgb ? Palette.toHex(rgb) : '#ffffff';
      input.addEventListener('change', () => {
        history.push();
        layer.recolor_rgb = Palette.fromHex(input.value);
        markDirty();
        renderPreview();
      });
      row.appendChild(input);
      bindProp(input, () => rgb ? Palette.toHex(layer.recolor_rgb) : '#ffffff');
    }
    const textLike = layer.text != null || layer.variable_name || layer.variable || layer.use_template || layer.string_template || layer.text_color_palette || layer.text_color;
    if (textLike) {
      propText(fields, 'Text', layer, 'text');
      propText(fields, 'Variable', layer, 'variable_name');
      propPalette(fields, 'Color', layer, 'text_color_palette', 'text_color');
      const sizeRow = propRow(fields, 'Size');
      const sizeSel = document.createElement('select');
      for (const s of ['small', 'medium', 'large']) opt(sizeSel, s, s);
      sizeSel.value = layer.text_size || 'medium';
      sizeSel.addEventListener('focus', () => history.push());
      sizeSel.addEventListener('change', () => {
        layer.text_size = sizeSel.value;
        markDirty();
        renderPreview();
      });
      sizeRow.appendChild(sizeSel);
      bindProp(sizeSel, () => layer.text_size || 'medium');
      const tpls = [];
      const tj = state.model.getThemeJson() || {};
      for (const [map, label] of [['string_templates', 'text'], ['toggle_templates', 'toggle'], ['radio_templates', 'radio'], ['signal_templates', 'signal']]) {
        for (const k of Object.keys(tj[map] || {})) tpls.push({ value: k, label: label + ' · ' + k });
      }
      propSelect(fields, 'Template', layer, 'use_template', tpls);
      propText(fields, 'String tmpl', layer, 'string_template');
      propNumber(fields, 'Max chars', layer, 'max_chars');
      propNumber(fields, 'Max lines', layer, 'max_lines');
      propCheck(fields, 'Wrap', layer, 'wrap_text');
      propCenter(fields, layer);
    }
    if (layer.toggle_template || layer.radio_template) {
      const row = propRow(fields, 'Template');
      const b = mk('button', 'mini', 'Edit states JSON');
      b.addEventListener('click', () => {
        setTab('components');
        if (state.preview.componentPath) selectComponent(state.preview.componentPath);
        setComponentMode('json');
      });
      row.appendChild(b);
    }
  }

  function buildItemProps(fields, item) {
    propNumber(fields, 'X', item, 'x');
    propNumber(fields, 'Y', item, 'y');
    propText(fields, 'ID', item, 'id');

    const targets = [{ value: '', label: '—' }];
    for (const s of ThemeTemplates.TARGET_SPECIALS) targets.push({ value: s, label: s });
    const tj = state.model.getThemeJson() || {};
    for (const t of ThemeTemplates.componentTargets(tj)) targets.push(t);
    for (const p of state.model.listComponents()) targets.push({ value: p, label: p });
    propSelect(fields, 'Target', item, 'target', targets);
    propText(fields, 'Variable', item, 'variable');
    propCheck(fields, 'Selected', item, 'selected');
    propCheck(fields, 'Unselectable', item, 'unselectable');
    propNumber(fields, 'Anim ms', item, 'animation_interval');
    const mapRow = propRow(fields, 'Buttons');
    const b = mk('button', 'mini', 'Edit button_map');
    b.addEventListener('click', async () => {
      const text = await askText({
        title: 'Button map',
        label: 'button_map JSON',
        value: JSON.stringify(item.button_map || {}, null, 2),
        multiline: true
      });
      if (text == null) return;
      try {
        const obj = JSON.parse(text);
        history.push();
        if (obj && Object.keys(obj).length) item.button_map = obj; else delete item.button_map;
        markDirty();
        renderPreview();
      } catch (e) { toast('Invalid JSON', true); }
    });
    mapRow.appendChild(b);
    const layersRow = propRow(fields, 'Layers');
    layersRow.appendChild(mk('span', 'muted mono', (item.layers || []).length + ' normal / ' + (item.selected_layers || []).length + ' selected'));
  }

  function buildScreenProps(fields, comp) {
    const root = comp.template && typeof comp.template === 'object' ? comp.template : comp;
    const path = state.preview.componentPath;
    const note = mk('div', 'muted', ThemeTemplates.typeMeta(comp).icon + ' ' + ThemeTemplates.typeMeta(comp).label + ' · ' + path);
    fields.appendChild(note);
    const setRoot = (key, value) => {
      history.push();
      if (value === '' || value == null) delete root[key]; else root[key] = value;
      state.model.setComponentRaw(path, JSON.stringify(comp, null, 2));
      markDirty();
      renderPreview();
    };
    propText(fields, 'Screen', root, 'screen_name');
    const tj = state.model.getThemeJson() || {};
    propSelect(fields, 'Status bar', root, 'status_bar', [{ value: '', label: '—' }].concat(Object.keys(tj.status_bars || {}).map((k) => ({ value: k, label: k }))));
    propCheck(fields, 'Windowed', root, 'windowed_canvas');
    propCheck(fields, 'Cache', root, 'cache_canvases');
    propNumber(fields, 'Title X', root, 'title_x');
    propNumber(fields, 'Title Y', root, 'title_y');
    const row = propRow(fields, 'Actions');
    const b = mk('button', 'mini', 'Open component');
    b.addEventListener('click', () => { setTab('components'); selectComponent(path); });
    row.appendChild(b);
  }

  function renderProperties() {
    const box = $('propsBox');
    const fields = $('propsFields');
    if (!box || !fields) return;
    const sel = state.selected;
    const target = sel && (sel.layer || sel.item);
    const rawComp = state.preview.componentPath ? state.model.getComponent(state.preview.componentPath) : null;
    const comp = rawComp && !rawComp.__parseError ? rawComp : null;
    const key = target
      ? (sel.layer ? 'L' + idOf(sel.layer) : 'I' + idOf(sel.item))
      : (comp ? 'C' + state.preview.componentPath : 'none');
    box.classList.toggle('hidden', !target && !comp);
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
    if (sel && sel.layer) buildLayerProps(fields, sel.layer);
    else if (sel && sel.item) buildItemProps(fields, sel.item);
    else if (comp && !comp.__parseError) buildScreenProps(fields, comp);

    if (target) {
      const section = mk('div', 'prop-section', 'Align / distribute');
      fields.appendChild(section);
      const grid = mk('div', 'align-grid');
      const buttons = [
        ['⇤', 'Left', () => alignSelection('left', false)],
        ['↔', 'Center H', () => alignSelection('centerH', false)],
        ['⇥', 'Right', () => alignSelection('right', false)],
        ['⤒', 'Top', () => alignSelection('top', false)],
        ['↕', 'Middle', () => alignSelection('middle', false)],
        ['⤓', 'Bottom', () => alignSelection('bottom', false)],
        ['⇹', 'Distribute H', () => distributeSelection('h')],
        ['⇳', 'Distribute V', () => distributeSelection('v')]
      ];
      for (const [icon, title, fn] of buttons) {
        const b = mk('button', 'mini', icon);
        b.title = title;
        b.addEventListener('click', fn);
        grid.appendChild(b);
      }
      fields.appendChild(grid);
    }
  }

  // ---- align / distribute -------------------------------------------------
  function regionForNode(node) {
    if (node.layer) return state.renderer.hitRegions.find((r) => r.layer === node.layer) || null;
    if (!node.item) return null;
    const regs = state.renderer.hitRegions.filter((r) => r.item === node.item);
    if (!regs.length) return null;
    const x1 = Math.min(...regs.map((r) => r.x));
    const y1 = Math.min(...regs.map((r) => r.y));
    const x2 = Math.max(...regs.map((r) => r.x + (r.w || 1)));
    const y2 = Math.max(...regs.map((r) => r.y + (r.h || 1)));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function nudgeNodeBy(node, dx, dy) {
    if (node.layer) {
      node.layer.x = Math.round((node.layer.x || 0) + dx);
      node.layer.y = Math.round((node.layer.y || 0) + dy);
    } else if (node.item) {
      node.item.x = Math.round((node.item.x || 0) + dx);
      node.item.y = Math.round((node.item.y || 0) + dy);
    }
  }

  function alignSelection(mode, distribute) {
    const nodes = selectedNodes();
    if (!nodes.length) return;
    const entries = [];
    for (const n of nodes) {
      const r = regionForNode(n);
      if (r) entries.push({ node: n, r });
    }
    if (!entries.length) return;
    history.push();
    let targetX = 0, targetY = 0, targetCX = 240, targetCY = 111;
    if (entries.length > 1) {
      const minX = Math.min(...entries.map((e) => e.r.x));
      const maxX = Math.max(...entries.map((e) => e.r.x + e.r.w));
      const minY = Math.min(...entries.map((e) => e.r.y));
      const maxY = Math.max(...entries.map((e) => e.r.y + e.r.h));
      targetX = minX;
      targetCX = (minX + maxX) / 2;
      targetY = minY;
      targetCY = (minY + maxY) / 2;
    }
    for (const e of entries) {
      let dx = 0, dy = 0;
      if (mode === 'left') dx = targetX - e.r.x;
      else if (mode === 'right') dx = (entries.length > 1 ? Math.max(...entries.map((x) => x.r.x + x.r.w)) : 480) - (e.r.x + e.r.w);
      else if (mode === 'centerH') dx = (entries.length > 1 ? targetCX : 240) - (e.r.x + e.r.w / 2);
      else if (mode === 'top') dy = targetY - e.r.y;
      else if (mode === 'bottom') dy = (entries.length > 1 ? Math.max(...entries.map((x) => x.r.y + x.r.h)) : 222) - (e.r.y + e.r.h);
      else if (mode === 'middle') dy = (entries.length > 1 ? targetCY : 111) - (e.r.y + e.r.h / 2);
      if (dx || dy) nudgeNodeBy(e.node, dx, dy);
    }
    markDirty();
    renderPreview();
    toast('Aligned ' + entries.length + ' item(s)');
  }

  function distributeSelection(axis) {
    const nodes = selectedNodes();
    if (nodes.length < 3) { toast('Select at least 3 items to distribute', true); return; }
    const entries = [];
    for (const n of nodes) {
      const r = regionForNode(n);
      if (r) entries.push({ node: n, r });
    }
    if (entries.length < 3) { toast('Select at least 3 visible items to distribute', true); return; }
    history.push();
    const key = axis === 'h' ? 'x' : 'y';
    const sizeKey = axis === 'h' ? 'w' : 'h';
    entries.sort((a, b) => a.r[key] - b.r[key]);
    const first = entries[0], last = entries[entries.length - 1];
    const start = first.r[key] + first.r[sizeKey];
    const end = last.r[key];
    const gap = (end - start) / (entries.length - 1);
    for (let i = 1; i < entries.length - 1; i++) {
      const e = entries[i];
      const desired = start + gap * i;
      const delta = desired - e.r[key];
      if (axis === 'h') nudgeNodeBy(e.node, delta, 0);
      else nudgeNodeBy(e.node, 0, delta);
    }
    markDirty();
    renderPreview();
    toast('Distributed ' + entries.length + ' items');
  }

  function drawSelectionOutline() {
    const r = state.renderer;
    if (!r) return;
    const c = r.ctx;
    if ($('showGrid') && $('showGrid').checked) {
      c.save();
      c.strokeStyle = 'rgba(0,255,156,0.12)';
      c.lineWidth = 1;
      for (let x = 0; x <= 480; x += 20) { c.beginPath(); c.moveTo(x + .5, 0); c.lineTo(x + .5, 222); c.stroke(); }
      for (let y = 0; y <= 222; y += 20) { c.beginPath(); c.moveTo(0, y + .5); c.lineTo(480, y + .5); c.stroke(); }
      c.restore();
    }
    if (!$('editMode').checked) return;
    const nodes = selectedNodes();
    if (!nodes.length) return;
    c.save();
    c.strokeStyle = '#00ff9c';
    c.lineWidth = 1;
    c.setLineDash([4, 2]);
    for (const node of nodes) {
      let region = null;
      if (node.layer) {
        region = r.hitRegions.find((reg) => reg.layer === node.layer);
      } else if (node.item) {
        const regs = r.hitRegions.filter((reg) => reg.item === node.item);
        if (regs.length) {
          const x1 = Math.min(...regs.map((x) => x.x));
          const y1 = Math.min(...regs.map((x) => x.y));
          const x2 = Math.max(...regs.map((x) => x.x + (x.w || 1)));
          const y2 = Math.max(...regs.map((x) => x.y + (x.h || 1)));
          region = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        }
      }
      if (!region) continue;
      c.strokeRect(region.x - 1, region.y - 1, (region.w || 1) + 2, (region.h || 1) + 2);
      c.setLineDash([]);
      // corner handles
      const xs = [region.x - 1, region.x + (region.w || 1) + 1];
      const ys = [region.y - 1, region.y + (region.h || 1) + 1];
      c.fillStyle = '#001a10';
      for (const x of xs) for (const y of ys) {
        c.fillRect(x - 2, y - 2, 4, 4);
        c.strokeRect(x - 2, y - 2, 4, 4);
      }
      c.setLineDash([4, 2]);
    }
    c.setLineDash([]);
    c.restore();
  }

  // ---- selection operations ------------------------------------------------
  function screenLayerArrays(screen) {
    const arrays = [];
    if (!screen) return arrays;
    if (Array.isArray(screen.__syntheticLayers)) arrays.push(screen.__syntheticLayers);
    if (screen.background && Array.isArray(screen.background.layers)) arrays.push(screen.background.layers);
    const items = currentItems(screen);
    arrays.push(items);
    for (const it of items) {
      if (Array.isArray(it.layers)) arrays.push(it.layers);
      if (Array.isArray(it.selected_layers)) arrays.push(it.selected_layers);
    }
    if (screen.status_bar_items) {
      for (const item of Object.values(screen.status_bar_items)) {
        for (const layers of Object.values(item.layers || {})) {
          if (Array.isArray(layers)) arrays.push(layers);
        }
      }
    }
    return arrays;
  }

  function deleteSelection() {
    const nodes = selectedNodes();
    if (!nodes.length) return;
    history.push();
    for (const n of nodes) {
      if (n.layer && n.layer.__parent) {
        const arr = n.layer.__parent;
        const i = arr.indexOf(n.layer);
        if (i >= 0) arr.splice(i, 1);
      } else if (n.item && n.item.__parent) {
        const arr = n.item.__parent;
        const i = arr.indexOf(n.item);
        if (i >= 0) arr.splice(i, 1);
      }
    }
    // Fallback: find by identity in the current screen tree.
    if (nodes.some((n) => !n.layer || !n.layer.__parent)) {
      const arrays = screenLayerArrays(state.renderer.lastScreen);
      for (const n of nodes) {
        for (const arr of arrays) {
          const obj = n.layer || n.item;
          const i = arr.indexOf(obj);
          if (i >= 0) { arr.splice(i, 1); break; }
        }
      }
    }
    clearSelection();
    markDirty();
    renderPreview();
    toast('Deleted selection');
  }

  function copySelection() {
    const nodes = selectedNodes();
    if (!nodes.length) return;
    state.clipboard = nodes.map((n) => ({
      kind: n.layer ? 'layer' : 'item',
      data: JSON.parse(JSON.stringify(n.layer || n.item))
    }));
    toast('Copied ' + state.clipboard.length + ' item(s)');
  }

  function pasteSelection() {
    if (!state.clipboard || !state.clipboard.length) return;
    const screen = state.renderer.lastScreen;
    if (!screen) return;
    const targetItem = state.selected && state.selected.item;
    const layerContainer = targetItem
      ? (Array.isArray(targetItem.layers) ? targetItem.layers : (targetItem.layers = []))
      : (screen.background && Array.isArray(screen.background.layers) ? screen.background.layers : (screen.background = Object.assign({}, screen.background, { layers: [] })).layers);
    const items = currentItems(screen);
    history.push();
    const added = [];
    for (const entry of state.clipboard) {
      const obj = entry.data || entry;
      const kind = entry.kind || 'layer';
      const copy = JSON.parse(JSON.stringify(obj));
      if (copy.x != null) copy.x += 6;
      if (copy.y != null) copy.y += 6;
      if (kind === 'item') {
        items.push(copy);
        added.push({ layer: null, item: copy });
      } else {
        layerContainer.push(copy);
        added.push({ layer: copy, item: targetItem || null });
      }
    }
    setSelection(added, false);
    markDirty();
    renderPreview();
    toast('Pasted ' + added.length + ' item(s)');
  }

  function duplicateSelection() {
    const nodes = selectedNodes();
    if (!nodes.length) return;
    let added = null;
    history.push();
    for (const n of nodes) {
      const obj = n.layer || n.item;
      const arrays = screenLayerArrays(state.renderer.lastScreen);
      let parent = arrays.find((a) => a.indexOf(obj) >= 0);
      if (!parent) continue;
      const copy = JSON.parse(JSON.stringify(obj));
      if (copy.x != null) copy.x += 6;
      if (copy.y != null) copy.y += 6;
      parent.splice(parent.indexOf(obj) + 1, 0, copy);
      added = added || [];
      added.push({ layer: n.layer ? copy : null, item: n.item ? copy : null });
    }
    if (added) {
      setSelection(added, false);
      markDirty();
      renderPreview();
      toast('Duplicated selection');
    } else {
      history.undoStack.pop();
      updateHistoryButtons();
    }
  }

  function reorderSelection(dir) {
    const nodes = selectedNodes();
    if (!nodes.length) return;
    let changed = false;
    history.push();
    for (const n of nodes) {
      const obj = n.layer || n.item;
      const arrays = screenLayerArrays(state.renderer.lastScreen);
      for (const arr of arrays) {
        const i = arr.indexOf(obj);
        if (i >= 0) {
          const j = i + dir;
          if (j >= 0 && j < arr.length) {
            arr[i] = arr[j];
            arr[j] = obj;
            changed = true;
          }
          break;
        }
      }
    }
    if (changed) { markDirty(); renderPreview(); }
    else { history.undoStack.pop(); updateHistoryButtons(); }
  }

  // ---- dock tabs / context menu -------------------------------------------
  function setDockTab(tab) {
    state.dockTab = tab;
    document.querySelectorAll('.dock-tab').forEach((b) => b.classList.toggle('active', b.dataset.dock === tab));
    document.querySelectorAll('.dock-pane').forEach((p) => p.classList.toggle('active', p.dataset.dockPane === tab));
  }

  let contextCleanup = null;
  function showContextMenu(x, y, items) {
    const menu = $('contextMenu');
    if (!menu) return;
    menu.innerHTML = '';
    for (const it of items || []) {
      if (it.sep) { menu.appendChild(mk('div', 'ctx-sep')); continue; }
      const b = mk('button', '', it.label);
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', () => {
        hideContextMenu();
        it.action && it.action();
      });
      menu.appendChild(b);
    }
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
    const hide = (e) => {
      if (menu.contains(e.target)) return;
      hideContextMenu();
    };
    contextCleanup = hide;
    setTimeout(() => document.addEventListener('mousedown', hide), 0);
  }

  function hideContextMenu() {
    const menu = $('contextMenu');
    if (menu) menu.classList.add('hidden');
    if (contextCleanup) document.removeEventListener('mousedown', contextCleanup);
    contextCleanup = null;
  }

  // ---- image lab -----------------------------------------------------------
  function initImageLab() {
    if (!window.ImageLab || !$('labCanvas')) return;
    state.imageLab = new ImageLab({
      model: state.model,
      renderer: state.renderer,
      toast,
      onApply: (path, base64, w, h) => {
        history.push();
        invalidateAsset(path);
        state.model.setFile(path, base64, true);
        assetDims.delete(path);
        state.selectedAsset = path;
        markDirty();
        renderAssets();
        renderPreview();
        runValidation();
        renderOverview();
        state.imageLab.refreshAssetList(path);
        toast('Applied image to ' + path + ' (' + w + '×' + h + ')');
      },
      onSavePng: async (base64, name) => {
        const saved = await saveBase64File(base64, name, [{ name: 'PNG image', extensions: ['png'] }]);
        if (saved) toast('Exported ' + saved);
      },
      onOpenAdvanced: openAdvancedEditor,
      askText
    });
    state.imageLab.bind();
    state.imageLab.refreshAssetList();
  }

  // ---- advanced editor -----------------------------------------------------
  let advancedCallback = null;
  let advancedReady = false;
  let advancedPending = null;

  function openAdvancedEditor(dataUrl, name, callback) {
    const overlay = $('advancedOverlay');
    const frame = $('advancedFrame');
    if (!overlay || !frame) return;
    advancedCallback = callback;
    advancedPending = { dataUrl, name };
    $('advancedName').textContent = name || '';
    overlay.classList.remove('hidden');
    if (!advancedReady) {
      frame.src = 'advanced-editor.html';
    } else {
      frame.contentWindow.postMessage({ type: 'load', dataUrl, name }, '*');
    }
  }

  function closeAdvancedEditor() {
    const overlay = $('advancedOverlay');
    if (overlay) overlay.classList.add('hidden');
    advancedCallback = null;
    advancedPending = null;
  }

  function initAdvancedEditor() {
    const frame = $('advancedFrame');
    if (!frame) return;
    window.addEventListener('message', (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'ready') {
        advancedReady = true;
        if (advancedPending) frame.contentWindow.postMessage({ type: 'load', dataUrl: advancedPending.dataUrl, name: advancedPending.name }, '*');
      } else if (e.data.type === 'result') {
        const cb = advancedCallback;
        closeAdvancedEditor();
        if (cb && e.data.dataUrl) cb(e.data.dataUrl);
      } else if (e.data.type === 'error') {
        toast('Advanced editor: ' + (e.data.message || 'export failed'), true);
      }
    });
    $('advancedClose').addEventListener('click', closeAdvancedEditor);
    $('advancedSave').addEventListener('click', () => {
      frame.contentWindow.postMessage({ type: 'export' }, '*');
    });
  }

  // ---- overview ------------------------------------------------------------
  function renderOverview() {
    if (state.currentTab !== 'design') return;
    const files = state.model.listAllFiles();
    const comps = state.model.listComponents();
    const assets = state.model.listAssets();
    const palette = state.model.getPalette();
    const results = state.validation || { errors: [], warnings: [], info: [] };
    let bytes = 0;
    for (const p of files) {
      const b = state.model.getBase64(p);
      if (b) bytes += Math.round(b.length * 3 / 4);
    }

    const stats = $('overviewStats');
    if (stats) {
      stats.innerHTML = '';
      const items = [
        ['Components', comps.length],
        ['Assets', assets.length],
        ['Colors', Object.keys(palette).length],
        ['Files', files.length],
        ['Package', formatBytes(bytes)],
        ['Theme', state.model.meta.version || '—']
      ];
      for (const [label, value] of items) {
        const d = mk('div', 'stat');
        d.appendChild(mk('div', 'v', String(value)));
        d.appendChild(mk('div', 'l', label));
        stats.appendChild(d);
      }
    }

    const health = $('healthList');
    if (health) {
      health.innerHTML = '';
      const checks = [
        ['theme.json present', state.model.has('theme.json'), 'err'],
        ['Palette loaded', Object.keys(palette).length > 0, 'err'],
        ['Boot animation', comps.some((p) => /boot_animation\.json$/.test(p)), 'warn'],
        ['Spinner', comps.some((p) => /spinner\.json$/.test(p)), 'warn'],
        ['Dashboard target', !!(state.model.getThemeJson()?.generic_menus?.dashboard_path), 'warn'],
        ['Status bars', Object.keys(state.model.getThemeJson()?.status_bars || {}).length > 0, 'warn'],
        ['No validation errors', results.errors.length === 0, 'err'],
        ['No validation warnings', results.warnings.length === 0, 'warn']
      ];
      for (const [label, ok, severity] of checks) {
        const d = mk('div', 'health-row ' + (ok ? 'ok' : severity));
        d.appendChild(mk('span', 'dot'));
        d.appendChild(mk('span', '', label));
        health.appendChild(d);
      }
      if ($('healthBadge')) {
        $('healthBadge').textContent = results.errors.length ? 'Needs work' : (results.warnings.length ? 'Review' : 'Healthy');
        $('healthBadge').className = 'pill ' + (results.errors.length ? 'danger' : (results.warnings.length ? 'warn' : ''));
      }
    }

    const compat = $('compatList');
    if (compat) {
      compat.innerHTML = '';
      const rawAll = comps.map((p) => state.model.getComponentRaw(p) || '').join('\n');
      const themeRaw = state.model.getThemeJsonRaw() || '';
      const structural = [
        ['theme_version 2.0.0', String((state.model.getThemeJson() || {}).theme_version || '') === '2.0.0'],
        ['theme_framework_version 0.9', String((state.model.getThemeJson() || {}).theme_framework_version || '') === '0.9'],
        ['status_bars map', Object.keys((state.model.getThemeJson() || {}).status_bars || {}).length > 0],
        ['generic_menus map', Object.keys((state.model.getThemeJson() || {}).generic_menus || {}).length > 0],
        ['template maps', !!(state.model.getThemeJson() || {}).string_templates || !!(state.model.getThemeJson() || {}).toggle_templates]
      ];
      for (const [label, ok] of structural) {
        const d = mk('div', 'health-row ' + (ok ? 'ok' : 'warn'));
        d.appendChild(mk('span', 'dot'));
        d.appendChild(mk('span', '', label));
        compat.appendChild(d);
      }
      const features = [
        ['recolor_rgb', rawAll.includes('"recolor_rgb"')],
        ['text_color alias', rawAll.includes('"text_color"')],
        ['radio_template', rawAll.includes('"radio_template"')],
        ['save_cancel_menu', rawAll.includes('"save_cancel_menu"')],
        ['bt_status_bar', rawAll.includes('"bt_status_bar"')],
        ['failsafe picker', themeRaw.includes('failsafe_duckyscript_list_picker')],
        ['theme_name', themeRaw.includes('"theme_name"') || themeRaw.includes('"name"')]
      ].filter((f) => f[1]).map((f) => f[0]);
      if (features.length) {
        const d = mk('div', 'health-row ok');
        d.appendChild(mk('span', 'dot'));
        d.appendChild(mk('span', '', 'Uses: ' + features.join(', ')));
        compat.appendChild(d);
      } else {
        compat.appendChild(mk('div', 'muted', 'No optional 2.0.0 fields detected yet.'));
      }
      const required = structural.every((c) => c[1]);
      if ($('compatBadge')) {
        $('compatBadge').textContent = required ? '2.0.0-ready' : 'Review structure';
        $('compatBadge').className = 'pill ' + (required ? '' : 'warn');
      }
    }

    const pal = $('overviewPalette');
    if (pal) {
      pal.innerHTML = '';
      for (const name of Object.keys(palette)) {
        const d = mk('div', 'mini-swatch');
        d.style.background = Palette.toCss(palette[name]);
        d.title = name + ' · ' + Palette.toHex(palette[name]);
        d.addEventListener('click', () => setTab('colors'));
        pal.appendChild(d);
      }
    }

    const map = $('screenMap');
    if (map) {
      map.innerHTML = '';
      const filter = ($('screenMapFilter') ? $('screenMapFilter').value : '').toLowerCase();
      const tj = state.model.getThemeJson() || {};
      const groups = [];
      const gm = Object.entries(tj.generic_menus || {});
      if (gm.length) groups.push({ name: 'Dashboards & menus', items: gm });
      const sb = Object.entries(tj.status_bars || {});
      if (sb.length) groups.push({ name: 'Status bars', items: sb });
      for (const [key, label] of [['toggle_templates', 'Toggles'], ['string_templates', 'Text templates'], ['radio_templates', 'Radios'], ['signal_templates', 'Signals']]) {
        const e = Object.entries(tj[key] || {});
        if (e.length) groups.push({ name: label, items: e });
      }
      const dialogs = Object.entries(tj.option_dialogs || {});
      if (dialogs.length) groups.push({ name: 'Option dialogs', items: dialogs });
      const reconLists = Object.entries(tj.recon_lists || {});
      if (reconLists.length) groups.push({ name: 'Recon lists', items: reconLists });
      const core = ThemeTemplates.PATH_KEYS.filter((k) => tj[k]).map((k) => [k, tj[k]]);
      if (core.length) groups.push({ name: 'Surfaces', items: core });
      for (const g of groups) {
        const items = g.items.filter(([k, v]) => !filter || k.toLowerCase().includes(filter) || String(v).toLowerCase().includes(filter));
        if (!items.length) continue;
        const box = mk('div', 'screen-map-group');
        box.appendChild(mk('h4', '', g.name));
        for (const [k, v] of items) {
          const link = mk('div', 'screen-link');
          link.appendChild(mk('span', '', k));
          if (state.model.has(v) && v.startsWith('components/')) {
            link.appendChild(mk('span', 't', ThemeTemplates.typeMeta(state.model.getComponent(v)).icon));
          } else if (state.model.has(v) && v.startsWith('assets/')) {
            link.appendChild(mk('span', 't', '🖼'));
          }
          link.title = v;
          link.addEventListener('click', () => {
            if (v.startsWith('components/') && state.model.has(v)) {
              state.preview.componentPath = v;
              state.preview.variantIndex = 0;
              state.preview.selectedIndex = 0;
              state.preview.pageIndex = 0;
              state.preview.frameIndex = 0;
              populatePreviewComponentSelect();
              renderPreview();
              setTab('components');
              selectComponent(v);
            } else if (v.startsWith('assets/') && state.model.has(v)) {
              setTab('assets');
              $('assetFilter').value = v;
              renderAssets();
              selectAsset(v);
            } else {
              toast('Missing target: ' + v, true);
            }
          });
          box.appendChild(link);
        }
        map.appendChild(box);
      }
      if (!map.children.length) map.appendChild(mk('div', 'muted', 'No screens match this filter.'));
    }
  }

  // ---- simulator -----------------------------------------------------------
  async function renderSimulatorPreview() {
    if (!state.simRenderer) return;
    const path = state.preview.componentPath;
    if (!path) {
      const cv = $('simCanvas');
      if (cv) {
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cv.width, cv.height);
      }
      state.simRenderer.lastScreen = null;
      state.simRenderer.hitRegions = [];
      return;
    }
    state.simRenderer.setVariables(state.variables);
    state.simRenderer.setStatusStates(state.preview.statusStates);
    await state.simRenderer.render(path, {
      variantIndex: state.preview.variantIndex,
      selectedIndex: state.preview.selectedIndex,
      pageIndex: state.preview.pageIndex,
      frameIndex: state.preview.frameIndex,
      hidden: state.hidden,
      statusStates: state.preview.statusStates
    });
  }

  function renderSimulatorUI() {
    if (!state.simRenderer) return;
    const screen = state.simRenderer.lastScreen;
    const comp = state.model.getComponent(state.preview.componentPath);
    if ($('simScreenName')) {
      const name = screen && screen.screen_name ? screen.screen_name : (state.preview.componentPath || '—');
      $('simScreenName').textContent = name;
    }
    if ($('simStackInfo')) $('simStackInfo').textContent = state.backStack.length + ' back';
    if ($('simButtonMap')) {
      const items = currentItems(screen);
      const activeItem = items[state.preview.selectedIndex] || {};
      $('simButtonMap').textContent = JSON.stringify(
        Object.assign({}, (screen && screen.button_map) || {}, activeItem.button_map || {}), null, 2);
    }
    if ($('simHistory')) {
      $('simHistory').innerHTML = '';
      const historyList = state.backStack.slice().reverse();
      if (!historyList.length) $('simHistory').appendChild(mk('div', 'muted', 'No history yet.'));
      for (const h of historyList) {
        const item = mk('div', 'item', h.componentPath || '—');
        item.addEventListener('click', () => {
          state.preview.componentPath = h.componentPath;
          state.preview.variantIndex = h.variantIndex;
          state.preview.pageIndex = h.pageIndex;
          state.preview.selectedIndex = h.selectedIndex;
          state.preview.frameIndex = h.frameIndex;
          populatePreviewComponentSelect();
          renderPreview();
        });
        $('simHistory').appendChild(item);
      }
    }
    const statusBox = $('simStatusStates');
    if (statusBox) {
      statusBox.innerHTML = '';
      const tj = state.model.getThemeJson() || {};
      const sbPath = screen && state.simRenderer.statusBarPath(screen);
      const sbComp = sbPath ? state.model.getComponent(sbPath) : null;
      const options = sbComp ? state.simRenderer.statusBarOptions(sbComp) : [];
      if (!options.length) {
        statusBox.textContent = 'This screen has no status bar states.';
      } else {
        for (const o of options) {
          const row = mk('div', 'variable-row');
          row.appendChild(mk('label', '', o.name));
          const sel = document.createElement('select');
          for (const s of o.states) opt(sel, s, s);
          sel.value = state.preview.statusStates[o.name] || o.selected;
          sel.addEventListener('change', () => {
            state.preview.statusStates[o.name] = sel.value;
            renderPreview();
          });
          row.appendChild(sel);
          statusBox.appendChild(row);
        }
      }
    }
    const vars = $('simVariables');
    if (vars) {
      vars.innerHTML = '';
      const names = new Set();
      if (comp && !comp.__parseError) collectVariableNames(comp, names);
      const sorted = Array.from(names).sort();
      if (!sorted.length) vars.textContent = 'No variables on this screen.';
      for (const name of sorted) {
        const row = mk('div', 'variable-row');
        row.appendChild(mk('label', '', name));
        const input = document.createElement('input');
        input.type = 'text';
        input.value = state.variables[name] || '';
        input.placeholder = state.renderer.sampleValue(name);
        input.addEventListener('input', () => {
          if (input.value === '') delete state.variables[name]; else state.variables[name] = input.value;
          state.renderer.setVariables(state.variables);
          renderPreview();
        });
        row.appendChild(input);
        vars.appendChild(row);
      }
    }
    if ($('simModeLabel')) $('simModeLabel').textContent = state.preview.componentPath ? 'button map active' : 'load a screen';
  }

  async function renderSimulator() {
    if (!state.simRenderer) return;
    if (!state.preview.componentPath) {
      const comps = state.model.listComponents();
      if (comps.length) state.preview.componentPath = comps[0];
    }
    populatePreviewComponentSelect();
    await renderSimulatorPreview();
    renderSimulatorUI();
  }

  function bindSimulator() {
    if (!$('simCanvas')) return;
    state.simRenderer = new PreviewRenderer($('simCanvas'));
    state.simRenderer.setModel(state.model);
    $('simComponent').addEventListener('change', () => {
      state.preview.componentPath = $('simComponent').value;
      state.preview.variantIndex = 0;
      state.preview.selectedIndex = 0;
      state.preview.pageIndex = 0;
      state.preview.frameIndex = 0;
      populatePreviewComponentSelect();
      renderPreview();
      renderSimulator();
    });
    $('simHome').addEventListener('click', () => {
      const tj = state.model.getThemeJson() || {};
      const home = (tj.generic_menus && tj.generic_menus.dashboard_path) || state.model.listComponents()[0];
      if (home) jumpToComponent(home);
    });
    document.querySelectorAll('[data-sim]').forEach((b) => {
      b.addEventListener('click', () => simButton(b.dataset.sim));
    });
    document.querySelectorAll('[data-dock-sim]').forEach((b) => {
      b.addEventListener('click', () => simButton(b.dataset.dockSim));
    });
    $('simClearVars').addEventListener('click', () => {
      state.variables = {};
      state.renderer.setVariables(state.variables);
      renderPreview();
      renderSimulatorUI();
    });
  }

  // ---- library -------------------------------------------------------------
  function loadRecent() {
    try {
      state.library.recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    } catch (e) { state.library.recent = []; }
  }

  function addRecent(name, path) {
    if (!path) return;
    state.library.recent = state.library.recent.filter((r) => r.path !== path);
    state.library.recent.unshift({ name: name || path.split('/').pop(), path, at: Date.now() });
    state.library.recent = state.library.recent.slice(0, 12);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(state.library.recent)); } catch (e) { /* ignore */ }
    renderLibrary();
  }

  async function pickThemeRepo() {
    if (!hasElectron || !window.api.pickThemeRepo) { toast('Theme library requires the Electron app', true); return; }
    const res = await window.api.pickThemeRepo();
    if (!res) return;
    state.library.path = res.folderPath;
    state.library.themes = res.themes || [];
    try { localStorage.setItem(REPO_KEY, res.folderPath); } catch (e) { /* ignore */ }
    renderLibrary();
    toast('Found ' + state.library.themes.length + ' theme(s)');
  }

  async function refreshThemeRepo() {
    if (!state.library.path || !hasElectron || !window.api.scanThemeRepo) {
      return pickThemeRepo();
    }
    const res = await window.api.scanThemeRepo(state.library.path);
    if (res) {
      state.library.themes = res.themes || [];
      try { localStorage.setItem(REPO_KEY, state.library.path); } catch (e) { /* ignore */ }
      renderLibrary();
      toast('Refreshed ' + state.library.themes.length + ' theme(s)');
    }
  }

  async function openThemeAtPath(path) {
    if (!hasElectron) { toast('Opening a theme path requires the Electron app', true); return false; }
    if (!confirmDiscard()) return false;
    try {
      const tree = await window.api.readTree(path);
      if (!tree) { toast('Could not read ' + path, true); return false; }
      state.model.setFilesFromTree(tree);
      state.openedFolder = path;
      applyLoaded();
      addRecent(tree.name, path);
      toast('Opened ' + tree.name);
      return true;
    } catch (e) {
      toast('Could not open theme: ' + e.message, true);
      return false;
    }
  }

  function renderLibrary() {
    const pathEl = $('libraryPath');
    if (pathEl) pathEl.textContent = state.library.path ? 'Repository: ' + state.library.path : 'No repository selected.';
    const grid = $('libraryGrid');
    if (grid) {
      grid.innerHTML = '';
      const filter = ($('libraryFilter') ? $('libraryFilter').value : '').toLowerCase();
      const themes = (state.library.themes || []).filter((t) =>
        !filter || (t.name || '').toLowerCase().includes(filter) || (t.title || '').toLowerCase().includes(filter) || (t.path || '').toLowerCase().includes(filter));
      if (!themes.length) {
        grid.appendChild(mk('div', 'muted', state.library.path ? 'No themes match this filter.' : 'Choose “Open themes repo…” to scan a local clone of wifipineapplepager-themes.'));
      }
      for (const t of themes) {
        const card = mk('div', 'library-card');
        card.appendChild(mk('h4', '', t.title || t.name || t.path));
        const meta = mk('div', 'meta');
        meta.appendChild(mk('span', 'pill', 'v' + (t.version || '—')));
        meta.appendChild(mk('span', 'pill', 'fw ' + (t.framework || '—')));
        meta.appendChild(mk('span', 'pill', (t.components || 0) + ' comps'));
        meta.appendChild(mk('span', 'pill', (t.assets || 0) + ' assets'));
        if (t.bytes) meta.appendChild(mk('span', 'pill', formatBytes(t.bytes)));
        card.appendChild(meta);
        if (t.author) card.appendChild(mk('div', 'muted', 'by ' + t.author));
        const sw = mk('div', 'swatches');
        for (const c of (t.swatches || []).slice(0, 12)) {
          const i = document.createElement('i');
          i.style.background = c;
          sw.appendChild(i);
        }
        card.appendChild(sw);
        card.appendChild(mk('div', 'path', t.path || ''));
        const actions = mk('div', 'actions');
        const open = mk('button', 'mini', 'Open');
        open.addEventListener('click', () => openThemeAtPath(t.path));
        const clone = mk('button', 'mini', 'Clone');
        clone.addEventListener('click', async () => {
          const ok = await openThemeAtPath(t.path);
          if (ok) duplicateTheme();
        });
        actions.appendChild(open);
        actions.appendChild(clone);
        card.appendChild(actions);
        grid.appendChild(card);
      }
    }
    const recent = $('recentList');
    if (recent) {
      recent.innerHTML = '';
      if (!state.library.recent.length) recent.appendChild(mk('div', 'muted', 'No recent themes.'));
      for (const r of state.library.recent) {
        const item = mk('div', 'item', r.name || r.path);
        item.title = r.path;
        item.addEventListener('click', () => openThemeAtPath(r.path));
        item.appendChild(mk('span', 'x', '↗'));
        recent.appendChild(item);
      }
    }
  }

  async function restoreLibraryRepo() {
    if (!hasElectron || !window.api.scanThemeRepo) return;
    let saved = null;
    try { saved = localStorage.getItem(REPO_KEY); } catch (e) { /* ignore */ }
    if (!saved) return;
    try {
      const res = await window.api.scanThemeRepo(saved);
      if (res) {
        state.library.path = res.folderPath;
        state.library.themes = res.themes || [];
        renderLibrary();
      }
    } catch (e) { /* repo may have moved */ }
  }

  function bindLibrary() {
    loadRecent();
    restoreLibraryRepo();
    $('btnPickRepo').addEventListener('click', pickThemeRepo);
    $('btnRefreshRepo').addEventListener('click', refreshThemeRepo);
    $('libraryFilter').addEventListener('input', renderLibrary);
    $('btnClearRecent').addEventListener('click', () => {
      state.library.recent = [];
      try { localStorage.removeItem(RECENT_KEY); } catch (e) { /* ignore */ }
      renderLibrary();
    });
    renderLibrary();
  }

  // ---- command palette / modal --------------------------------------------
  function openCommandPalette() {
    const overlay = $('commandOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    const input = $('commandInput');
    input.value = '';
    input.focus();
    state.commandItems = buildCommands();
    renderCommandResults('');
  }

  function closeCommandPalette() {
    const overlay = $('commandOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function buildCommands() {
    const cmds = [];
    const nav = [
      ['design', 'Overview'], ['components', 'Components'], ['colors', 'Palette'],
      ['assets', 'Assets'], ['imagelab', 'Image Lab'], ['themejson', 'Manifest'],
      ['metadata', 'Metadata'], ['simulator', 'Simulator'], ['library', 'Themes'], ['validation', 'Validate']
    ];
    for (const [tab, label] of nav) cmds.push({ group: 'Go', label: 'Go to ' + label, action: () => setTab(tab) });
    cmds.push(
      { group: 'Theme', label: 'New theme from reference', action: startNewTheme },
      { group: 'Theme', label: 'New blank theme', action: startBlankTheme },
      { group: 'Theme', label: 'Duplicate theme', action: duplicateTheme },
      { group: 'Theme', label: 'Open folder…', action: openFolder },
      { group: 'Theme', label: 'Open ZIP…', action: openZip },
      { group: 'Theme', label: 'Save', action: save },
      { group: 'Theme', label: 'Save as…', action: saveAs },
      { group: 'Theme', label: 'Export ZIP', action: exportZip },
      { group: 'Theme', label: 'Run validation', action: () => { setTab('validation'); runValidation(); } },
      { group: 'View', label: 'Focus preview', action: toggleFocusPreview },
      { group: 'View', label: 'Fit preview', action: () => setZoom('fit') },
      { group: 'View', label: 'Preview 100%', action: () => setZoom('fixed', 1) },
      { group: 'View', label: 'Preview 200%', action: () => setZoom('fixed', 2) },
      { group: 'Create', label: 'Component template gallery', action: openTemplateGallery },
      { group: 'Create', label: 'Apply palette preset', action: openPalettePresets },
      { group: 'Create', label: 'Import assets', action: importAssets }
    );
    for (const p of state.model.listComponents()) {
      cmds.push({ group: 'Component', label: p, sub: 'open', action: () => { setTab('components'); selectComponent(p); } });
      cmds.push({ group: 'Component', label: 'Preview ' + p, sub: 'preview', action: () => { state.preview.componentPath = p; state.preview.variantIndex = 0; populatePreviewComponentSelect(); renderPreview(); } });
    }
    for (const p of state.model.listAssets()) {
      cmds.push({ group: 'Asset', label: p, sub: 'open', action: () => { setTab('assets'); $('assetFilter').value = p; renderAssets(); selectAsset(p); } });
      cmds.push({ group: 'Asset', label: 'Edit image ' + p, sub: 'Image Lab', action: () => openAssetInImageLab(p) });
    }
    for (const n of Object.keys(state.model.getPalette())) {
      cmds.push({ group: 'Color', label: n, sub: Palette.toHex(state.model.getPalette()[n]), action: () => { setTab('colors'); state.paletteFilter = n; if ($('paletteFilter')) $('paletteFilter').value = n; renderColors(); } });
    }
    return cmds;
  }

  function renderCommandResults(query) {
    const box = $('commandResults');
    if (!box) return;
    const q = (query || '').toLowerCase().trim();
    const items = (state.commandItems || []).filter((c) =>
      !q || c.label.toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q) || (c.sub || '').toLowerCase().includes(q));
    state.commandFiltered = items.slice(0, 120);
    state.commandIndex = 0;
    box.innerHTML = '';
    if (!state.commandFiltered.length) {
      box.appendChild(mk('div', 'muted', 'No matches.'));
      return;
    }
    state.commandFiltered.forEach((c, i) => {
      const d = mk('div', 'command-item' + (i === 0 ? ' active' : ''));
      d.appendChild(mk('span', 'g', c.group === 'Component' ? '▤' : (c.group === 'Asset' ? '🖼' : (c.group === 'Color' ? '◐' : '❯'))));
      d.appendChild(mk('span', '', c.label));
      if (c.sub) d.appendChild(mk('span', 'sub', c.sub));
      d.addEventListener('click', () => { closeCommandPalette(); c.action(); });
      box.appendChild(d);
    });
  }

  function bindCommandPalette() {
    const overlay = $('commandOverlay');
    const input = $('commandInput');
    if (!overlay || !input) return;
    input.addEventListener('input', () => renderCommandResults(input.value));
    input.addEventListener('keydown', (e) => {
      const items = state.commandFiltered || [];
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        state.commandIndex = Math.min(items.length - 1, (state.commandIndex || 0) + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        state.commandIndex = Math.max(0, (state.commandIndex || 0) - 1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const c = items[state.commandIndex || 0];
        if (c) { closeCommandPalette(); c.action(); }
        return;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeCommandPalette();
        return;
      } else {
        return;
      }
      const box = $('commandResults');
      Array.from(box.children).forEach((el, i) => el.classList.toggle('active', i === state.commandIndex));
      const active = box.children[state.commandIndex];
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) closeCommandPalette();
    });
    $('btnCommand').addEventListener('click', openCommandPalette);
  }

  function openModal({ title, body, actions }) {
    const overlay = $('modalRoot');
    if (!overlay) return;
    $('modalTitle').textContent = title || '';
    const bodyEl = $('modalBody');
    bodyEl.innerHTML = '';
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);
    const actionsEl = $('modalActions');
    actionsEl.innerHTML = '';
    for (const a of actions || []) {
      const b = mk('button', a.primary ? 'primary-soft' : '', a.label);
      b.addEventListener('click', a.action);
      actionsEl.appendChild(b);
    }
    overlay.classList.remove('hidden');
  }

  function closeModal(value) {
    const overlay = $('modalRoot');
    if (overlay) overlay.classList.add('hidden');
    if (state.modalResolve) {
      const resolve = state.modalResolve;
      state.modalResolve = null;
      resolve(value == null ? null : value);
    }
  }

  // Text-entry dialog used in place of Electron's unsupported window.prompt().
  function askText({ title, label, value, placeholder, multiline }) {
    if (window.prompt !== nativePrompt) {
      const res = window.prompt(label || title || '', value || '');
      return Promise.resolve(res);
    }
    return new Promise((resolve) => {
      const wrap = mk('div', 'ask-wrap');
      wrap.appendChild(mk('label', 'ask-label', label || title || 'Value'));
      const input = document.createElement(multiline ? 'textarea' : 'input');
      if (!multiline) input.type = 'text';
      input.value = value || '';
      input.placeholder = placeholder || '';
      input.spellcheck = false;
      input.className = 'ask-input';
      if (multiline) input.rows = 8;
      wrap.appendChild(input);
      state.modalResolve = resolve;
      openModal({
        title: title || 'Enter value',
        body: wrap,
        actions: [
          modalButton('Cancel', () => closeModal(null), false),
          modalButton('OK', () => closeModal(input.value), true)
        ]
      });
      setTimeout(() => {
        input.focus();
        if (input.select) input.select();
      }, 20);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); closeModal(input.value); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeModal(input.value); }
      });
    });
  }

  function modalButton(label, action, primary) {
    return { label, action, primary };
  }

  function bindModal() {
    const overlay = $('modalRoot');
    if (!overlay) return;
    $('modalClose').addEventListener('click', closeModal);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  }

  function openPalettePresets() {
    const grid = mk('div', 'template-grid');
    for (const p of ThemeTemplates.PRESETS) {
      const card = mk('div', 'template-card');
      card.appendChild(mk('h4', '', p.name));
      card.appendChild(mk('p', '', p.description));
      const sw = mk('div', 'swatches');
      const colors = p.colors ? Object.values(p.colors) : Object.values(Palette.DEFAULT).map((c) => Palette.toCss(c));
      for (const c of colors.slice(0, 12)) {
        const i = mk('i');
        i.style.background = typeof c === 'string' ? c : Palette.toCss(c);
        i.style.height = '12px';
        sw.appendChild(i);
      }
      card.appendChild(sw);
      card.addEventListener('click', () => {
        closeModal();
        applyPalettePreset(p);
      });
      grid.appendChild(card);
    }
    openModal({ title: 'Palette presets', body: grid, actions: [modalButton('Close', closeModal, false)] });
  }

  function applyPalettePreset(preset) {
    history.push();
    const palette = {};
    if (preset.colors) {
      for (const [k, v] of Object.entries(preset.colors)) palette[k] = Palette.fromHex(v);
    } else {
      Object.assign(palette, Palette.DEFAULT);
    }
    state.model.setPalette(palette);
    markDirty();
    renderColors();
    renderPaletteTools();
    renderPreview();
    if (state.imageLab) state.imageLab.render();
    toast('Applied ' + preset.name + ' palette');
  }

  // ---- validation UI filters, metadata etc. --------------------------------
  function bindValidation() {
    $('btnRunValidation').addEventListener('click', runValidation);
    if ($('validationFilter')) $('validationFilter').addEventListener('change', () => renderValidation(state.validation));
  }

  // ---- keyboard shortcuts --------------------------------------------------
  function bindKeyboardNudge() {
    document.addEventListener('keydown', (e) => {
      if (!$('editMode') || !$('editMode').checked) return;
      if (isTyping(e)) return;
      const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!map[e.key]) return;
      const nodes = selectedNodes();
      if (!nodes.length) return;
      e.preventDefault();
      history.push();
      const step = e.shiftKey ? 10 : 1;
      const [dx, dy] = map[e.key];
      for (const n of nodes) {
        if (n.layer) {
          n.layer.x = (n.layer.x || 0) + dx * step;
          n.layer.y = (n.layer.y || 0) + dy * step;
        } else if (n.item) {
          n.item.x = (n.item.x || 0) + dx * step;
          n.item.y = (n.item.y || 0) + dy * step;
        }
      }
      markDirty();
      requestPreviewRender();
    });
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = (e.key || '').toLowerCase();
      if (mod && key === 'k') { e.preventDefault(); openCommandPalette(); return; }
      if (key === 'escape') {
        hideContextMenu();
        if (!$('commandOverlay').classList.contains('hidden')) { closeCommandPalette(); return; }
        if (!$('modalRoot').classList.contains('hidden')) { closeModal(); return; }
        if (!$('advancedOverlay').classList.contains('hidden')) { closeAdvancedEditor(); return; }
        if (document.body.classList.contains('focus-preview')) { toggleFocusPreview(); return; }
        if (state.selection.length) { clearSelection(); renderLayers(); renderProperties(); drawSelectionOutline(); }
        return;
      }
      if (isTyping(e)) {
        if (mod && key === 's') { e.preventDefault(); if (e.shiftKey) saveAs(); else save(); }
        if (mod && key === 'e') { e.preventDefault(); exportZip(); }
        return;
      }
      // space panning
      if (e.code === 'Space') {
        state.spaceDown = true;
        document.body.style.cursor = 'grab';
      }
      if (mod && key === 's') { e.preventDefault(); if (e.shiftKey) saveAs(); else save(); return; }
      if (mod && key === 'e') { e.preventDefault(); exportZip(); return; }
      if (mod && key === 'o') { e.preventDefault(); openFolder(); return; }
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
      if ((mod && key === 'z' && e.shiftKey) || (mod && key === 'y')) { e.preventDefault(); history.redo(); return; }
      if (mod && key === 'c') { e.preventDefault(); copySelection(); return; }
      if (mod && key === 'v') { e.preventDefault(); pasteSelection(); return; }
      if (mod && key === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodes().length) { e.preventDefault(); deleteSelection(); }
        return;
      }
      if (key === '0') { e.preventDefault(); setZoom('fit'); return; }
      if (key === '1') { e.preventDefault(); setZoom('fixed', 1); return; }
      if (key === '2') { e.preventDefault(); setZoom('fixed', 2); return; }
      if (key === 'f') { e.preventDefault(); toggleFocusPreview(); return; }
      if (key === '+' || key === '=') { e.preventDefault(); zoomBy(1.2); return; }
      if (key === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        state.spaceDown = false;
        if (document.body.style.cursor === 'grab') document.body.style.cursor = '';
      }
    });
  }

  // ---- preview controls ----------------------------------------------------
  function bindPreviewControls() {
    $('previewComponent').addEventListener('change', () => {
      state.preview.componentPath = $('previewComponent').value;
      state.preview.variantIndex = 0;
      state.preview.selectedIndex = 0;
      state.preview.pageIndex = 0;
      state.preview.frameIndex = 0;
      clearSelection();
      populatePreviewComponentSelect();
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
      if (value === 'fit') setZoom('fit');
      else setZoom('fixed', parseFloat(value) || 2);
    });
    $('zoomRange').addEventListener('input', () => {
      setZoom('fixed', parseFloat($('zoomRange').value) || 1);
    });
    $('btnZoomIn').addEventListener('click', () => zoomBy(1.2));
    $('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
    $('btnPreviewFit').addEventListener('click', () => setZoom('fit'));
    $('btnPreview100').addEventListener('click', () => setZoom('fixed', 1));
    $('btnPreview2x').addEventListener('click', () => setZoom('fixed', 2));
    $('editMode').addEventListener('change', () => {
      if ($('editMode').checked) $('simulateMode').checked = false;
      clearSelection();
      $('previewCanvas').classList.toggle('editing', $('editMode').checked);
      $('previewCanvas').classList.toggle('simulating', $('simulateMode').checked);
      // Pixel editing needs a crisp scale. If the dock is fitted smaller than
      // 100%, jump to 1:1 so drags and nudges land on exact source pixels.
      // On a phone 1:1 would hide most of the 480px-wide canvas behind a
      // scrollbar, so the Android build stays fitted and snaps to 5px instead.
      const isPhoneLayout = document.body.classList.contains('pt-mobile');
      if (!isPhoneLayout && $('editMode').checked && state.preview.zoomMode === 'fit' && computeFitZoom() < 1) {
        setZoom('fixed', 1);
      }
      renderPreview();
    });
    $('simulateMode').addEventListener('change', () => {
      if ($('simulateMode').checked) $('editMode').checked = false;
      $('previewCanvas').classList.toggle('editing', $('editMode').checked);
      $('previewCanvas').classList.toggle('simulating', $('simulateMode').checked);
      renderPreview();
    });
    $('showGrid').addEventListener('change', () => renderPreview());
    $('btnSimBack').addEventListener('click', popBack);
    $('btnAddLayer').addEventListener('click', () => addLayer(state.model.listAssets().length ? 'image' : 'text'));
    $('btnAddTextLayer').addEventListener('click', () => addLayer('text'));
    $('btnAddImageLayer').addEventListener('click', () => addLayer('image'));
    $('btnDuplicateLayer').addEventListener('click', () => {
      const nodes = selectedNodes();
      for (const n of nodes) {
        const obj = n.layer || n.item;
        const parent = findParentArr(obj);
        if (!parent) continue;
        duplicateLayerNode({ layer: n.layer, item: n.item, parent, index: parent.indexOf(obj) });
      }
    });
    $('btnPropsAdvanced').addEventListener('click', () => {
      if (!state.preview.componentPath) return;
      setTab('components');
      selectComponent(state.preview.componentPath);
      setComponentMode('json');
    });
    if ($('btnPlayFrames')) {
      $('btnPlayFrames').addEventListener('click', playFrames);
    }
    if ($('layerFilter')) $('layerFilter').addEventListener('input', () => { lastLayerSig = null; renderLayers(); });
    document.querySelectorAll('.dock-tab').forEach((b) => {
      b.addEventListener('click', () => setDockTab(b.dataset.dock));
    });
  }

  function findParentArr(obj) {
    for (const arr of screenLayerArrays(state.renderer.lastScreen)) {
      if (arr.includes(obj)) return arr;
    }
    return null;
  }

  let frameTimer = null;
  function playFrames() {
    if (state.preview.playing) {
      state.preview.playing = false;
      clearInterval(frameTimer);
      if ($('btnPlayFrames')) $('btnPlayFrames').textContent = '▶';
      return;
    }
    const screen = state.renderer.lastScreen;
    const frames = screen && screen.animation && screen.animation.frames;
    if (!frames || frames.length < 2) return;
    state.preview.playing = true;
    if ($('btnPlayFrames')) $('btnPlayFrames').textContent = '⏸';
    frameTimer = setInterval(() => {
      if (!state.preview.playing) return;
      state.preview.frameIndex = (state.preview.frameIndex + 1) % frames.length;
      if ($('previewFrame')) $('previewFrame').value = state.preview.frameIndex;
      renderPreview();
    }, 120);
  }

  // ---- overview bindings ---------------------------------------------------
  function bindOverview() {
    if ($('screenMapFilter')) $('screenMapFilter').addEventListener('input', renderOverview);
    $('btnOverviewSimulate').addEventListener('click', () => setTab('simulator'));
    $('btnOverviewExport').addEventListener('click', exportZip);
    $('btnOverviewPalette').addEventListener('click', () => setTab('colors'));
    document.querySelectorAll('[data-quick]').forEach((b) => {
      b.addEventListener('click', () => {
        const q = b.dataset.quick;
        if (q === 'new-component') { setTab('components'); createComponent(); }
        else if (q === 'templates') openTemplateGallery();
        else if (q === 'palette-preset') openPalettePresets();
        else if (q === 'import-assets') { setTab('assets'); importAssets(); }
        else if (q === 'image-lab') setTab('imagelab');
        else if (q === 'simulate') setTab('simulator');
        else if (q === 'focus-preview') toggleFocusPreview();
        else if (q === 'validate') { setTab('validation'); runValidation(); }
      });
    });
  }

  // ---- toolbar -------------------------------------------------------------
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
  }

  function bindNav() {
    document.querySelectorAll('.nav-item[data-tab]').forEach((b) => {
      b.addEventListener('click', () => setTab(b.dataset.tab));
    });
  }

  // ---- init ---------------------------------------------------------------
  async function init() {
    state.renderer = new PreviewRenderer($('previewCanvas'));
    state.renderer.setModel(state.model);
    applyZoom();

    initLayout();
    bindNav();
    bindToolbar();
    bindShortcuts();
    bindMetadata();
    bindColors();
    bindThemeJson();
    bindComponents();
    bindAssets();
    bindValidation();
    bindPreviewControls();
    bindPreviewInteraction();
    bindKeyboardNudge();
    bindSimulator();
    bindLibrary();
    bindCommandPalette();
    bindModal();
    bindOverview();
    initImageLab();
    initAdvancedEditor();
    updateHistoryButtons();
    setDockTab('layers');
    setComponentMode('form');
    setTab('design');

    if (typeof ResizeObserver !== 'undefined') {
      let fitScheduled = false;
      const ro = new ResizeObserver(() => {
        if (fitScheduled) return;
        fitScheduled = true;
        requestAnimationFrame(() => {
          fitScheduled = false;
          if (state.preview.zoomMode === 'fit') applyZoom();
        });
      });
      ro.observe($('previewCanvasWrap'));
    }

    await startNewTheme();
  }

  // Exposed for the automated end-to-end test and DevTools debugging.
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
    duplicateTheme,
    setTab,
    setZoom,
    openCommandPalette,
    openTemplateGallery,
    createFromTemplate,
    applyPalettePreset,
    ThemeTemplates
  };

  document.addEventListener('DOMContentLoaded', init);
})();
