// Color palette helpers for the Pager theme studio.
// The Pager themes store colors as {r,g,b} objects keyed by name in theme.json.
const Palette = {
  DEFAULT: {
    black: { r: 0, g: 0, b: 0 },
    blue: { r: 106, g: 210, b: 249 },
    red: { r: 250, g: 72, b: 9 },
    dark_red: { r: 110, g: 31, b: 23 },
    yellow: { r: 231, g: 197, b: 74 },
    gray: { r: 128, g: 128, b: 128 },
    green: { r: 42, g: 180, b: 42 },
    dark_green: { r: 2, g: 101, b: 2 },
    disabled_light_gray: { r: 167, g: 167, b: 167 },
    disabled_dark_gray: { r: 61, g: 61, b: 61 },
    medium_gray: { r: 100, g: 100, b: 100 },
    orange: { r: 214, g: 133, b: 39 },
    dark_orange: { r: 142, g: 76, b: 26 },
    light_blue: { r: 156, g: 226, b: 255 },
    cyan: { r: 96, g: 205, b: 205 },
    dark_cyan: { r: 40, g: 120, b: 120 },
    purple: { r: 132, g: 87, b: 162 },
    dark_purple: { r: 77, g: 45, b: 99 },
    magenta: { r: 205, g: 85, b: 155 },
    dark_magenta: { r: 120, g: 45, b: 90 },
    light_green: { r: 110, g: 220, b: 110 },
    olive: { r: 140, g: 135, b: 55 },
    dark_olive: { r: 80, g: 75, b: 30 },
    brown: { r: 120, g: 72, b: 30 },
    tan: { r: 200, g: 170, b: 120 },
    teal: { r: 48, g: 150, b: 140 },
    dark_teal: { r: 20, g: 90, b: 85 },
    navy: { r: 15, g: 35, b: 75 },
    light_yellow: { r: 250, g: 225, b: 120 },
    soft_white: { r: 230, g: 230, b: 220 }
  },

  clamp(v) {
    return Math.max(0, Math.min(255, Math.round(v)));
  },

  toHex(c) {
    if (!c) return '#000000';
    const r = Palette.clamp(c.r || 0);
    const g = Palette.clamp(c.g || 0);
    const b = Palette.clamp(c.b || 0);
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  },

  fromHex(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (/^[0-9a-f]{3}$/i.test(h)) {
      h = h.split('').map((c) => c + c).join('');
    }
    if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  },

  toCss(c) {
    if (typeof c === 'string') return c;
    const x = c || { r: 0, g: 0, b: 0 };
    return `rgb(${Palette.clamp(x.r)}, ${Palette.clamp(x.g)}, ${Palette.clamp(x.b)})`;
  },

  // CSS color with alpha (0-255 input).
  toCssa(c, alpha) {
    const a = alpha == null ? (c && c.a != null ? c.a / 255 : 1) : alpha;
    return `rgba(${Palette.clamp(c.r || 0)}, ${Palette.clamp(c.g || 0)}, ${Palette.clamp(c.b || 0)}, ${a})`;
  },

  // ---- HSL / HSV ---------------------------------------------------------
  toHsl(c) {
    const r = (c.r || 0) / 255, g = (c.g || 0) / 255, b = (c.b || 0) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
        case g: h = ((b - r) / d + 2); break;
        default: h = ((r - g) / d + 4);
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  },

  fromHsl(hsl) {
    let h = ((hsl.h % 360) + 360) % 360 / 360;
    const s = Math.max(0, Math.min(100, hsl.s)) / 100;
    const l = Math.max(0, Math.min(100, hsl.l)) / 100;
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Palette.clamp(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Palette.clamp(hue2rgb(p, q, h) * 255),
      b: Palette.clamp(hue2rgb(p, q, h - 1 / 3) * 255)
    };
  },

  toHsv(c) {
    const r = (c.r || 0) / 255, g = (c.g || 0) / 255, b = (c.b || 0) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
      else if (max === g) h = ((b - r) / d + 2);
      else h = ((r - g) / d + 4);
      h /= 6;
    }
    return { h: h * 360, s: max === 0 ? 0 : d / max * 100, v: max * 100 };
  },

  fromHsv(hsv) {
    const s = Math.max(0, Math.min(100, hsv.s)) / 100;
    const v = Math.max(0, Math.min(100, hsv.v)) / 100;
    const h = ((hsv.h % 360) + 360) % 360;
    const i = Math.floor(h / 60) % 6;
    const f = h / 60 - Math.floor(h / 60);
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
    return { r: Palette.clamp(rgb[0] * 255), g: Palette.clamp(rgb[1] * 255), b: Palette.clamp(rgb[2] * 255) };
  },

  // ---- manipulation ------------------------------------------------------
  mix(a, b, t) {
    const f = Math.max(0, Math.min(1, t));
    return {
      r: Palette.clamp((a.r || 0) + ((b.r || 0) - (a.r || 0)) * f),
      g: Palette.clamp((a.g || 0) + ((b.g || 0) - (a.g || 0)) * f),
      b: Palette.clamp((a.b || 0) + ((b.b || 0) - (a.b || 0)) * f)
    };
  },

  lighten(c, amount) {
    const hsl = Palette.toHsl(c);
    hsl.l = Math.min(100, hsl.l + amount);
    return Palette.fromHsl(hsl);
  },

  darken(c, amount) {
    const hsl = Palette.toHsl(c);
    hsl.l = Math.max(0, hsl.l - amount);
    return Palette.fromHsl(hsl);
  },

  saturate(c, amount) {
    const hsl = Palette.toHsl(c);
    hsl.s = Math.max(0, Math.min(100, hsl.s + amount));
    return Palette.fromHsl(hsl);
  },

  rotate(c, degrees) {
    const hsl = Palette.toHsl(c);
    hsl.h += degrees;
    return Palette.fromHsl(hsl);
  },

  luminance(c) {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  },

  isLight(c) {
    return Palette.luminance(c) > 0.45;
  },

  contrast(a, b) {
    const la = Palette.luminance(a);
    const lb = Palette.luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  },

  // Nearest palette color (Euclidean RGB, weighted for perceived brightness).
  nearest(c, palette) {
    let best = null;
    let bestD = Infinity;
    for (const [name, col] of Object.entries(palette || {})) {
      const dr = (c.r - col.r) * 0.3;
      const dg = (c.g - col.g) * 0.59;
      const db = (c.b - col.b) * 0.11;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = { name, color: col }; }
    }
    return best;
  },

  // Generate harmonized colors around a base color.
  harmonies(base) {
    const hsl = Palette.toHsl(base);
    const make = (dh, ds, dl) => Palette.fromHsl({
      h: hsl.h + dh,
      s: Math.max(0, Math.min(100, hsl.s + (ds || 0))),
      l: Math.max(0, Math.min(100, hsl.l + (dl || 0)))
    });
    return {
      complementary: [base, make(180)],
      split: [base, make(150), make(210)],
      analogous: [make(-40), make(-20), base, make(20), make(40)],
      triadic: [base, make(120), make(240)],
      tetradic: [base, make(90), make(180), make(270)],
      monochrome: [make(0, 0, -30), make(0, 0, -15), base, make(0, 0, 15), make(0, 0, 30)],
      shades: [make(0, 0, -35), make(0, 0, -20), base, make(0, 0, 20), make(0, 0, 35)]
    };
  },

  // Median-cut palette extraction from ImageData.
  extract(imageData, count) {
    const data = imageData && imageData.data;
    if (!data || !data.length) return [];
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (!pixels.length) return [];
    const buckets = [pixels];
    const target = Math.max(2, Math.min(64, count || 8));
    while (buckets.length < target) {
      let idx = -1;
      let bestRange = -1;
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        if (b.length < 2) continue;
        let min = [255, 255, 255], max = [0, 0, 0];
        for (const p of b) {
          for (let c = 0; c < 3; c++) {
            if (p[c] < min[c]) min[c] = p[c];
            if (p[c] > max[c]) max[c] = p[c];
          }
        }
        const range = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
        if (range > bestRange) { bestRange = range; idx = i; }
      }
      if (idx < 0) break;
      const b = buckets[idx];
      let min = [255, 255, 255], max = [0, 0, 0];
      for (const p of b) {
        for (let c = 0; c < 3; c++) {
          if (p[c] < min[c]) min[c] = p[c];
          if (p[c] > max[c]) max[c] = p[c];
        }
      }
      const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const channel = ranges.indexOf(Math.max(...ranges));
      b.sort((p, q) => p[channel] - q[channel]);
      const mid = Math.floor(b.length / 2);
      buckets.splice(idx, 1, b.slice(0, mid), b.slice(mid));
    }
    return buckets
      .filter((b) => b.length)
      .map((b) => {
        let r = 0, g = 0, bl = 0;
        for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
        return {
          r: Math.round(r / b.length),
          g: Math.round(g / b.length),
          b: Math.round(bl / b.length)
        };
      })
      .sort((a, b) => Palette.luminance(b) - Palette.luminance(a));
  },

  // Resolve a palette value that may be a name or a direct RGB object.
  resolve(value, palette) {
    if (value == null) return null;
    if (typeof value === 'string') {
      if (value.startsWith('#')) return Palette.fromHex(value);
      const hit = (palette || {})[value];
      return hit ? { r: hit.r, g: hit.g, b: hit.b } : null;
    }
    if (typeof value === 'object' && Number.isFinite(Number(value.r))) {
      return {
        r: Palette.clamp(Number(value.r)),
        g: Palette.clamp(Number(value.g)),
        b: Palette.clamp(Number(value.b))
      };
    }
    return null;
  }
};

// For the plain-browser fallback (no Electron), expose as global.
if (typeof window !== 'undefined') window.Palette = Palette;
