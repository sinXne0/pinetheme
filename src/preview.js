// Canvas-based preview renderer that approximates the Pager's 480x222
// layered rendering model. Supports the 2.0.0 additions used by community
// themes (recolor_rgb, text_color, radio_template, status bar states,
// animations, save_cancel_menu, QWERTY keyboards, etc.).
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
    this._recolored = new Map();   // path + '|' + rgb -> canvas
    this.hitRegions = [];
    this.lastScreen = null;
    this.lastComponentPath = null;
    this.variables = {};           // $_VAR -> user-supplied sample value
    this.hidden = null;            // Set of layer/item objects to skip when drawing
    this.statusStates = {};        // status item name -> state key
    this.animationFrame = 0;       // frame index for screen/item animations
    this.playing = false;
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

  setStatusStates(states) {
    this.statusStates = states || {};
  }

  // Interpret a variable value as a boolean for toggle/checkbox templates.
  truthy(v) {
    if (v == null || v === '') return true;
    if (typeof v === 'boolean') return v;
    return /^(true|on|1|yes|enabled|checked|selected)$/i.test(String(v));
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

  // Resolve palette names, RGB objects and #hex strings.
  resolveColor(value) {
    if (value == null) return null;
    if (typeof value === 'object') {
      return { r: Palette.clamp(value.r || 0), g: Palette.clamp(value.g || 0), b: Palette.clamp(value.b || 0) };
    }
    if (typeof value === 'string' && value.startsWith('#')) return Palette.fromHex(value);
    return this.paletteColor(value);
  }

  recolor(path, colorName, directRgb) {
    const img = this._images.get(path);
    const color = directRgb || this.resolveColor(colorName);
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
        if (comp && !comp.__parseError) {
          const type = m === 'string_templates' ? 'text' : m.replace('_templates', '');
          return { type, data: comp };
        }
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

  drawText(text, x, y, size, colorValue, center, opts = {}) {
    const ctx = this.ctx;
    const px = this.fontSize(size);
    ctx.font = px + "px 'Courier New', monospace";
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const col = this.resolveColor(colorValue) || { r: 255, g: 255, b: 255 };
    ctx.fillStyle = Palette.toCss(col);

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

  async drawImageLayer(path, x, y, colorValue, directRgb) {
    const img = await this.ensureImage(path);
    if (!img) return null;
    let draw = img;
    const color = directRgb || this.resolveColor(colorValue);
    if (color) draw = this.recolor(path, colorValue, color);
    this.ctx.drawImage(draw, Math.round(x), Math.round(y));
    return { x, y, w: img.naturalWidth, h: img.naturalHeight };
  }

  layerTextColor(layer, template) {
    return (template && (template.text_color_palette || template.text_color)) ||
      layer.text_color_palette || layer.text_color || null;
  }

  async drawStateLayers(states, x, y, meta, prefer) {
    const keys = Object.keys(states || {});
    let key = prefer;
    if (!key || !(key in (states || {}))) key = keys[0];
    const layers = (states || {})[key] || [];
    for (const l of layers) await this.drawLayer(l, x, y, meta);
  }

  // Draw one layer. `ox,oy` is the origin (0,0 for background/statusbar
  // absolute layers, or the menu item's x,y for item layers).
  async drawLayer(layer, ox, oy, meta) {
    if (!layer || layer._comment) return;
    if (this.hidden && this.hidden.has(layer)) return;
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
      const box = this.drawText(text, x, y, t.text_size, this.layerTextColor(layer, t), t.center_text_within, t);
      hit(box.w, box.h);
      return;
    }
    // inline toggle / radio templates
    if (layer.toggle_template || layer.radio_template) {
      const tpl = layer.toggle_template || layer.radio_template;
      const v = layer.variable_name || layer.variable || (meta.item && meta.item.variable);
      const on = this.truthy(this.variables[v]);
      const layers = on
        ? (tpl.enabled || tpl.disabled || [])
        : (tpl.disabled || tpl.enabled || []);
      for (const l of layers) await this.drawLayer(l, x, y, meta);
      return;
    }
    // named template
    if (layer.use_template) {
      const t = this.resolveTemplate(layer.use_template);
      if (t) {
        if (t.type === 'text') {
          const text = layer.text != null ? layer.text : this.sampleValue(layer.variable_name || layer.variable);
          const box = this.drawText(text, x, y, t.data.text_size, this.layerTextColor(layer, t.data), t.data.center_text_within, t.data);
          hit(box.w, box.h);
        } else if (t.type === 'toggle' || t.type === 'radio') {
          const v = layer.variable_name || layer.variable || (meta.item && meta.item.variable);
          const on = t.type === 'toggle' ? this.truthy(this.variables[v]) : true;
          const layers = on
            ? (t.data.enabled || t.data.disabled || [])
            : (t.data.disabled || t.data.enabled || []);
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
      const box = this.drawText(text, x, y, layer.text_size, this.layerTextColor(layer, null), layer.center_text_within, layer);
      hit(box.w, box.h);
      return;
    }
    // image
    if (layer.image_path) {
      const box = await this.drawImageLayer(layer.image_path, x, y, layer.recolor_palette || layer.recolor_rgb, layer.recolor_rgb || null);
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
    // Some 2.0.0 components use a single background_path instead of background.
    if (screen.background_path && (!bg.layers || !bg.layers.length)) {
      await this.drawImageLayer(screen.background_path, 0, 0, null, null);
    }
  }

  async drawMenuItems(items, selectedIndex) {
    for (let i = 0; i < (items || []).length; i++) {
      const item = items[i];
      if (item._comment) continue;
      if (this.hidden && this.hidden.has(item)) continue;
      const ox = item.x || 0;
      const oy = item.y || 0;
      const selected = i === selectedIndex || item.selected === true;
      // Keyboards and some one-state items only define selected_layers, so
      // fall back to those when no unselected layers exist.
      const layers = selected
        ? (item.selected_layers || item.layers || [])
        : (item.layers || item.selected_layers || []);

      // animation (spinner-like) — draw the active frame
      if (item.animation && item.animation.length) {
        const idx = Math.min(item.animation.length - 1, Math.max(0, this.animationFrame | 0));
        const f = item.animation[idx];
        if (f) {
          const box = await this.drawImageLayer(f.image_path, ox + (f.x || 0), oy + (f.y || 0), f.recolor_palette || f.recolor_rgb);
          if (box) this.hitRegions.push({ x: box.x, y: box.y, w: box.w, h: box.h, layer: f, item, itemIndex: i });
        }
        continue;
      }
      await this.drawLayers(layers, ox, oy, { item, itemIndex: i });
    }
  }

  statusBarPath(screen) {
    if (!this.model) return null;
    const tj = this.model.getThemeJson() || {};
    const names = [screen.status_bar];
    if (screen.bt_status_bar) names.push(screen.bt_status_bar);
    for (const name of names) {
      if (name && tj.status_bars && tj.status_bars[name]) return tj.status_bars[name];
    }
    return null;
  }

  async drawStatusBar(screen) {
    const path = this.statusBarPath(screen);
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
        this.drawText(sample, ox, oy, 'small', item.recolor_palette || item.recolor_rgb || 'soft_white', null);
        continue;
      }
      const preferred = this.statusStates[name] || this.statusStates['*'] || null;
      await this.drawStateLayers(states, ox, oy, { item, itemIndex: -1 }, preferred);
    }
  }

  // Payload log / streaming text preview (2.0.0).
  drawLogLines(screen) {
    if (!screen || screen.visible_lines == null) return;
    const count = Math.max(1, Math.min(40, screen.visible_lines | 0));
    const size = screen.text_size || 'small';
    const px = this.fontSize(size);
    const lineH = Math.round(px * 1.15);
    const x = screen.start_x != null ? screen.start_x : 6;
    const y = screen.start_y != null ? screen.start_y : 24;
    const defaultColor = screen.default_text_color || screen.text_color_palette || 'soft_white';
    const errorColor = screen.error_text_color || 'red';
    const maxChars = screen.max_chars || 50;
    const samples = [
      '[*] payload started',
      '[*] scanning interfaces...',
      '[+] found target network',
      '[i] channel 6 · -52 dBm',
      '[+] handshake captured',
      '[*] writing loot/2026-01-01.cap',
      '[-] retrying deauth (3/5)',
      '[*] cleaning up'
    ];
    for (let i = 0; i < count; i++) {
      const text = (samples[i % samples.length] + ' ' + (i + 1)).slice(0, maxChars);
      const isErr = /^\[-\]/.test(text) && i === count - 1;
      this.drawText(text, x, y + i * lineH, size, isErr ? errorColor : defaultColor, null, { max_chars: maxChars });
    }
  }

  // Recon dashboard graph (2.0.0 dashboard_recon). The real data is supplied
  // by the firmware, so draw representative bars for layout previewing.
  drawReconGraph(screen) {
    if (!screen || screen.graph_width == null || screen.bar_w == null) return;
    const ctx = this.ctx;
    const x0 = screen.x_start != null ? screen.x_start : 23;
    const yTop = screen.y_top != null ? screen.y_top : 92;
    const yBottom = screen.y_bottom != null ? screen.y_bottom : 178;
    const barW = Math.max(1, screen.bar_w || 8);
    const gap = Math.max(0, screen.bar_gap || 1);
    const width = Math.max(1, screen.graph_width || 45);
    const count = Math.max(1, Math.floor(width / (barW + gap)));
    const color = this.resolveColor(screen.bar_color_palette || screen.text_color_palette) || { r: 231, g: 197, b: 74 };
    ctx.save();
    ctx.fillStyle = Palette.toCss(color);
    for (let i = 0; i < count; i++) {
      const t = 0.18 + 0.82 * Math.abs(Math.sin((i + 1) * 1.17));
      const h = Math.round((yBottom - yTop) * t);
      ctx.fillRect(Math.round(x0 + i * (barW + gap)), yBottom - h, barW, h);
    }
    const labelColor = this.resolveColor(screen.text_color_palette) || color;
    const small = this.fontSize('small');
    ctx.font = small + "px 'Courier New', monospace";
    ctx.fillStyle = Palette.toCss(labelColor);
    ctx.textBaseline = 'top';
    const lx = screen.y_label_x != null ? screen.y_label_x : 440;
    const ly = screen.y_label_y != null ? screen.y_label_y : 83;
    ctx.fillText('100', lx, ly);
    ctx.fillText('50', screen.y_half_label_x != null ? screen.y_half_label_x : lx, screen.y_half_label_y != null ? screen.y_half_label_y : 132);
    ctx.fillText('0', lx, yBottom - small);
    ctx.restore();
  }

  // ---- public API ---------------------------------------------------------
  listScreens(comp) {
    if (!comp) return [{ name: '', screen: null }];
    if (comp.__parseError) return [{ name: '', screen: comp }];
    const looksLikeScreen = (v) => v && typeof v === 'object' &&
      (v.menu_items || v.rows || v.pages || v.background || v.animation || v.status_bar_items ||
       v.save_cancel_menu || v.title_x != null);
    if (looksLikeScreen(comp)) {
      if (comp.save_cancel_menu) {
        return [
          { name: comp.screen_name || 'main', screen: comp },
          { name: 'save_cancel', screen: comp.save_cancel_menu }
        ];
      }
      return [{ name: '', screen: comp }];
    }

    // Keyboard components keep their text field in `input_area`, separate
    // from the key layouts. Expose it as its own preview variant.
    const inputArea = comp.input_area && comp.input_area.max_characters != null
      ? { name: 'input_area', screen: { __inputArea: comp.input_area } }
      : null;

    const out = [];
    for (const [k, v] of Object.entries(comp)) {
      if (k.startsWith('_')) continue;
      if (inputArea && k === 'input_area') continue;
      if (looksLikeScreen(v)) {
        out.push({ name: k, screen: v });
        if (v.save_cancel_menu && v.save_cancel_menu !== v) {
          out.push({ name: k + '_save_cancel', screen: v.save_cancel_menu });
        }
      }
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
    this.statusStates = opts.statusStates || this.statusStates || {};
    this.animationFrame = opts.frameIndex || 0;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.imageSmoothingEnabled = false;
    this.lastComponentPath = componentPath || null;
    this.lastScreen = null;

    const comp = this.model ? this.model.getComponent(componentPath) : null;
    if (!comp) return this.hitRegions;
    if (comp.__parseError) {
      this.drawText('JSON parse error', 10, 10, 'medium', 'red', null);
      return this.hitRegions;
    }

    const screens = this.listScreens(comp);
    const idx = Math.min(screens.length - 1, Math.max(0, opts.variantIndex || 0));
    const screen = screens[idx] && screens[idx].screen;
    this.lastScreen = screen;
    if (!screen) return this.hitRegions;

    if (screen.__syntheticLayers) {
      await this.drawLayers(screen.__syntheticLayers, 0, 0, { item: null, itemIndex: -1 });
      return this.hitRegions;
    }
    if (screen.__singleImage) {
      await this.drawImageLayer(screen.__singleImage, 0, 0, screen.__recolor || null, null);
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
      const flat = [];
      for (const row of screen.rows) for (const it of row || []) flat.push(it);
      await this.drawMenuItems(flat, opts.selectedIndex || 0);
    } else if (screen.visible_lines != null) {
      this.drawLogLines(screen);
    } else if (screen.save_cancel_menu) {
      const sc = screen.save_cancel_menu;
      if (sc.pages) {
        const page = sc.pages[opts.pageIndex || 0] || sc.pages[0];
        if (page && page.menu_items) await this.drawMenuItems(page.menu_items, opts.selectedIndex || 0);
      } else if (sc.menu_items) {
        await this.drawMenuItems(sc.menu_items, opts.selectedIndex || 0);
      }
    } else if (screen.animation && screen.animation.frames) {
      const f = screen.animation.frames[opts.frameIndex || 0] || screen.animation.frames[0];
      if (f) await this.drawImageLayer(f.image_path, f.x || 0, f.y || 0, f.recolor_palette || f.recolor_rgb, null);
    } else if (screen.status_bar_items) {
      // pure status bar component
      await this.drawStatusBarInline(screen.status_bar_items);
    } else if (screen.max_characters != null) {
      // keyboard input area
      this.drawText('Sample text', screen.x || 15, screen.y || 16, 'medium', 'soft_white', null, {
        max_chars: screen.max_characters
      });
    }

    if (screen.graph_width != null) {
      this.drawReconGraph(screen);
    }

    // Payload log / list indicator arrays (2.0.0).
    const indicatorKeys = [
      'scroll_pause_indicator', 'scroll_up_indicator', 'scroll_down_indicator',
      'payload_running_indicator', 'payload_complete_indicator', 'payload_stopped_indicator',
      'payload_error_indicator', 'payload_errored_indicator'
    ];
    for (const key of indicatorKeys) {
      if (Array.isArray(screen[key])) {
        await this.drawLayers(screen[key], 0, 0, { item: null, itemIndex: -1 });
      }
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
        this.drawText(name === 'Time' ? '12:34' : name, ox, oy, 'small', item.recolor_palette || 'soft_white', null);
        continue;
      }
      const preferred = this.statusStates[name] || this.statusStates['*'] || null;
      await this.drawStateLayers(states, ox, oy, { item, itemIndex: -1 }, preferred);
    }
  }

  // List status bar states for the simulation UI.
  statusBarOptions(comp) {
    const out = [];
    if (!comp || !comp.status_bar_items) return out;
    for (const [name, item] of Object.entries(comp.status_bar_items)) {
      const states = Object.keys(item.layers || {});
      if (states.length) out.push({ name, states, selected: this.statusStates[name] || states[0] });
    }
    return out;
  }
}

if (typeof window !== 'undefined') window.PreviewRenderer = PreviewRenderer;
