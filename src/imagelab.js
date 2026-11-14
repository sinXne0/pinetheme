// Image Lab — an offline, theme-aware image pipeline for Pager assets.
// Implements crop / resize / transform / color grading / dithering /
// palette quantization / outline / shadow / tint, plus a bridge to the
// vendored Toast UI advanced editor.
class ImageLab {
  constructor(opts) {
    this.model = opts.model;
    this.renderer = opts.renderer;
    this.toast = opts.toast || (() => {});
    this.onApply = opts.onApply || (() => {});
    this.onSavePng = opts.onSavePng || (() => {});
    this.onOpenAdvanced = opts.onOpenAdvanced || (() => {});
    this.askText = opts.askText || (() => Promise.resolve(null));
    this.source = null;          // HTMLCanvasElement at natural size
    this.sourcePath = null;
    this.sourceName = 'image';
    this.sourceDataUrl = null;
    this.ops = this.defaultOps();
    this.undoStack = [];
    this.beforeMode = false;
    this.zoomMode = 'fit';
    this.customDark = null;
    this.customLight = null;
    this._sliderActive = false;
    this._bound = false;
  }

  defaultOps() {
    return {
      preset: 'auto',
      outWidth: 0, outHeight: 0,
      resample: 'nearest',
      fit: 'contain',
      rotate: 0, flipH: false, flipV: false,
      crop: null,
      brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 1,
      invert: false, gray: false,
      mode: 'none', threshold: 128,
      dark: 'black', light: 'soft_white', paletteMode: '',
      alphaCutoff: 8, flatten: false, bgColor: '#000000',
      outline: 0, outlineColor: '#000000',
      shadow: 0, shadowX: 2, shadowY: 2, shadowColor: '#000000',
      tint: 0, tintColor: '#ffffff'
    };
  }

