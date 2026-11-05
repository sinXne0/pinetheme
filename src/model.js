// ThemeModel holds the entire theme in memory as a flat file map,
// plus parsed helpers for theme.json, the color palette, and components.
class ThemeModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.files = new Map();       // relPath -> { base64, binary }
    this._componentCache = new Map(); // relPath -> parsed object (stable refs for editing)
    this._themeJsonText = null;   // cache key for parsed theme.json
    this._themeJsonCache = null;
    this.themeDirName = 'my-theme';
    this.meta = {
      name: 'My Theme',
      author: '',
      version: '1.0.0',
      frameworkVersion: '0.9',
      description: ''
    };
    this.dirty = false;
  }

  // ---- file map primitives ------------------------------------------------

  setFilesFromTree(tree) {
    this.reset();
    this.themeDirName = tree.name || 'my-theme';
    for (const f of tree.files || []) {
      this.files.set(f.path, { base64: f.base64, binary: f.binary });
    }
    this.afterLoad();
  }

  afterLoad() {
    this.meta.name = this.prettyName(this.themeDirName);
    const tj = this.getThemeJson();
    if (tj) {
      if (tj.theme_version) this.meta.version = String(tj.theme_version);
      if (tj.theme_framework_version) this.meta.frameworkVersion = String(tj.theme_framework_version);
    }
    // The official themes ship a plain "README" file; new themes use README.md.
    const readme = this.getText('README.md') != null ? this.getText('README.md') : this.getText('README');
    if (readme != null) {
      const am = readme.match(/Author:\s*(.+)/i);
      const dm = readme.match(/Description:\s*([\s\S]+?)(\n\n|\n#|\n$)/i);
      if (am) this.meta.author = am[1].trim();
      if (dm) this.meta.description = dm[1].trim();
    }
    this.dirty = false;
  }

  prettyName(slug) {
    return String(slug || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || 'My Theme';
  }

  slugify(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'my-theme';
  }

  has(path) {
    return this.files.has(path);
  }

  getText(path) {
    const f = this.files.get(path);
    if (!f) return null;
    if (f.binary) return null;
    return textDec.decode(Zip.base64ToBytes(f.base64));
  }

  getBase64(path) {
    const f = this.files.get(path);
    return f ? f.base64 : null;
  }

  setFile(path, content, binary) {
    let base64;
    if (binary) {
      base64 = typeof content === 'string' ? content : Zip.bytesToBase64(content);
    } else {
      base64 = Zip.bytesToBase64(enc.encode(content));
    }
    this.files.set(path, { base64, binary: !!binary });
    this.dirty = true;
  }

  deleteFile(path) {
    this.files.delete(path);
    this.dirty = true;
  }

  listAllFiles() {
    return Array.from(this.files.keys()).sort();
  }

  listComponents() {
    return this.listAllFiles().filter((p) => p.startsWith('components/') && p.endsWith('.json'));
  }

  listAssets() {
    return this.listAllFiles().filter((p) => p.startsWith('assets/'));
  }

  // ---- theme.json ---------------------------------------------------------

  getThemeJson() {
    const text = this.getText('theme.json');
    if (text == null) return null;
    // Parsing theme.json on every palette lookup was a hot path in the preview.
    if (text === this._themeJsonText) return this._themeJsonCache;
    this._themeJsonText = text;
    try {
      this._themeJsonCache = JSON.parse(text);
    } catch (e) {
      this._themeJsonCache = null;
    }
    return this._themeJsonCache;
  }

  getThemeJsonRaw() {
    return this.getText('theme.json') || '';
  }

  setThemeJson(obj) {
    this.setFile('theme.json', JSON.stringify(obj, null, 2), false);
  }

  // ---- palette ------------------------------------------------------------

  getPalette() {
    const tj = this.getThemeJson();
    if (tj && tj.color_palette) return tj.color_palette;
    return Object.assign({}, Palette.DEFAULT);
  }

  setPalette(palette) {
    const tj = Object.assign({}, this.getThemeJson() || {});
    tj.color_palette = palette;
    this.setThemeJson(tj);
  }

  // Palette mutators clone so the cached theme.json object is never modified
  // in place by UI code that keeps a reference to getPalette().
  setColor(name, color) {
    const p = Object.assign({}, this.getPalette());
    p[name] = { r: color.r, g: color.g, b: color.b };
    this.setPalette(p);
  }

  addColor(name) {
    const p = Object.assign({}, this.getPalette());
    if (p[name] == null) p[name] = { r: 200, g: 200, b: 200 };
    this.setPalette(p);
  }

  removeColor(name) {
    const p = Object.assign({}, this.getPalette());
    delete p[name];
    this.setPalette(p);
  }

  // ---- components ---------------------------------------------------------

  getComponent(path) {
    if (this._componentCache.has(path)) return this._componentCache.get(path);
    const text = this.getText(path);
    if (text == null) return null;
    try {
      const obj = JSON.parse(text);
      this._componentCache.set(path, obj);
      return obj;
    } catch (e) {
      return { __parseError: String(e && e.message || e) };
    }
  }

  getComponentRaw(path) {
    return this.getText(path);
  }

  setComponentRaw(path, text) {
    const obj = JSON.parse(text); // throws on invalid JSON
    this._componentCache.set(path, obj);
    this.setFile(path, text, false);
  }

  // Persist any in-memory component edits (e.g. drag/layout changes) back to
  // the file map. Called automatically before serialization.
  flushComponents() {
    for (const [path, obj] of this._componentCache) {
      if (!obj || obj.__parseError) continue;
      const text = JSON.stringify(obj, null, 2);
      const base64 = Zip.bytesToBase64(enc.encode(text));
      const current = this.files.get(path);
      // Keep file-object identity stable when nothing changed; undo/redo and
      // history dedupe rely on this.
      if (current && !current.binary && current.base64 === base64) continue;
      this.files.set(path, { base64, binary: false });
    }
  }

  // Collect every path referenced by theme.json values (status bars, menus,
  // dialogs, keyboards, templates, etc.) that points to a .json component.
  referencedComponentPaths() {
    const tj = this.getThemeJson();
    if (!tj) return [];
    const found = new Set();
    const walk = (node) => {
      if (typeof node === 'string') {
        if ((node.startsWith('components/') || node.startsWith('assets/')) && node.endsWith('.json')) {
          found.add(node);
        }
      } else if (Array.isArray(node)) {
        for (const v of node) walk(v);
      } else if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) {
          if (k === '_unused') continue;
          walk(node[k]);
        }
      }
    };
    walk(tj);
    return Array.from(found).sort();
  }

  // ---- serialization ------------------------------------------------------

  serializeFiles() {
    this.flushComponents();
    const out = [];
    for (const [path, f] of this.files) {
      out.push({ path, base64: f.base64, binary: f.binary });
    }
    return out;
  }

  buildReadme() {
    const m = this.meta;
    return [
      '# ' + (m.name || this.themeDirName),
      '',
      'A custom theme for the WiFi Pineapple Pager.',
      '',
      '- **Author**: ' + (m.author || '(unknown)'),
      '- **Version**: ' + (m.version || '1.0.0'),
      '- **Theme framework version**: ' + (m.frameworkVersion || '0.9'),
      '- **Description**: ' + (m.description || ''),
      '',
      m.description ? m.description : '',
      '',
      '## Install',
      '',
      'Copy this theme folder to `/root/themes/` on the Pager, then select it from',
      '**Settings > Display > Theme**.',
      ''
    ].join('\n');
  }

  // Ensure README.md exists and reflects the current metadata.
  ensureReadme() {
    this.setFile('README.md', this.buildReadme(), false);
  }
}

const enc = new TextEncoder();
const textDec = new TextDecoder('utf-8');

if (typeof window !== 'undefined') window.ThemeModel = ThemeModel;
