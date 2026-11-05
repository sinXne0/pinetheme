// Default palette from the official "wargames" theme.
// Provides 30 named colors used throughout the Pager UI.
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
    const x = c || { r: 0, g: 0, b: 0 };
    return `rgb(${Palette.clamp(x.r)}, ${Palette.clamp(x.g)}, ${Palette.clamp(x.b)})`;
  },

  // Luminance for choosing readable text on a swatch.
  luminance(c) {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  },

  isLight(c) {
    return Palette.luminance(c) > 0.45;
  }
};

// For the plain-browser fallback (no Electron), expose as global.
if (typeof window !== 'undefined') window.Palette = Palette;
