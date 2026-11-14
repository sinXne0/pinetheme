// Validation for Pager themes. Returns { errors: [], warnings: [], info: [] }.
const Validators = {
  validate(model) {
    const errors = [];
    const warnings = [];
    const info = [];

    // theme.json present + parses
    const tjRaw = model.getText('theme.json');
    if (tjRaw == null) {
      errors.push('theme.json is missing.');
      return { errors, warnings, info };
    }
    let tj = null;
    try {
      tj = JSON.parse(tjRaw);
    } catch (e) {
      errors.push('theme.json is not valid JSON: ' + e.message);
      return { errors, warnings, info };
    }

    if (!tj.theme_version) warnings.push('theme.json has no "theme_version".');
    if (!tj.theme_framework_version) warnings.push('theme.json has no "theme_framework_version".');
    if (tj.theme_version && String(tj.theme_version) !== '2.0.0') {
      info.push(`theme_version is ${tj.theme_version}; the bundled reference and current firmware use 2.0.0.`);
    }
    if (!tj.theme_name && !tj.name) {
      info.push('No optional "theme_name"/"name" in theme.json — the folder name is used.');
    }
    if (!tj.author) info.push('No "author" field in theme.json.');

    // Case-insensitive path collisions break on Windows/macOS filesystems.
    const seen = new Map();
    for (const p of model.listAllFiles()) {
      const key = p.toLowerCase();
      if (seen.has(key) && seen.get(key) !== p) {
        warnings.push(`Files differ only by case and may collide: ${seen.get(key)} / ${p}`);
      } else if (!seen.has(key)) {
        seen.set(key, p);
      }
    }

    // color palette
    const palette = {};
    if (!tj.color_palette || typeof tj.color_palette !== 'object') {
      errors.push('theme.json is missing "color_palette".');
    } else {
      for (const [name, c] of Object.entries(tj.color_palette)) {
        if (!c || typeof c !== 'object' ||
            typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') {
          errors.push(`Palette color "${name}" is malformed (expected {r,g,b} numbers).`);
        } else if (c.r < 0 || c.r > 255 || c.g < 0 || c.g > 255 || c.b < 0 || c.b > 255) {
          errors.push(`Palette color "${name}" has out-of-range value (0-255).`);
        } else {
          palette[name] = c;
        }
      }
    }

    // Every path-like string in theme.json must resolve (components AND assets).
    const themePaths = new Set();
    const walkTheme = (node, key) => {
      if (typeof node === 'string') {
        if ((node.startsWith('components/') || node.startsWith('assets/')) && !node.startsWith('assets/.')) {
          themePaths.add(node);
        }
      } else if (Array.isArray(node)) {
        for (const v of node) walkTheme(v, key);
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === '_unused') continue;
          walkTheme(v, k);
        }
      }
    };
    walkTheme(tj, '');
    for (const p of themePaths) {
      if (!model.has(p)) errors.push(`theme.json references missing file: ${p}`);
    }

    // referenced component paths (also catches weird nesting)
    for (const p of model.referencedComponentPaths()) {
      if (!model.has(p) && !themePaths.has(p)) errors.push(`Referenced component file is missing: ${p}`);
    }

    const paletteNames = new Set(Object.keys(palette));
    const componentFiles = model.listComponents();
    const assetUsage = new Map();

    for (const path of componentFiles) {
      const raw = model.getText(path);
      let comp;
      try {
        comp = JSON.parse(raw);
      } catch (e) {
        errors.push(`${path} is not valid JSON: ${e.message}`);
        continue;
      }

      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.image_path === 'string' && node.image_path) {
          assetUsage.set(node.image_path, (assetUsage.get(node.image_path) || 0) + 1);
        }
        // 2.0.0 image fields used outside layers.
        for (const k of ['background_path', 'checking_image_path', 'downloading_image_path', 'validating_image_path']) {
          if (typeof node[k] === 'string' && node[k]) {
            assetUsage.set(node[k], (assetUsage.get(node[k]) || 0) + 1);
          }
        }
        for (const k of ['recolor_palette', 'text_color_palette', 'bar_color_palette']) {
          if (typeof node[k] === 'string' && node[k] && !paletteNames.has(node[k])) {
            warnings.push(`${path} references undefined palette color "${node[k]}".`);
          }
        }
        if (typeof node.text_color === 'string' && node.text_color &&
            !node.text_color.startsWith('#') && !paletteNames.has(node.text_color)) {
          warnings.push(`${path} references undefined text color "${node.text_color}".`);
        }
        if (node.recolor_rgb && typeof node.recolor_rgb === 'object') {
          const c = node.recolor_rgb;
          for (const ch of ['r', 'g', 'b']) {
            if (!Number.isFinite(Number(c[ch])) || c[ch] < 0 || c[ch] > 255) {
              errors.push(`${path} has an invalid recolor_rgb.${ch} value.`);
            }
          }
        }
        for (const v of Object.values(node)) visit(v);
      };
      visit(comp);

      // status bar references
      const screens = [];
      if (comp.status_bar_items) screens.push(comp);
      if (comp.pages) screens.push(comp);
      const findScreens = (n) => {
        if (!n || typeof n !== 'object') return;
        if (n.status_bar || n.bt_status_bar) screens.push(n);
        for (const v of Object.values(n)) findScreens(v);
      };
      findScreens(comp);
      for (const s of screens) {
        if (typeof s.status_bar === 'string' && s.status_bar &&
            !(tj.status_bars && Object.prototype.hasOwnProperty.call(tj.status_bars, s.status_bar))) {
          warnings.push(`${path} uses undefined status bar "${s.status_bar}".`);
        }
        if (typeof s.bt_status_bar === 'string' && s.bt_status_bar &&
            !(tj.status_bars && Object.prototype.hasOwnProperty.call(tj.status_bars, s.bt_status_bar))) {
          warnings.push(`${path} uses undefined Bluetooth status bar "${s.bt_status_bar}".`);
        }
      }

      // Duplicate item IDs within one screen (info: some firmware keys are
      // intentionally repeated across pages).
      const collectIds = (screen, name) => {
        const ids = [];
        const walkItems = (items) => {
          for (const it of items || []) {
            if (it && typeof it.id === 'string') ids.push(it.id);
          }
        };
        if (screen.menu_items) walkItems(screen.menu_items);
        for (const p of screen.pages || []) walkItems(p.menu_items);
        for (const row of screen.rows || []) walkItems(row);
        const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
        if (dup.length) info.push(`${path}${name ? ' · ' + name : ''} has repeated item IDs: ${Array.from(new Set(dup)).join(', ')}`);
      };
      collectIds(comp, '');
      for (const [k, v] of Object.entries(comp)) {
        if (v && typeof v === 'object' && (v.menu_items || v.pages || v.rows)) collectIds(v, k);
      }
    }

    for (const img of assetUsage.keys()) {
      if (!model.has(img)) errors.push(`Component image is missing: ${img}`);
    }

    // Unused assets are useful studio information, not a validation failure.
    const unused = model.listAssets().filter((p) => !assetUsage.has(p));
    if (unused.length) info.push(`${unused.length} asset${unused.length === 1 ? '' : 's'} not referenced by components.`);

    // Contrast remains a manual tool in the Palette panel; auto-reporting it
    // produces too many false positives because text often sits over images.

    // required-ish core component presence
    const mustHave = ['boot_animation.json', 'spinner.json'];
    for (const m of mustHave) {
      const hit = componentFiles.some((p) => p.endsWith('/' + m));
      if (!hit) warnings.push(`No "${m}" component found (boot animation / spinner).`);
    }

    if (!model.listAssets().length) warnings.push('No assets found — theme will be blank.');

    // Package size info.
    let bytes = 0;
    for (const p of model.listAllFiles()) {
      const b = model.getBase64(p);
      if (b) bytes += Math.round(b.length * 3 / 4);
    }
    if (bytes > 12 * 1024 * 1024) {
      info.push(`Theme package is large (${(bytes / 1024 / 1024).toFixed(1)} MB). Consider compressing or removing unused assets.`);
    }

    return {
      errors: Array.from(new Set(errors)),
      warnings: Array.from(new Set(warnings)),
      info: Array.from(new Set(info)).slice(0, 20)
    };
  }
};

if (typeof window !== 'undefined') window.Validators = Validators;
