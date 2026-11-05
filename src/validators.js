// Validation for Pager themes. Returns { errors: [], warnings: [] }.
const Validators = {
  validate(model) {
    const errors = [];
    const warnings = [];

    // theme.json present + parses
    const tjRaw = model.getText('theme.json');
    if (tjRaw == null) {
      errors.push('theme.json is missing.');
      return { errors, warnings };
    }
    let tj = null;
    try {
      tj = JSON.parse(tjRaw);
    } catch (e) {
      errors.push('theme.json is not valid JSON: ' + e.message);
      return { errors, warnings };
    }

    if (!tj.theme_version) warnings.push('theme.json has no "theme_version".');
    if (!tj.theme_framework_version) warnings.push('theme.json has no "theme_framework_version".');

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
    if (!tj.color_palette || typeof tj.color_palette !== 'object') {
      errors.push('theme.json is missing "color_palette".');
    } else {
      for (const [name, c] of Object.entries(tj.color_palette)) {
        if (!c || typeof c !== 'object' ||
            typeof c.r !== 'number' || typeof c.g !== 'number' || typeof c.b !== 'number') {
          errors.push(`Palette color "${name}" is malformed (expected {r,g,b} numbers).`);
        } else if (c.r < 0 || c.r > 255 || c.g < 0 || c.g > 255 || c.b < 0 || c.b > 255) {
          errors.push(`Palette color "${name}" has out-of-range value (0-255).`);
        }
      }
    }

    // referenced component paths
    const referenced = model.referencedComponentPaths();
    for (const p of referenced) {
      if (!model.has(p)) {
        errors.push(`Referenced component file is missing: ${p}`);
      }
    }

    // every component JSON must parse + assets must exist
    const paletteNames = new Set(Object.keys(tj.color_palette || {}));
    const componentFiles = model.listComponents();
    for (const path of componentFiles) {
      const raw = model.getText(path);
      let comp;
      try {
        comp = JSON.parse(raw);
      } catch (e) {
        errors.push(`${path} is not valid JSON: ${e.message}`);
        continue;
      }

      // gather referenced image paths + palette names within this component
      const imgRefs = new Set();
      const colorRefs = new Set();
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.image_path === 'string') imgRefs.add(node.image_path);
        if (typeof node.recolor_palette === 'string') colorRefs.add(node.recolor_palette);
        if (typeof node.text_color_palette === 'string') colorRefs.add(node.text_color_palette);
        for (const v of Object.values(node)) visit(v);
      };
      visit(comp);

      for (const img of imgRefs) {
        if (!model.has(img)) errors.push(`${path} references missing asset: ${img}`);
      }
      for (const c of colorRefs) {
        if (!paletteNames.has(c)) warnings.push(`${path} references undefined palette color "${c}".`);
      }
    }

    // required-ish core component presence
    const mustHave = ['boot_animation.json', 'spinner.json'];
    for (const m of mustHave) {
      const hit = componentFiles.some((p) => p.endsWith('/' + m));
      if (!hit) warnings.push(`No "${m}" component found (boot animation / spinner).`);
    }

    if (!model.listAssets().length) warnings.push('No assets found — theme will be blank.');

    return { errors, warnings };
  }
};

if (typeof window !== 'undefined') window.Validators = Validators;
