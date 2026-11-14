/*
 * PineTheme Studio — Android bridge.
 *
 * Implements the same `window.api` surface as preload.js so the Electron
 * renderer runs unchanged inside the Android WebView:
 *
 *   - the bundled reference theme is read from assets (XHR on file://)
 *   - imports go through the system file picker (<input type=file>, which the
 *     shell wires to ACTION_GET_CONTENT)
 *   - exports go through the system "create document" dialog (SAF)
 *   - the working theme is autosaved to app storage through the native bridge
 *
 * Loaded only in the Android build.
 */
(function () {
  'use strict';

  const native = window.Android;
  const isAndroid = !!native;

  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('pt-mobile');
    installChrome();
  });

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function bytesToBase64(bytes) {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(bytesToBase64(new Uint8Array(reader.result)));
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsArrayBuffer(file);
    });
  }

  function pickFiles(accept, multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.multiple = !!multiple;
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(input);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { input.remove(); } catch (e) { /* ignore */ }
        resolve(value);
      };

      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return finish([]);
        try {
          const out = [];
          for (const f of files) {
            out.push({ name: f.name, size: f.size, base64: await readFileBase64(f) });
          }
          finish(out);
        } catch (e) {
          finish([]);
        }
      });
      input.addEventListener('cancel', () => finish([]));

      input.click();
    });
  }

  function loadJson(url) {
    return new Promise((resolve, reject) => {
      const req = new XMLHttpRequest();
      req.open('GET', url, true);
      req.responseType = 'text';
      req.onload = () => {
        // file:// XHR reports status 0 on success.
        if (req.status === 0 || req.status === 200) {
          try {
            resolve(JSON.parse(req.responseText));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error('HTTP ' + req.status));
        }
      };
      req.onerror = () => reject(new Error('could not read ' + url));
      req.send();
    });
  }

  function scaffoldTree() {
    const themeJson = {
      theme_version: '2.0.0',
      theme_framework_version: '0.9',
      color_palette: window.Palette ? Object.assign({}, window.Palette.DEFAULT) : {}
    };
    const enc = new TextEncoder();
    return {
      name: 'my-theme',
      files: [
        { path: 'theme.json', base64: bytesToBase64(enc.encode(JSON.stringify(themeJson, null, 2))), binary: false },
        { path: 'README.md', base64: bytesToBase64(enc.encode('# Untitled Theme\n')), binary: false }
      ]
    };
  }

  function mimeFor(name) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.zip')) return 'application/zip';
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
    if (n.endsWith('.gif')) return 'image/gif';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.json')) return 'application/json';
    if (n.endsWith('.svg')) return 'image/svg+xml';
    if (n.endsWith('.txt') || n.endsWith('.md')) return 'text/plain';
    return 'application/octet-stream';
  }

  // ------------------------------------------------------------------
  // window.api — same contract as preload.js
  // ------------------------------------------------------------------

  const api = {
    platform: 'android',

    async loadReferenceTree() {
      try {
        return await loadJson('reference/wargames-tree.json');
      } catch (e) {
        console.warn('[pinetheme] reference theme unavailable, using blank scaffold', e);
        return scaffoldTree();
      }
    },

    // Android cannot browse arbitrary folders; opening a ZIP covers the same
    // use case and the toolbar hides the folder button.
    async openThemeFolder() {
      const picked = await pickFiles('.zip,application/zip', false);
      if (!picked.length) return null;
      const parsed = await window.Zip.parse(picked[0].base64);
      return {
        tree: { name: picked[0].name.replace(/\.zip$/i, ''), files: parsed.files },
        folderPath: null
      };
    },

    async readTree(path) {
      try {
        const json = native.readTree(path);
        return json ? JSON.parse(json) : null;
      } catch (e) {
        return null;
      }
    },

    async pickSaveFolder() {
      return 'themes';
    },

    joinPath(parent, name) {
      return String(parent || 'themes').replace(/\/+$/, '') + '/' + name;
    },

    async saveThemeToFolder(files, folderPath) {
      native.writeTree(folderPath, JSON.stringify(files || []));
      return { ok: true, count: (files || []).length };
    },

    async saveZip(base64, name) {
      native.saveBase64(name || 'theme.zip', 'application/zip', base64);
      return name || 'theme.zip';
    },

    async saveBinaryFile(base64, name) {
      native.saveBase64(name || 'export.bin', mimeFor(name), base64);
      return name || 'export.bin';
    },

    setDirty() {
      /* the Android shell always keeps the last save on disk */
    },

    async openZip() {
      const picked = await pickFiles('.zip,application/zip', false);
      if (!picked.length) return null;
      return { name: picked[0].name, base64: picked[0].base64 };
    },

    async pickAssetFiles() {
      const picked = await pickFiles('image/*', true);
      return picked.map((f) => ({ name: f.name, base64: f.base64 }));
    },

    async pickThemeRepo() {
      return api.scanThemeRepo('themes');
    },

    async scanThemeRepo(dir) {
      const folder = dir || 'themes';
      try {
        const themes = JSON.parse(native.listThemes());
        return { folderPath: folder, themes: themes };
      } catch (e) {
        return { folderPath: folder, themes: [] };
      }
    }
  };

  window.api = api;

  // ------------------------------------------------------------------
  // mobile chrome
  // ------------------------------------------------------------------

  function installChrome() {
    // Folder browsing does not exist on Android; the ZIP button replaces it.
    const openBtn = document.getElementById('btnOpen');
    if (openBtn) openBtn.classList.add('hidden');

    // Collapse / expand the preview panel (phones only).
    const headRow = document.querySelector('.preview-head-row');
    if (headRow && !document.getElementById('ptPreviewToggle')) {
      const toggle = document.createElement('button');
      toggle.id = 'ptPreviewToggle';
      toggle.className = 'mini';
      toggle.title = 'Collapse or expand the preview';
      toggle.textContent = '▾';
      toggle.addEventListener('click', () => {
        const collapsed = document.body.classList.toggle('pt-preview-collapsed');
        toggle.textContent = collapsed ? '▴' : '▾';
      });
      const focusBtn = document.getElementById('btnPreviewFocus');
      headRow.insertBefore(toggle, focusBtn || null);
    }

    // Toggling Edit switches the canvas between "scroll" and "drag to move".
    const editMode = document.getElementById('editMode');
    const syncEdit = () => document.body.classList.toggle('pt-edit', !!(editMode && editMode.checked));
    if (editMode) editMode.addEventListener('change', syncEdit);
    syncEdit();

    // Keep the active bottom-nav item visible after tab changes.
    document.querySelectorAll('#sidebar .nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        setTimeout(() => item.scrollIntoView({ block: 'nearest', inline: 'center' }), 60);
      });
    });

    // First-run hint.
    if (!localStorage.getItem('pt-android-seen')) {
      try { localStorage.setItem('pt-android-seen', '1'); } catch (e) { /* ignore */ }
      setTimeout(() => {
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = 'Android build · tap a tab below · drag on the canvas in Edit mode';
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 4200);
      }, 900);
    }
  }

  // Hardware back button: close whatever is open, otherwise leave the app.
  window.__ptBackPressed = function () {
    const overlay = document.querySelector('.overlay:not(.hidden)');
    const context = document.querySelector('.context-menu:not(.hidden)');
    const focused = document.body.classList.contains('focus-preview');
    const state = window.__themeBuilder && window.__themeBuilder.state;
    const selecting = state && state.selection && state.selection.length;

    if (overlay || context || focused || selecting) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    }

    // Nothing to dismiss: step back to the overview tab before exiting.
    if (state && state.currentTab && state.currentTab !== 'design') {
      window.__themeBuilder.setTab('design');
      return true;
    }

    return false;
  };
})();
