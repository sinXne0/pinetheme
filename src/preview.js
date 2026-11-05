// Canvas-based preview renderer that approximates the Pager's 480x222
// layered rendering model closely enough to be genuinely useful for
// designing themes.
class PreviewRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 480;
    this.height = 222;
    canvas.width = this.width;
    canvas.height = this.height;
    this.model = null;
    this._images = new Map();      // path -> Image (loaded)
    this._pending = new Map();     // path -> Promise<Image>
    this._recolored = new Map();   // path + '|' + color -> canvas
    this.hitRegions = [];
    this.lastScreen = null;
    this.variables = {};           // $_VAR -> user-supplied sample value
    this.hidden = null;            // Set of layer/item objects to skip when drawing
  }

  setModel(model) {
    this.model = model;
    this._images.clear();
    this._pending.clear();
    this._recolored.clear();
  }

  setVariables(vars) {
    this.variables = vars || {};
  }

  // Interpret a variable value as a boolean for toggle/checkbox templates.
  truthy(v) {
    if (v == null || v === '') return true;
    if (typeof v === 'boolean') return v;
    return /^(true|on|1|yes|enabled|checked)$/i.test(String(v));
  }

  // Drop cached images for one asset path (e.g. after replace/delete/import).
  invalidate(path) {
    this._images.delete(path);
    this._pending.delete(path);
    const prefix = path + '|';
    for (const key of Array.from(this._recolored.keys())) {
      if (key.startsWith(prefix)) this._recolored.delete(key);
    }
  }

  mimeFor(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[ext] || 'image/png';
  }

  ensureImage(path) {
    if (!path) return Promise.resolve(null);
    if (this._images.has(path)) return Promise.resolve(this._images.get(path));
    if (this._pending.has(path)) return this._pending.get(path);
    const b64 = this.model ? this.model.getBase64(path) : null;
    if (!b64) {
      this._images.set(path, null);
      return Promise.resolve(null);
    }
    const p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { this._images.set(path, img); resolve(img); };
      img.onerror = () => { this._images.set(path, null); resolve(null); };
      img.src = 'data:' + this.mimeFor(path) + ';base64,' + b64;
    });
    this._pending.set(path, p);
    return p;
  }

  paletteColor(name) {
    const p = this.model ? this.model.getPalette() : {};
    return p[name] || null;
  }

  recolor(path, colorName) {
    const img = this._images.get(path);
    const color = this.paletteColor(colorName);
    if (!img || !color) return img;
    // Key on the resolved RGB, not the palette name, so editing a color
    // invalidates the tinted copy automatically.
    const key = path + '|' + color.r + ',' + color.g + ',' + color.b;
    if (this._recolored.has(key)) return this._recolored.get(key);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const id = g.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) {
        d[i] = color.r;
        d[i + 1] = color.g;
        d[i + 2] = color.b;
      }
    }
    g.putImageData(id, 0, 0);
    this._recolored.set(key, c);
    return c;
  }

  // ---- template resolution ------------------------------------------------
  resolveTemplate(name) {
    if (!this.model || !name) return null;
    const tj = this.model.getThemeJson() || {};
    const maps = ['string_templates', 'toggle_templates', 'radio_templates', 'signal_templates'];
    for (const m of maps) {
      if (tj[m] && typeof tj[m][name] === 'string') {
        const comp = this.model.getComponent(tj[m][name]);
        if (comp && !comp.__parseError) return { type: m === 'string_templates' ? 'text' : m.replace('_templates', ''), data: comp };
      }
    }
    return null;
  }

  sampleValue(v) {
    if (!v) return '';
    if (this.variables && this.variables[v]) return this.variables[v];
    const map = {
      '$_INPUT': 'Sample text',
      '$_LIST_ITEM': 'Option',
      '$_INPUT_NAME': 'Name',
      '$_PAYLOAD_TITLE': 'MyPayload',
      '$_PAYLOAD_VERSION': '1.0',
      '$_PAYLOAD_AUTHOR_NAME': 'author',
      '$_PAYLOAD_DESCRIPTION': 'Payload description',
      '$_PAYLOAD_CATEGORIES': 'Category',
      '$_RECON_RESULT_SSID': 'WiFiNetwork',
      '$_RECON_RESULT_BSSID': 'AA:BB:CC:DD:EE:FF',
      '$_RECON_RESULT_RSSI': '-55',
      '$_RECON_RESULT_FREQ': '5180',
      '$_RECON_RESULT_CHANNEL': '36',
      '$_RECON_RESULT_CLIENT_COUNT': '2',
      '$_RECON_RESULT_ENCRYPTION_TYPE': 'WPA2',
      '$_RECON_LIST_SIZE': '12',
      '$_RECON_LIST_PAGINATOR_LABEL_SHORT': '1/3',
      '$_RECON_LIST_AUTOUPDATING': 'on'
    };
    if (map[v]) return map[v];
    return v.replace(/^\$_/, '').replace(/_/g, ' ');
  }

  fontSize(size) {
    return { small: 13, medium: 17, large: 21 }[size] || 15;
  }

  // ---- layer drawing ------------------------------------------------------
  // Break text into display lines. Explicit newlines are always respected;
  // `wrap` additionally wraps at spaces using maxChars as the line width.
  wrapText(text, maxChars, wrap) {
    const raw = text == null ? '' : String(text);
    if (!raw) return [''];
    const limit = Math.max(1, maxChars || 0);
    const out = [];
    for (const para of raw.split('\n')) {
      if (!wrap || !maxChars) {
        out.push(maxChars ? para.slice(0, maxChars) : para);
        continue;
      }
      if (para === '') { out.push(''); continue; }
      let line = '';
      for (const word of para.split(' ')) {
        const candidate = line ? line + ' ' + word : word;
        if (candidate.length <= limit) { line = candidate; continue; }
        if (line) { out.push(line); line = ''; }
        let rest = word;
        while (rest.length > limit) {
          out.push(rest.slice(0, limit));
          rest = rest.slice(limit);
        }
        line = rest;
      }
      out.push(line);
    }
    return out;
  }

  drawText(text, x, y, size, colorName, center, opts = {}) {
    const ctx = this.ctx;
    const px = this.fontSize(size);
    ctx.font = px + "px 'Courier New', monospace";
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = Palette.toCss(this.paletteColor(colorName) || { r: 255, g: 255, b: 255 });

    let lines = this.wrapText(text, opts.max_chars || opts.maxChars, opts.wrap_text || opts.wrap);
    const maxLines = opts.max_lines || opts.maxLines;
    if (maxLines) lines = lines.slice(0, maxLines);

    const lineHeight = Math.round(px * 1.15);
    const blockH = Math.max(px, lines.length * lineHeight - (lineHeight - px));
    const startY = center
      ? center.start_y + (center.end_y - center.start_y - blockH) / 2
      : y;

    let maxW = 0;
    lines.forEach((line, i) => {
      const w = ctx.measureText(line).width;
      maxW = Math.max(maxW, w);
      const lx = center
        ? center.start_x + (center.end_x - center.start_x - w) / 2
        : x;
      ctx.fillText(line, Math.round(lx), Math.round(startY + i * lineHeight));
    });

    return { w: Math.max(1, maxW), h: Math.max(1, blockH) };
  }

  async drawImageLayer(path, x, y, colorName) {
    const img = await this.ensureImage(path);
    if (!img) return null;
    let draw = img;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (colorName && this.paletteColor(colorName)) {
      draw = this.recolor(path, colorName);
    }
    this.ctx.drawImage(draw, Math.round(x), Math.round(y));
    return { x, y, w, h };
  }

  // Draw one layer. `ox,oy` is the origin (0,0 for background/statusbar
  // absolute layers, or the menu item's x,y for item layers).
  async drawLayer(layer, ox, oy, meta) {
    const x = ox + (layer.x || 0);
    const y = oy + (layer.y || 0);
    const hit = (w, h) => this.hitRegions.push({
      x, y, w: w || 1, h: h || 1,
      layer, item: meta.item || null, itemIndex: meta.itemIndex
    });

    // inline text template
    if (layer.string_template) {
      const t = layer.string_template;
      const text = layer.text != null ? layer.text : this.sampleValue(layer.variable_name || layer.variable);
      const box = this.drawText(text, x, y, t.text_size, t.text_color_palette, t.center_text_within, t);
      hit(box.w, box.h);
      return;
    }
    // inline toggle template
    if (layer.toggle_template) {
      const v = layer.variable_name || layer.variable || (meta.item && meta.item.variable);
      const on = this.truthy(this.variables[v]);
      const layers = on
        ? (layer.toggle_template.enabled || layer.toggle_template.disabled || [])
        : (layer.toggle_template.disabled || layer.toggle_template.enabled || []);
      for (const l of layers) await this.drawLayer(l, x, y, meta);
      return;
    }
    // named template
    if (layer.use_template) {
      const t = this.resolveTemplate(layer.use_template);
      if (t) {
        if (t.type === 'text') {
          const text = layer.text != null ? layer.text : this.sampleValue(layer.variable_name || layer.variable);
          const box = this.drawText(text, x, y, t.data.text_size, t.data.text_color_palette, t.data.center_text_within, t.data);
          hit(box.w, box.h);
        } else if (t.type === 'toggle') {
          const v = layer.variable_name || layer.variable || (meta.item && meta.item.variable);
          const on = this.truthy(this.variables[v]);
          const layers = on
            ? (t.data.enabled || t.data.disabled || [])
            : (t.data.disabled || t.data.enabled || []);
          for (const l of layers) await this.drawLayer(l, x, y, meta);
        } else if (t.type === 'radio') {
          const layers = t.data.enabled || t.data.disabled || [];
          for (const l of layers) await this.drawLayer(l, x, y, meta);
        } else if (t.type === 'signal') {
          const layers = t.data.strong_signal || t.data.max_signal || t.data.weak_signal || t.data.minimum_signal || [];
          for (const l of layers) await this.drawLayer(l, x, y, meta);
        }
        return;
      }
    }
    // plain text / variable
    if (layer.text != null || layer.variable_name || layer.variable) {
      const text = layer.text != null ? layer.text : this.sampleValue(layer.variable_name || layer.variable);
      const box = this.drawText(text, x, y, layer.text_size, layer.text_color_palette, layer.center_text_within, layer);
      hit(box.w, box.h);
      return;
    }
    // image
    if (layer.image_path) {
      const box = await this.drawImageLayer(layer.image_path, x, y, layer.recolor_palette);
      if (box) hit(box.w, box.h);
    }
  }

  async drawLayers(layers, ox, oy, meta) {
    for (const l of layers || []) {
      if (l._comment) continue;
      if (this.hidden && this.hidden.has(l)) continue;
      await this.drawLayer(l, ox, oy, meta);
    }
  }

  // ---- high-level pieces --------------------------------------------------
  async drawBackground(screen) {
    const bg = screen.background || {};
    if (bg.background_color) {
      this.ctx.fillStyle = Palette.toCss(bg.background_color);
      this.ctx.fillRect(0, 0, this.width, this.height);
    }
    await this.drawLayers(bg.layers || [], 0, 0, { item: null, itemIndex: -1 });
  }

  async drawMenuItems(items, selectedIndex) {
    for (let i = 0; i < (items || []).length; i++) {
      const item = items[i];
      if (item._comment) continue;
      if (this.hidden && this.hidden.has(item)) continue;
      const ox = item.x || 0;
      const oy = item.y || 0;
      const selected = i === selectedIndex;
      // Keyboards and some one-state items only define selected_layers, so
      // fall back to those when no unselected layers exist.
      const layers = selected
        ? (item.selected_layers || item.layers || [])
        : (item.layers || item.selected_layers || []);

      // animation (spinner-like) — draw first frame
      if (item.animation && item.animation.length) {
        const f = item.animation[0];
        const box = await this.drawImageLayer(f.image_path, ox + (f.x || 0), oy + (f.y || 0), f.recolor_palette);
        if (box) this.hitRegions.push({ x: box.x, y: box.y, w: box.w, h: box.h, layer: f, item, itemIndex: i });
        continue;
      }
      await this.drawLayers(layers, ox, oy, { item, itemIndex: i });
    }
  }

  async drawStatusBar(screen) {
    const statusBarName = screen.status_bar;
    if (!statusBarName || !this.model) return;
    const tj = this.model.getThemeJson() || {};
    const path = (tj.status_bars && tj.status_bars[statusBarName]) || null;
    if (!path) return;
    const comp = this.model.getComponent(path);
    if (!comp || comp.__parseError || !comp.status_bar_items) return;

    for (const [name, item] of Object.entries(comp.status_bar_items)) {
      const ox = item.x || 0;
      const oy = item.y || 0;
      const states = item.layers || {};
      const stateKeys = Object.keys(states);
      if (!stateKeys.length) {
        // firmware-drawn text (e.g. Time) — draw a sample
        const sample = name === 'Time' ? '12:34' : name;
        this.drawText(sample, ox, oy, 'small', item.recolor_palette, null);
        continue;
      }
      const layers = states[stateKeys[0]] || [];
      await this.drawLayers(layers, ox, oy, { item, itemIndex: -1 });
    }
  }

  // ---- public API ---------------------------------------------------------
  listScreens(comp) {
    if (!comp) return [{ name: '', screen: null }];
    if (comp.__parseError) return [{ name: '', screen: comp }];
    const looksLikeScreen = (v) => v && typeof v === 'object' &&
      (v.menu_items || v.rows || v.pages || v.background || v.animation || v.status_bar_items);
    if (looksLikeScreen(comp)) return [{ name: '', screen: comp }];

    // Keyboard components keep their text field in `input_area`, separate
    // from the key layouts. Expose it as its own preview variant.
    const inputArea = comp.input_area && comp.input_area.max_characters != null
      ? { name: 'input_area', screen: { __inputArea: comp.input_area } }
      : null;

    const out = [];
    for (const [k, v] of Object.entries(comp)) {
      if (k.startsWith('_')) continue;
      if (inputArea && k === 'input_area') continue;
      if (looksLikeScreen(v)) out.push({ name: k, screen: v });
    }
    if (out.length) return inputArea ? [inputArea, ...out] : out;

    // Template state components: { enabled: [...], disabled: [...] } and the
    // signal variants. Expose each state as a previewable screen.
    const stateKeys = ['enabled', 'disabled', 'strong_signal', 'max_signal', 'weak_signal', 'minimum_signal'];
    const states = stateKeys.filter((k) => Array.isArray(comp[k]));
    if (states.length) {
      return states.map((k) => ({ name: k, screen: { __syntheticLayers: comp[k] } }));
    }

    // Image-only components (update checker, recon backgrounds, ...).
    const imageKeys = Object.keys(comp).filter(
      (k) => typeof comp[k] === 'string' && /(_image_path|background_path)$/.test(k)
    );
    if (imageKeys.length) {
      return imageKeys.map((k) => ({
        name: k.replace(/_image_path$/, '').replace(/_path$/, ''),
        screen: {
          __singleImage: comp[k],
          __recolor: comp[k.replace(/_(image_)?path$/, '_recolor_palette')]
        }
      }));
    }

    if (inputArea) return [inputArea];
    return [{ name: '', screen: comp }];
  }

  async render(componentPath, opts = {}) {
    this.hitRegions = [];
    this.hidden = opts.hidden || null;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = false;

    const comp = this.model ? this.model.getComponent(componentPath) : null;
    if (!comp) return this.hitRegions;
    if (comp.__parseError) {
      this.drawText('JSON parse error', 10, 10, 'medium', 'red', null);
      return this.hitRegions;
    }

    const screens = this.listScreens(comp);
    const screen = screens[opts.variantIndex || 0].screen;
    this.lastScreen = screen;
    if (!screen) return this.hitRegions;

    if (screen.__syntheticLayers) {
      await this.drawLayers(screen.__syntheticLayers, 0, 0, { item: null, itemIndex: -1 });
      return this.hitRegions;
    }
    if (screen.__singleImage) {
      await this.drawImageLayer(screen.__singleImage, 0, 0, screen.__recolor || null);
      return this.hitRegions;
    }
    if (screen.__inputArea) {
      const area = screen.__inputArea;
      if (area.background) await this.drawBackground(area.background);
      this.drawText('Sample text', area.x || 15, area.y || 16, 'medium', 'soft_white', null, {
        max_chars: area.max_characters
      });
      return this.hitRegions;
    }

    await this.drawBackground(screen);
    await this.drawStatusBar(screen);

    if (screen.menu_items) {
      await this.drawMenuItems(screen.menu_items, opts.selectedIndex || 0);
    } else if (screen.pages) {
      const page = screen.pages[opts.pageIndex || 0] || screen.pages[0];
      if (page && page.menu_items) await this.drawMenuItems(page.menu_items, opts.selectedIndex || 0);
    } else if (screen.rows) {
      for (const row of screen.rows) await this.drawMenuItems(row, -1);
    } else if (screen.animation && screen.animation.frames) {
      const f = screen.animation.frames[opts.frameIndex || 0] || screen.animation.frames[0];
      if (f) await this.drawImageLayer(f.image_path, f.x || 0, f.y || 0, f.recolor_palette);
    } else if (screen.status_bar_items) {
      // pure status bar component
      await this.drawStatusBarInline(screen.status_bar_items);
    } else if (screen.max_characters != null) {
      // keyboard input area
      this.drawText('Sample text', screen.x || 15, screen.y || 16, 'medium', 'soft_white', null, {
        max_chars: screen.max_characters
      });
    }

    return this.hitRegions;
  }

  async drawStatusBarInline(items) {
    for (const [name, item] of Object.entries(items || {})) {
      const ox = item.x || 0;
      const oy = item.y || 0;
      const states = item.layers || {};
      const stateKeys = Object.keys(states);
      if (!stateKeys.length) {
        this.drawText(name === 'Time' ? '12:34' : name, ox, oy, 'small', item.recolor_palette, null);
        continue;
      }
      await this.drawLayers(states[stateKeys[0]] || [], ox, oy, { item, itemIndex: -1 });
    }
  }
}

if (typeof window !== 'undefined') window.PreviewRenderer = PreviewRenderer;