  bind() {
    if (this._bound) return;
    this._bound = true;
    const $ = (id) => document.getElementById(id);
    this.el = {
      asset: $('labAsset'), import: $('labImport'), export: $('labExport'),
      apply: $('labApply'), saveAs: $('labSaveAs'), reset: $('labReset'),
      undo: $('labUndo'), advanced: $('labAdvanced'),
      stage: $('labStage'), canvas: $('labCanvas'), empty: $('labEmpty'),
      dims: $('labDims'), info: $('labInfo'), zoomInfo: $('labZoomInfo'),
      preset: $('labPreset'), width: $('labWidth'), height: $('labHeight'),
      lock: $('labLock'), fit: $('labFitMode'), rotate: $('labRotate'),
      cropX: $('labCropX'), cropY: $('labCropY'), cropW: $('labCropW'), cropH: $('labCropH'),
      applyCrop: $('labApplyCrop'), resetCrop: $('labResetCrop'),
      flipH: $('labFlipH'), flipV: $('labFlipV'), trim: $('labTrim'),
      brightness: $('labBrightness'), contrast: $('labContrast'),
      saturation: $('labSaturation'), hue: $('labHue'), gamma: $('labGamma'),
      alphaCutoff: $('labAlphaCutoff'), invert: $('labInvert'), gray: $('labGray'),
      mode: $('labMode'), threshold: $('labThreshold'), dark: $('labDark'),
      light: $('labLight'), flatten: $('labFlatten'), bgColor: $('labBgColor'),
      outline: $('labOutline'), outlineColor: $('labOutlineColor'),
      shadow: $('labShadow'), shadowX: $('labShadowX'), shadowY: $('labShadowY'),
      shadowColor: $('labShadowColor'), tint: $('labTint'), tintColor: $('labTintColor'),
      zoom: $('labZoom'), checker: $('labChecker'), before: $('labBefore'),
      palette: $('labPaletteMode'), summary: $('labSummary')
    };
    if (!this.el.canvas) return;

    this.el.asset.addEventListener('change', () => {
      if (this.el.asset.value) this.loadAsset(this.el.asset.value);
    });
    if (this.el.stage) {
      this.el.stage.addEventListener('dragover', (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.el.stage.classList.add('drop-target');
      });
      this.el.stage.addEventListener('dragleave', () => this.el.stage.classList.remove('drop-target'));
      this.el.stage.addEventListener('drop', (e) => {
        e.preventDefault();
        this.el.stage.classList.remove('drop-target');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.importDropped(f);
      });
    }
    this.el.import.addEventListener('click', () => this.importFile());
    this.el.export.addEventListener('click', () => this.exportPng());
    this.el.apply.addEventListener('click', () => this.applyToAsset(false));
    this.el.saveAs.addEventListener('click', () => this.applyToAsset(true));
    this.el.reset.addEventListener('click', () => this.reset());
    this.el.undo.addEventListener('click', () => this.undo());
    if (this.el.advanced) this.el.advanced.addEventListener('click', () => this.openAdvanced());

    this.el.preset.addEventListener('change', () => {
      this.pushUndo();
      const p = ThemeTemplates.ASSET_PRESETS.find((x) => x.id === this.el.preset.value);
      if (!p) return;
      this.ops.preset = p.id;
      if (p.id === 'auto' && this.source) {
        this.ops.outWidth = this.source.width;
        this.ops.outHeight = this.source.height;
      } else if (p.w && p.h) {
        this.ops.outWidth = p.w;
        this.ops.outHeight = p.h;
      }
      this.syncControls();
      this.render();
    });
    const onDim = (which) => {
      this.pushUndo();
      const v = parseInt(this.el[which].value, 10) || 0;
      this.ops[which === 'width' ? 'outWidth' : 'outHeight'] = Math.max(1, v);
      this.ops.preset = 'custom';
      if (this.el.lock.checked && this.source) {
        const ratio = this.source.width / this.source.height;
        if (which === 'width') this.ops.outHeight = Math.max(1, Math.round(v / ratio));
        else this.ops.outWidth = Math.max(1, Math.round(v * ratio));
      }
      this.syncControls();
      this.render();
    };
    this.el.width.addEventListener('change', () => onDim('width'));
    this.el.height.addEventListener('change', () => onDim('height'));
    this.el.fit.addEventListener('change', () => {
      this.pushUndo();
      this.ops.fit = this.el.fit.value;
      this.render();
    });
    const transform = (fn) => () => { this.pushUndo(); fn(); this.syncControls(); this.render(); };
    this.el.rotate.addEventListener('click', transform(() => {
      this.ops.rotate = (this.ops.rotate + 90) % 360;
      if (this.ops.preset === 'auto') {
        const w = this.ops.outWidth; const h = this.ops.outHeight;
        this.ops.outWidth = h; this.ops.outHeight = w;
      }
    }));
    this.el.flipH.addEventListener('click', transform(() => { this.ops.flipH = !this.ops.flipH; }));
    this.el.flipV.addEventListener('click', transform(() => { this.ops.flipV = !this.ops.flipV; }));
    this.el.trim.addEventListener('click', transform(() => this.trimTransparent()));
    if (this.el.applyCrop) this.el.applyCrop.addEventListener('click', () => {
      this.pushUndo();
      const x = Math.max(0, parseInt(this.el.cropX.value, 10) || 0);
      const y = Math.max(0, parseInt(this.el.cropY.value, 10) || 0);
      const w = Math.max(1, parseInt(this.el.cropW.value, 10) || (this.source ? this.source.width : 1));
      const h = Math.max(1, parseInt(this.el.cropH.value, 10) || (this.source ? this.source.height : 1));
      this.ops.crop = { x, y, w, h };
      this.ops.outWidth = w;
      this.ops.outHeight = h;
      this.ops.preset = 'custom';
      this.syncControls();
      this.render();
    });
    if (this.el.resetCrop) this.el.resetCrop.addEventListener('click', () => {
      this.pushUndo();
      this.ops.crop = null;
      if (this.source) { this.ops.outWidth = this.source.width; this.ops.outHeight = this.source.height; }
      this.ops.preset = 'auto';
      this.syncControls();
      this.render();
    });
    this.el.invert.addEventListener('click', transform(() => { this.ops.invert = !this.ops.invert; }));
    this.el.gray.addEventListener('click', transform(() => { this.ops.gray = !this.ops.gray; }));

    const slider = (id, key, fn) => {
      const el = this.el[id];
      if (!el) return;
      el.addEventListener('input', () => {
        if (!this._sliderActive) { this.pushUndo(); this._sliderActive = true; }
        fn(parseFloat(el.value));
        this.render();
      });
      el.addEventListener('change', () => { this._sliderActive = false; this.syncControls(); });
    };
    slider('brightness', 'brightness', (v) => { this.ops.brightness = v; });
    slider('contrast', 'contrast', (v) => { this.ops.contrast = v; });
    slider('saturation', 'saturation', (v) => { this.ops.saturation = v; });
    slider('hue', 'hue', (v) => { this.ops.hue = v; });
    slider('gamma', 'gamma', (v) => { this.ops.gamma = Math.max(0.1, v); });
    slider('alphaCutoff', 'alphaCutoff', (v) => { this.ops.alphaCutoff = v; });
    slider('threshold', 'threshold', (v) => { this.ops.threshold = v; });
    slider('outline', 'outline', (v) => { this.ops.outline = v; });
    slider('tint', 'tint', (v) => { this.ops.tint = v / 100; });

    this.el.mode.addEventListener('change', () => {
      this.pushUndo();
      this.ops.mode = this.el.mode.value;
      this.syncControls();
      this.render();
    });
    this.el.dark.addEventListener('change', () => { this.pushUndo(); this.ops.dark = this.el.dark.value; this.render(); });
    this.el.light.addEventListener('change', () => { this.pushUndo(); this.ops.light = this.el.light.value; this.render(); });
    if (this.el.palette) this.el.palette.addEventListener('change', () => {
      this.pushUndo();
      this.ops.paletteMode = this.el.palette.value;
      this.render();
    });
    this.el.flatten.addEventListener('change', () => { this.pushUndo(); this.ops.flatten = this.el.flatten.checked; this.render(); });
    this.el.bgColor.addEventListener('input', () => { this.ops.bgColor = this.el.bgColor.value; this.render(); });
    this.el.outlineColor.addEventListener('input', () => { this.ops.outlineColor = this.el.outlineColor.value; this.render(); });
    this.el.shadowColor.addEventListener('input', () => { this.ops.shadowColor = this.el.shadowColor.value; this.render(); });
    this.el.tintColor.addEventListener('input', () => { this.ops.tintColor = this.el.tintColor.value; this.render(); });
    this.el.shadow.addEventListener('input', () => {
      if (!this._sliderActive) { this.pushUndo(); this._sliderActive = true; }
      this.ops.shadow = parseInt(this.el.shadow.value, 10) || 0;
      this.render();
    });
    this.el.shadow.addEventListener('change', () => { this._sliderActive = false; });
    this.el.shadowX.addEventListener('change', () => { this.pushUndo(); this.ops.shadowX = parseInt(this.el.shadowX.value, 10) || 0; this.render(); });
    this.el.shadowY.addEventListener('change', () => { this.pushUndo(); this.ops.shadowY = parseInt(this.el.shadowY.value, 10) || 0; this.render(); });
    this.el.zoom.addEventListener('change', () => { this.zoomMode = this.el.zoom.value; this.fitPreview(); });
    this.el.checker.addEventListener('change', () => { this.updateChecker(); });
    if (this.el.before) {
      const showBefore = (on) => {
        this.beforeMode = on;
        this.el.before.classList.toggle('active', on);
        this.render();
      };
      this.el.before.addEventListener('mousedown', () => showBefore(true));
      window.addEventListener('mouseup', () => { if (this.beforeMode) showBefore(false); });
      this.el.before.addEventListener('touchstart', () => showBefore(true), { passive: true });
      window.addEventListener('touchend', () => { if (this.beforeMode) showBefore(false); });
    }
    if (typeof ResizeObserver !== 'undefined') {
      let scheduled = false;
      this._ro = new ResizeObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; this.fitPreview(); });
      });
      this._ro.observe(this.el.stage);
    }
    this.populatePaletteSelects();
    this.populatePresets();
    this.syncControls();
  }

  populatePresets() {
    if (!this.el || !this.el.preset) return;
    this.el.preset.innerHTML = '';
    for (const p of ThemeTemplates.ASSET_PRESETS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      this.el.preset.appendChild(o);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom size';
    this.el.preset.appendChild(custom);
    this.el.preset.value = 'auto';
  }

  // ---- asset list ---------------------------------------------------------
  refreshAssetList(selected) {
    if (!this.el || !this.el.asset) return;
    const current = selected || this.sourcePath;
    const imgs = this.model.listAssets().filter((p) => /\.(png|jpe?g|gif|bmp|webp)$/i.test(p));
    this.el.asset.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = imgs.length ? 'Select an asset…' : 'No image assets in this theme';
    this.el.asset.appendChild(empty);
    for (const p of imgs) {
      const o = document.createElement('option');
      o.value = p;
      o.textContent = p.replace(/^assets\//, '');
      this.el.asset.appendChild(o);
    }
    if (current && imgs.includes(current)) this.el.asset.value = current;
    else this.el.asset.value = '';
    if (this.el.empty) this.el.empty.classList.toggle('hidden', !!this.source);
  }

  populatePaletteSelects() {
    if (!this.el || !this.el.dark) return;
    const palette = this.model.getPalette();
    for (const sel of [this.el.dark, this.el.light, this.el.palette]) {
      if (!sel) continue;
      const cur = sel.value;
      sel.innerHTML = '';
      if (sel === this.el.palette) {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '— no remap —';
        sel.appendChild(none);
      }
      for (const name of Object.keys(palette).sort()) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        o.style.color = Palette.toHex(palette[name]);
        sel.appendChild(o);
      }
      if (cur) sel.value = cur;
    }
    if (this.el.dark && !this.el.dark.value) this.el.dark.value = Object.keys(palette).includes('black') ? 'black' : (Object.keys(palette)[0] || '');
    if (this.el.light && !this.el.light.value) this.el.light.value = Object.keys(palette).includes('soft_white') ? 'soft_white' : (Object.keys(palette).slice(-1)[0] || '');
  }

  // ---- loading ------------------------------------------------------------
  loadAsset(path) {
    const b64 = this.model.getBase64(path);
    if (!b64) { this.toast('Asset not found: ' + path, true); return; }
    this.sourcePath = path;
    this.sourceName = path.replace(/^assets\//, '');
    this.sourceDataUrl = 'data:' + this.mimeFor(path) + ';base64,' + b64;
    this._loadDataUrl(this.sourceDataUrl, false);
  }

  importFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(f);
      });
      this.sourcePath = null;
      this.sourceName = f.name || 'imported.png';
      this.sourceDataUrl = dataUrl;
      this._loadDataUrl(dataUrl, true);
    };
    input.click();
  }

  importDropped(file) {
    if (!file || !(/^image\//i.test(file.type || '') || /\.(png|jpe?g|gif|bmp|webp)$/i.test(file.name || ''))) { this.toast('Drop an image file', true); return; }
    const reader = new FileReader();
    reader.onload = () => {
      this.sourcePath = null;
      this.sourceName = file.name || 'dropped.png';
      this.sourceDataUrl = reader.result;
      this._loadDataUrl(reader.result, true);
    };
    reader.onerror = () => this.toast('Could not read that image', true);
    reader.readAsDataURL(file);
  }

  _loadDataUrl(dataUrl, resetOps) {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      this.source = c;
      if (resetOps) this.ops = this.defaultOps();
      else this.ops = this.defaultOps();
      this.undoStack = [];
      this.ops.outWidth = c.width;
      this.ops.outHeight = c.height;
      this.el.empty && this.el.empty.classList.add('hidden');
      this.populatePaletteSelects();
      this.syncControls();
      this.render();
      this.toast('Loaded ' + this.sourceName);
    };
    img.onerror = () => this.toast('Could not decode image', true);
    img.src = dataUrl;
  }

  mimeFor(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }[ext] || 'image/png';
  }

  reset() {
    if (!this.source) return;
    this.pushUndo();
    this.ops = this.defaultOps();
    this.ops.outWidth = this.source.width;
    this.ops.outHeight = this.source.height;
    this.syncControls();
    this.render();
  }

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.ops));
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  undo() {
    if (!this.undoStack.length) { this.toast('Nothing to undo in Image Lab'); return; }
    this.ops = JSON.parse(this.undoStack.pop());
    this.syncControls();
    this.render();
  }

  trimTransparent() {
    if (!this.source) return;
    const ctx = this.source.getContext('2d');
    const d = ctx.getImageData(0, 0, this.source.width, this.source.height).data;
    let minX = this.source.width, minY = this.source.height, maxX = -1, maxY = -1;
    for (let y = 0; y < this.source.height; y++) {
      for (let x = 0; x < this.source.width; x++) {
        if (d[(y * this.source.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return;
    this.ops.crop = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    this.ops.outWidth = maxX - minX + 1;
    this.ops.outHeight = maxY - minY + 1;
    this.ops.preset = 'custom';
    this.toast('Trimmed to ' + this.ops.outWidth + '×' + this.ops.outHeight);
  }

  syncControls() {
    if (!this.el) return;
    const set = (el, val) => { if (el && document.activeElement !== el) el.value = val; };
    set(this.el.width, this.ops.outWidth || (this.source ? this.source.width : 0));
    set(this.el.height, this.ops.outHeight || (this.source ? this.source.height : 0));
    if (this.el.preset) this.el.preset.value = this.ops.preset;
    if (this.el.fit) this.el.fit.value = this.ops.fit;
    const crop = this.ops.crop || { x: 0, y: 0, w: this.source ? this.source.width : 0, h: this.source ? this.source.height : 0 };
    set(this.el.cropX, crop.x);
    set(this.el.cropY, crop.y);
    set(this.el.cropW, crop.w);
    set(this.el.cropH, crop.h);
    set(this.el.brightness, this.ops.brightness);
    const bv = document.getElementById('labBrightnessVal');
    if (bv) bv.textContent = (this.ops.brightness > 0 ? '+' : '') + this.ops.brightness + '%';
    set(this.el.contrast, this.ops.contrast);
    set(this.el.saturation, this.ops.saturation);
    set(this.el.hue, this.ops.hue);
    set(this.el.gamma, this.ops.gamma);
    set(this.el.alphaCutoff, this.ops.alphaCutoff);
    set(this.el.threshold, this.ops.threshold);
    set(this.el.outline, this.ops.outline);
    set(this.el.tint, Math.round(this.ops.tint * 100));
    if (this.el.mode) this.el.mode.value = this.ops.mode;
    if (this.el.palette) this.el.palette.value = this.ops.paletteMode || '';
    if (this.el.dark) this.el.dark.value = this.ops.dark;
    if (this.el.light) this.el.light.value = this.ops.light;
    if (this.el.flatten) this.el.flatten.checked = this.ops.flatten;
    if (this.el.bgColor) this.el.bgColor.value = this.ops.bgColor;
    if (this.el.outlineColor) this.el.outlineColor.value = this.ops.outlineColor;
    if (this.el.shadow) this.el.shadow.value = this.ops.shadow;
    if (this.el.shadowX) this.el.shadowX.value = this.ops.shadowX;
    if (this.el.shadowY) this.el.shadowY.value = this.ops.shadowY;
    if (this.el.shadowColor) this.el.shadowColor.value = this.ops.shadowColor;
    if (this.el.tintColor) this.el.tintColor.value = this.ops.tintColor;
    if (this.el.invert) this.el.invert.classList.toggle('active', this.ops.invert);
    if (this.el.gray) this.el.gray.classList.toggle('active', this.ops.gray);
    if (this.el.fit) this.el.fit.disabled = false;
    if (this.el.width) this.el.width.disabled = false;
    if (this.el.height) this.el.height.disabled = false;
    if (this.el.lock) this.el.lock.disabled = false;
    this.updateChecker();
  }

  updateChecker() {
    if (!this.el || !this.el.stage) return;
    const on = !this.el.checker || this.el.checker.checked;
    this.el.stage.classList.toggle('no-checker', !on);
  }

  // ---- pipeline -----------------------------------------------------------
  resolveColor(value, fallback) {
    const palette = this.model.getPalette();
    if (value === 'custom') return fallback || { r: 0, g: 0, b: 0 };
    return Palette.resolve(value, palette) || fallback || { r: 0, g: 0, b: 0 };
  }

  render() {
    if (!this.source || !this.el || !this.el.canvas) return;
    if (this.beforeMode) {
      this.drawBefore();
      return;
    }
    try {
      const out = this.renderCanvas();
      const cv = this.el.canvas;
      cv.width = out.width;
      cv.height = out.height;
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(out, 0, 0);
      this.el.dims.textContent = cv.width + '×' + cv.height;
      this.el.info.textContent = this.sourceName + ' · source ' + this.source.width + '×' + this.source.height +
        (this.ops.mode !== 'none' ? ' · ' + this.ops.mode : '');
      if (this.el.summary) this.el.summary.textContent = this.summaryText();
      this.fitPreview();
    } catch (e) {
      console.error('Image Lab render failed', e);
      this.toast('Image Lab failed: ' + e.message, true);
    }
  }

  drawBefore() {
    if (!this.source || !this.el) return;
    const cv = this.el.canvas;
    cv.width = this.source.width;
    cv.height = this.source.height;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(this.source, 0, 0);
    this.el.dims.textContent = cv.width + '×' + cv.height + ' (before)';
    this.fitPreview();
  }

  renderCanvas() {
    const src = this.source;
    const o = this.ops;

    // 1. crop (source coordinates)
    let crop = o.crop || { x: 0, y: 0, w: src.width, h: src.height };
    crop = {
      x: Math.max(0, Math.min(src.width - 1, crop.x | 0)),
      y: Math.max(0, Math.min(src.height - 1, crop.y | 0)),
      w: Math.max(1, Math.min(src.width - (crop.x | 0), crop.w | 0)),
      h: Math.max(1, Math.min(src.height - (crop.y | 0), crop.h | 0))
    };
    let base = this.canvas(crop.w, crop.h);
    base.getContext('2d').drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);

    // 2. rotate / flip
    const rotated = o.rotate % 180 !== 0;
    const rw = rotated ? base.height : base.width;
    const rh = rotated ? base.width : base.height;
    let t = this.canvas(rw, rh);
    const tc = t.getContext('2d');
    tc.save();
    tc.translate(rw / 2, rh / 2);
    tc.rotate((o.rotate || 0) * Math.PI / 180);
    tc.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
    tc.drawImage(base, -base.width / 2, -base.height / 2);
    tc.restore();

    // 3. target dimensions
    let tw = o.outWidth || t.width;
    let th = o.outHeight || t.height;
    if (o.preset === 'auto' && (!o.outWidth || !o.outHeight)) {
      tw = t.width; th = t.height;
    }
    tw = Math.max(1, Math.min(4096, Math.round(tw)));
    th = Math.max(1, Math.min(4096, Math.round(th)));
    const out = this.canvas(tw, th);
    const oc = out.getContext('2d');
    oc.imageSmoothingEnabled = o.resample !== 'nearest';
    oc.imageSmoothingQuality = 'high';

    const filter = this.cssFilter();
    if (filter) oc.filter = filter;

    if (!o.outWidth && !o.outHeight) {
      oc.drawImage(t, 0, 0);
    } else if (o.fit === 'stretch') {
      oc.drawImage(t, 0, 0, tw, th);
    } else if (o.fit === 'cover') {
      const scale = Math.max(tw / t.width, th / t.height);
      const dw = t.width * scale, dh = t.height * scale;
      oc.drawImage(t, (tw - dw) / 2, (th - dh) / 2, dw, dh);
    } else if (o.fit === 'none') {
      oc.drawImage(t, 0, 0);
    } else {
      const scale = Math.min(tw / t.width, th / t.height);
      const dw = t.width * scale, dh = t.height * scale;
      oc.drawImage(t, (tw - dw) / 2, (th - dh) / 2, dw, dh);
    }
    oc.filter = 'none';

    // 4. pixel operations
    let img = oc.getImageData(0, 0, tw, th);
    this.pixelPass(img, o, tw, th);
    oc.putImageData(img, 0, 0);

    // 5. effects
    let result = out;
    if (o.outline > 0 || (o.shadow > 0 && (o.shadowX || o.shadowY))) {
      result = this.effects(out, o);
    }
    if (o.flatten) {
      const flat = this.canvas(result.width, result.height);
      const fc = flat.getContext('2d');
      fc.fillStyle = o.bgColor || '#000000';
      fc.fillRect(0, 0, flat.width, flat.height);
      fc.drawImage(result, 0, 0);
      result = flat;
    }
    return result;
  }

  cssFilter() {
    const o = this.ops;
    const parts = [];
    if (o.brightness) parts.push(`brightness(${1 + o.brightness / 100})`);
    if (o.contrast) parts.push(`contrast(${1 + o.contrast / 100})`);
    if (o.saturation) parts.push(`saturate(${1 + o.saturation / 100})`);
    if (o.hue) parts.push(`hue-rotate(${o.hue}deg)`);
    if (o.gray) parts.push('grayscale(1)');
    if (o.invert) parts.push('invert(1)');
    return parts.length ? parts.join(' ') : '';
  }

  pixelPass(img, o, w, h) {
    const d = img.data;
    const gamma = o.gamma && o.gamma !== 1 ? o.gamma : 0;
    let lut = null;
    if (gamma) {
      lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, 1 / gamma) * 255);
    }
    // apply gamma / alpha cutoff
    for (let i = 0; i < d.length; i += 4) {
      if (lut) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
      if (d[i + 3] <= o.alphaCutoff) d[i + 3] = 0;
    }

    if (o.mode === 'none') return;
    const dark = this.resolveColor(o.dark, { r: 0, g: 0, b: 0 });
    const light = this.resolveColor(o.light, { r: 255, g: 255, b: 255 });
    const palette = this.model.getPalette();
    const paletteList = Object.values(palette);
    const threshold = o.threshold;

    if (o.mode === 'palette' || o.mode === 'palette-dither') {
      // nearest palette color, with optional ordered dithering
      const forced = o.paletteMode ? Palette.resolve(o.paletteMode, palette) : null;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (d[i + 3] === 0) continue;
          if (forced) {
            d[i] = forced.r; d[i + 1] = forced.g; d[i + 2] = forced.b; d[i + 3] = 255;
            continue;
          }
          let c = { r: d[i], g: d[i + 1], b: d[i + 2] };
          if (o.mode === 'palette-dither') {
            const bayer = this.bayer(x, y, 4);
            const bias = (bayer - 0.5) * 40;
            c = { r: Palette.clamp(c.r + bias), g: Palette.clamp(c.g + bias), b: Palette.clamp(c.b + bias) };
          }
          const n = Palette.nearest(c, palette);
          const col = n ? n.color : paletteList[0];
          if (col) { d[i] = col.r; d[i + 1] = col.g; d[i + 2] = col.b; d[i + 3] = 255; }
        }
      }
      return;
    }

    // Build grayscale buffer for threshold / dithering
    const gray = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        gray[y * w + x] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
    }

    const setPixel = (x, y, on) => {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) return;
      const col = on ? light : dark;
      d[i] = col.r; d[i + 1] = col.g; d[i + 2] = col.b; d[i + 3] = 255;
    };

    if (o.mode === 'threshold') {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(x, y, gray[y * w + x] >= threshold);
      return;
    }
    if (o.mode === 'dither-bayer4' || o.mode === 'dither-bayer8') {
      const size = o.mode === 'dither-bayer8' ? 8 : 4;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const b = this.bayer(x, y, size);
          setPixel(x, y, gray[y * w + x] / 255 > b);
        }
      }
      return;
    }
    // Error-diffusion dithering
    const fs = o.mode === 'dither-fs';
    const atkinson = o.mode === 'dither-atkinson';
    if (!fs && !atkinson) return;
    const g = Float32Array.from(gray);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const old = g[idx];
        const on = old >= threshold;
        const nv = on ? 255 : 0;
        setPixel(x, y, on);
        const err = old - nv;
        if (fs) {
          const spread = (xx, yy, f) => { if (xx >= 0 && xx < w && yy >= 0 && yy < h) g[yy * w + xx] += err * f; };
          spread(x + 1, y, 7 / 16);
          spread(x - 1, y + 1, 3 / 16);
          spread(x, y + 1, 5 / 16);
          spread(x + 1, y + 1, 1 / 16);
        } else {
          const spread = (xx, yy) => { if (xx >= 0 && xx < w && yy >= 0 && yy < h) g[yy * w + xx] += err / 8; };
          spread(x + 1, y); spread(x + 2, y);
          spread(x - 1, y + 1); spread(x, y + 1); spread(x + 1, y + 1);
          spread(x, y + 2);
        }
      }
    }
  }

  bayer(x, y, size) {
    const b4 = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5]
    ];
    if (size === 4) return (b4[y % 4][x % 4] + 0.5) / 16;
    // Build 8x8 from 4x4 recursively.
    const bx = x % 8, by = y % 8;
    const base = b4[by % 4][bx % 4];
    const quadrant = (by < 4 ? 0 : 2) + (bx < 4 ? 0 : 1);
    const add = [0, 2, 3, 1][quadrant];
    return (base * 4 + add + 0.5) / 64;
  }

  effects(input, o) {
    const pad = Math.max(o.outline || 0, Math.abs(o.shadowX || 0), Math.abs(o.shadowY || 0), o.shadow || 0);
    const w = input.width + pad * 2;
    const h = input.height + pad * 2;
    const out = this.canvas(w, h);
    const ctx = out.getContext('2d');

    if (o.shadow > 0) {
      ctx.save();
      ctx.shadowColor = o.shadowColor || '#000000';
      ctx.shadowBlur = o.shadow || 0;
      ctx.shadowOffsetX = o.shadowX || 0;
      ctx.shadowOffsetY = o.shadowY || 0;
      ctx.drawImage(input, pad, pad);
      ctx.restore();
    }

    if (o.outline > 0) {
      const sil = this.canvas(input.width, input.height);
      const sc = sil.getContext('2d');
      sc.drawImage(input, 0, 0);
      sc.globalCompositeOperation = 'source-in';
      sc.fillStyle = o.outlineColor || '#000000';
      sc.fillRect(0, 0, sil.width, sil.height);
      const steps = Math.max(8, Math.round(o.outline * 8));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        ctx.drawImage(sil, pad + Math.round(Math.cos(a) * o.outline), pad + Math.round(Math.sin(a) * o.outline));
      }
    }

    ctx.drawImage(input, pad, pad);

    if (o.tint > 0) {
      const layer = this.canvas(w, h);
      const lc = layer.getContext('2d');
      lc.drawImage(out, 0, 0);
      lc.globalCompositeOperation = 'source-atop';
      lc.globalAlpha = Math.max(0, Math.min(1, o.tint));
      lc.fillStyle = o.tintColor || '#ffffff';
      lc.fillRect(0, 0, w, h);
      return layer;
    }
    return out;
  }

  canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  fitPreview() {
    if (!this.el || !this.el.canvas || !this.el.stage) return;
    const cv = this.el.canvas;
    if (!cv.width || !cv.height) return;
    let scale;
    if (this.zoomMode === 'fit') {
      const availW = Math.max(60, this.el.stage.clientWidth - 36);
      const availH = Math.max(60, this.el.stage.clientHeight - 36);
      scale = Math.min(availW / cv.width, availH / cv.height);
      scale = Math.max(0.05, Math.min(scale, 8));
    } else if (this.zoomMode === '2') {
      scale = 2;
    } else {
      scale = 1;
    }
    cv.style.width = Math.round(cv.width * scale) + 'px';
    cv.style.height = Math.round(cv.height * scale) + 'px';
    cv.style.imageRendering = scale >= 1 ? 'pixelated' : 'auto';
    if (this.el.zoomInfo) {
      this.el.zoomInfo.textContent = Math.round(scale * 100) + '% · ' + cv.width + '×' + cv.height;
    }
  }

  summaryText() {
    const o = this.ops;
    const bits = [];
    if (o.outline) bits.push('outline ' + o.outline);
    if (o.shadow) bits.push('shadow ' + o.shadow);
    if (o.tint) bits.push('tint ' + Math.round(o.tint * 100) + '%');
    if (o.mode !== 'none') bits.push(o.mode);
    if (o.invert) bits.push('invert');
    if (o.gray) bits.push('grayscale');
    return bits.join(' · ') || 'No effects';
  }

  // ---- export / apply -----------------------------------------------------
  encodeBase64(mime, quality) {
    if (!this.el || !this.el.canvas) return null;
    const type = mime || 'image/png';
    const dataUrl = this.el.canvas.toDataURL(type, quality);
    return dataUrl.replace(/^data:[^;]+;base64,/, '');
  }

  getPngBase64() {
    return this.encodeBase64('image/png');
  }

  async applyToAsset(saveAs) {
    if (!this.source) { this.toast('Load an image first', true); return; }
    let path = this.sourcePath;
    if (saveAs || !path) {
      const suggested = path || ('assets/' + (this.sourceName || 'image').replace(/^assets\//, '').replace(/\.[^.]+$/, '') + '-edited.png');
      const raw = await this.askText({ title: 'Save image as', label: 'Asset path', value: suggested });
      if (raw == null) return;
      path = raw.trim().replace(/\\/g, '/');
      if (!path) return;
      if (!path.startsWith('assets/')) path = 'assets/' + path;
      if (!/\.(png|jpg|jpeg|webp)$/i.test(path)) path += '.png';
    }
    const ext = (path.split('.').pop() || '').toLowerCase();
    const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png');
    const b64 = this.encodeBase64(mime, 0.92);
    if (!b64) return;
    this.onApply(path, b64, this.el.canvas.width, this.el.canvas.height);
    this.sourcePath = path;
    this.sourceName = path.replace(/^assets\//, '');
    // Reload the flattened result as the new source so further edits stack.
    this._loadDataUrl('data:' + mime + ';base64,' + b64, true);
    this.toast('Wrote ' + path + ' (' + this.el.canvas.width + '×' + this.el.canvas.height + ')');
  }

  async exportPng() {
    if (!this.source) { this.toast('Load an image first', true); return; }
    const b64 = this.getPngBase64();
    const name = (this.sourcePath ? this.sourcePath.replace(/^assets\//, '').replace(/\.[^.]+$/, '') : 'image') + '-edited.png';
    await this.onSavePng(b64, name);
  }

  openAdvanced() {
    if (!this.source) { this.toast('Load an image first', true); return; }
    // Send the current pipeline result, not the original source.
    const dataUrl = this.el && this.el.canvas ? this.el.canvas.toDataURL('image/png') : this.source.toDataURL('image/png');
    this.sourceDataUrl = dataUrl;
    this.onOpenAdvanced(dataUrl, this.sourceName, (returned) => {
      this.sourceDataUrl = returned;
      this._loadDataUrl(returned, true);
      this.toast('Returned from advanced editor — review and apply.');
    });
  }
}

if (typeof window !== 'undefined') window.ImageLab = ImageLab;
