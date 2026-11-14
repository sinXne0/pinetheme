// Theme scaffolding, manifest metadata and starter presets.
// Kept dependency-free so the studio works in Electron and a plain browser.
const ThemeTemplates = {
  SCREEN: { width: 480, height: 222 },

  // Standard Pager asset dimensions, used by Image Lab and asset hints.
  ASSET_PRESETS: [
    { id: 'auto', label: 'Free size', w: 0, h: 0 },
    { id: 'screen', label: 'Full screen · 480×222', w: 480, h: 222 },
    { id: 'icon', label: 'Dashboard icon · 33×29', w: 33, h: 29 },
    { id: 'item_bg', label: 'Menu item bg · 63×62', w: 63, h: 62 },
    { id: 'highlight', label: 'Selection highlight · 71×72', w: 71, h: 72 },
    { id: 'status', label: 'Status bar icon · 20×20', w: 20, h: 20 },
    { id: 'spinner', label: 'Spinner frame · 220×156', w: 220, h: 156 },
    { id: 'dialog', label: 'Dialog background · 400×180', w: 400, h: 180 },
    { id: 'keybg', label: 'Keyboard key · 44×28', w: 44, h: 28 }
  ],

  PRESETS: [
    {
      id: 'wargames',
      name: 'Wargames',
      description: 'The official green/cyan terminal palette.',
      colors: null // uses Palette.DEFAULT
    },
    {
      id: 'amber',
      name: 'Amber CRT',
      description: 'Warm amber phosphor on deep brown-black.',
      colors: {
        black: '#0a0703', blue: '#f2b84b', red: '#ff5a36', dark_red: '#6a1f1a',
        yellow: '#ffd166', gray: '#9a7b4f', green: '#ffb000', dark_green: '#5c3c00',
        disabled_light_gray: '#8a7458', disabled_dark_gray: '#33281c', medium_gray: '#6b5638',
        orange: '#ff9e2c', dark_orange: '#8a4d12', light_blue: '#ffe0a3', cyan: '#ffc96b',
        dark_cyan: '#805a20', purple: '#c78a4a', dark_purple: '#5e3d20', magenta: '#ff7b54',
        dark_magenta: '#7a2f1f', light_green: '#ffe9b0', olive: '#a68a45', dark_olive: '#4a3c1c',
        brown: '#8a5a2b', tan: '#d8b878', teal: '#c49a4a', dark_teal: '#5a421d',
        navy: '#2a1c0c', light_yellow: '#fff1c2', soft_white: '#ffe9c7'
      }
    },
    {
      id: 'cyberpunk',
      name: 'Cyberpunk',
      description: 'Hot magenta and electric cyan on midnight.',
      colors: {
        black: '#05030d', blue: '#21e6ff', red: '#ff2f6d', dark_red: '#6d1030',
        yellow: '#ffe14d', gray: '#7b6a9a', green: '#3dffb0', dark_green: '#075c3a',
        disabled_light_gray: '#8f84a6', disabled_dark_gray: '#2a2340', medium_gray: '#5a4f75',
        orange: '#ff9a3d', dark_orange: '#8a4115', light_blue: '#9ef4ff', cyan: '#22f0e0',
        dark_cyan: '#0a6d6a', purple: '#b14dff', dark_purple: '#4d1b80', magenta: '#ff2fd6',
        dark_magenta: '#801266', light_green: '#b6ffcf', olive: '#9aa63d', dark_olive: '#454d16',
        brown: '#7a4a2a', tan: '#d9b48a', teal: '#1fd6c2', dark_teal: '#0b5e57',
        navy: '#101033', light_yellow: '#fff3a3', soft_white: '#eafcff'
      }
    },
    {
      id: 'gameboy',
      name: 'DMG',
      description: 'Four-shade original Game Boy green.',
      colors: {
        black: '#0f380f', blue: '#8bac0f', red: '#306230', dark_red: '#0f380f',
        yellow: '#9bbc0f', gray: '#8bac0f', green: '#8bac0f', dark_green: '#306230',
        disabled_light_gray: '#9bbc0f', disabled_dark_gray: '#306230', medium_gray: '#8bac0f',
        orange: '#8bac0f', dark_orange: '#306230', light_blue: '#e0f8d0', cyan: '#9bbc0f',
        dark_cyan: '#306230', purple: '#8bac0f', dark_purple: '#0f380f', magenta: '#9bbc0f',
        dark_magenta: '#306230', light_green: '#e0f8d0', olive: '#8bac0f', dark_olive: '#306230',
        brown: '#306230', tan: '#cfe8b0', teal: '#8bac0f', dark_teal: '#306230',
        navy: '#0f380f', light_yellow: '#e0f8d0', soft_white: '#e0f8d0'
      }
    },
    {
      id: 'mono',
      name: 'Mono',
      description: 'High-contrast monochrome for maximum readability.',
      colors: {
        black: '#000000', blue: '#ffffff', red: '#ff3b3b', dark_red: '#7a1010',
        yellow: '#ffe066', gray: '#9a9a9a', green: '#a8ff8f', dark_green: '#1d6b1d',
        disabled_light_gray: '#8c8c8c', disabled_dark_gray: '#3a3a3a', medium_gray: '#666666',
        orange: '#ff9d3b', dark_orange: '#7a4510', light_blue: '#d6f4ff', cyan: '#8ff7f0',
        dark_cyan: '#1f6b66', purple: '#d4a8ff', dark_purple: '#4a2370', magenta: '#ff9de2',
        dark_magenta: '#6b1f5a', light_green: '#d4ffd4', olive: '#b8b46b', dark_olive: '#4a4824',
        brown: '#a0703f', tan: '#e0cbb0', teal: '#7fe0d4', dark_teal: '#246b62',
        navy: '#1a1a33', light_yellow: '#fff5b8', soft_white: '#f2f2f2'
      }
    }
  ],

  TYPE_META: {
    dashboard: { icon: '▦', label: 'Dashboard', folder: 'components/dashboards' },
    list: { icon: '☰', label: 'List / picker', folder: 'components' },
    dialog: { icon: '▭', label: 'Dialog', folder: 'components/dialogs' },
    alert: { icon: '⚠', label: 'Alert', folder: 'components/alerts' },
    statusbar: { icon: '▤', label: 'Status bar', folder: 'components/status_bars' },
    keyboard: { icon: '⌨', label: 'Keyboard', folder: 'components/keyboards' },
    animation: { icon: '◉', label: 'Animation', folder: 'components' },
    text_template: { icon: 'T', label: 'Text template', folder: 'components/templates' },
    toggle_template: { icon: '◑', label: 'Toggle template', folder: 'components/templates' },
    radio_template: { icon: '◉', label: 'Radio template', folder: 'components/templates' },
    signal_template: { icon: '▂▄▆', label: 'Signal template', folder: 'components/templates' },
    splash: { icon: '✦', label: 'Splash / checking', folder: 'components' },
    recon: { icon: '◔', label: 'Recon graph', folder: 'components/dashboards' },
    blank: { icon: '·', label: 'Blank screen', folder: 'components' }
  },

  // ---- component generators ----------------------------------------------
  generate(type, ctx) {
    const palette = ctx.palette || {};
    const colors = Object.keys(palette);
    const pick = (name, fallback) => colors.includes(name) ? name : (fallback || colors[0] || 'soft_white');
    const bg = pick('black', 'black');
    const accent = pick('blue', 'soft_white');
    const accent2 = pick('green', 'soft_white');
    const dim = pick('medium_gray', accent);
    const assets = ctx.assets || [];
    const findAsset = (re) => assets.find((p) => re.test(p)) || null;
    const screenBg = findAsset(/dashboard.*(bg|background)|background.*dashboard|_bg\.png$/i);
    const highlight = findAsset(/highlight/i);
    const itemBg = findAsset(/item_bg/i);
    const dialogBg = findAsset(/dialog.*bg|option.*bg|alert.*bg/i);
    const frames = assets.filter((p) => /boot_animation|spinner|frame|init-\d/i.test(p));

    const textLayer = (text, x, y, color, size) => ({
      text, x, y, text_size: size || 'medium', text_color_palette: color
    });

    const menuItem = (id, x, y, label, target, selected, extraLayers) => {
      const base = [];
      if (itemBg) base.push({ image_path: itemBg, x: 4, y: 5 });
      base.push(textLayer(label, 0, 12, accent, 'medium'));
      if (extraLayers) base.push(...extraLayers);
      const sel = [];
      if (highlight) sel.push({ image_path: highlight, x: 0, y: 0 });
      if (itemBg) sel.push({ image_path: itemBg, x: 4, y: 5, recolor_palette: accent2 });
      sel.push(textLayer(label, 0, 12, pick('yellow', accent2), 'medium'));
      if (extraLayers) sel.push(...extraLayers);
      return { id, x, y, layers: base, selected_layers: sel, target: target || 'back' };
    };

    const background = {
      background_color: palette[bg] ? { r: palette[bg].r, g: palette[bg].g, b: palette[bg].b } : { r: 0, g: 0, b: 0 },
      layers: screenBg ? [{ image_path: screenBg, x: 0, y: 0 }] : []
    };

    const base = {
      screen_name: type,
      windowed_canvas: false,
      cache_canvases: false,
      status_bar: 'default',
      button_map: { a: 'select', b: 'back', up: 'previous', down: 'next', left: 'previous', right: 'next' },
      background
    };

    switch (type) {
      case 'dashboard': {
        const items = [
          menuItem('item1', 60, 40, 'ITEM ONE', 'back'),
          menuItem('item2', 180, 40, 'ITEM TWO', 'back'),
          menuItem('item3', 300, 40, 'ITEM THREE', 'back'),
          menuItem('item4', 60, 120, 'ITEM FOUR', 'back'),
          menuItem('item5', 180, 120, 'ITEM FIVE', 'back'),
          menuItem('item6', 300, 120, 'ITEM SIX', 'back')
        ];
        return Object.assign(base, { menu_items: items });
      }
      case 'list': {
        const rows = [];
        for (let i = 0; i < 5; i++) {
          const y = 30 + i * 36;
          const item = {
            id: 'slot' + i,
            x: 20,
            y,
            layers: [textLayer('$_LIST_ITEM', 100, 6, accent, 'medium')],
            selected_layers: [textLayer('$_LIST_ITEM', 100, 6, pick('yellow', accent), 'medium')],
            target: 'select'
          };
          if (highlight) {
            item.selected_layers.unshift({ image_path: highlight, x: -8, y: -6 });
          }
          rows.push(item);
        }
        return Object.assign(base, {
          pages: [{ page_index: 0, menu_items: rows }],
          list_count: 5
        });
      }
      case 'dialog': {
        return Object.assign(base, {
          windowed_canvas: true,
          cache_canvases: true,
          background: {
            background_color: Palette.fromHex('#000000'),
            layers: dialogBg ? [{ image_path: dialogBg, x: 0, y: 0 }] : []
          },
          pages: [{
            menu_items: [
              {
                id: 'Slot0', x: 60, y: 70,
                layers: [textLayer('$_LIST_ITEM', 60, 6, accent, 'medium')],
                selected_layers: [textLayer('$_LIST_ITEM', 60, 6, pick('yellow', accent), 'medium')],
                target: 'select'
              },
              {
                id: 'Slot1', x: 60, y: 104,
                layers: [textLayer('Option two', 60, 6, accent, 'medium')],
                selected_layers: [textLayer('Option two', 60, 6, pick('yellow', accent), 'medium')],
                target: 'select'
              }
            ]
          }],
          save_cancel_menu: {
            screen_name: 'save_cancel',
            pages: [{
              menu_items: [
                { id: 'Save', x: 400, y: 36, layers: [textLayer('SAVE', 20, 28, accent2, 'small')], selected_layers: [textLayer('SAVE', 20, 28, pick('yellow', accent2), 'small')], target: 'save' },
                { id: 'Cancel', x: 400, y: 80, layers: [textLayer('CANCEL', 20, 28, dim, 'small')], selected_layers: [textLayer('CANCEL', 20, 28, pick('red', dim), 'small')], target: 'back' }
              ]
            }]
          }
        });
      }
      case 'alert': {
        return Object.assign(base, {
          windowed_canvas: true,
          cache_canvases: true,
          background: {
            background_color: Palette.fromHex('#000000'),
            layers: dialogBg ? [{ image_path: dialogBg, x: 0, y: 0 }] : []
          },
          pages: [{
            menu_items: [{
              id: 'ok', x: 180, y: 140,
              layers: [textLayer('OK', 40, 14, accent, 'large')],
              selected_layers: [textLayer('OK', 40, 14, pick('yellow', accent), 'large')],
              target: 'back'
            }]
          }],
          alert_text: 'Something happened.'
        });
      }
      case 'statusbar': {
        return {
          background: {
            cache_canvases: false,
            layers: [],
            background_color: { r: 0, g: 0, b: 0 }
          },
          status_bar_items: {
            Time: { x: 400, y: 7, layers: { default: [] }, recolor_palette: accent },
            Battery: { x: 346, y: 7, layers: { discharging: [], charging_50: [], charged: [] } },
            Volume: { x: 317, y: 5, layers: { mute: [], low: [], medium: [], high: [] } },
            Brightness: { x: 286, y: 5, layers: { '15': [], '50': [], '100': [] } },
            Vibrate: { x: 251, y: 5, layers: { on: [], off: [] } }
          }
        };
      }
      case 'keyboard': {
        const rows = [];
        const keys = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
        const keyBg = findAsset(/_key-bg|key_bg/i);
        keys.forEach((row, r) => {
          rows.push(row.split('').map((ch, i) => {
            const selected = keyBg ? [{ image_path: keyBg }] : [textLayer(ch.toUpperCase(), 14, 7, accent, 'small')];
            return {
              id: ch,
              x: 7 + i * 47 + (r > 1 ? (r - 1) * 20 : 0),
              y: 59 + r * 31,
              layers: keyBg ? [] : [textLayer(ch.toUpperCase(), 14, 7, dim, 'small')],
              selected_layers: selected
            };
          }));
        });
        return {
          input_area: {
            x: 15, y: 16, width: 422, max_characters: 35,
            background: { layers: [] }, per_key_canvas_cache: false
          },
          qwerty: {
            screen_name: 'US_keyboard_qwerty',
            background: {
              background_color: { r: 0, g: 0, b: 0 },
              layers: findAsset(/keyboard.*layout/i) ? [{ image_path: findAsset(/keyboard.*layout/i), x: 0, y: 0 }] : []
            },
            rows
          },
          QWERTY: {
            screen_name: 'US_keyboard_QWERTY',
            background: { background_color: { r: 0, g: 0, b: 0 }, layers: [] },
            rows: rows.map((row) => row.map((k) => Object.assign({}, k)))
          },
          symbols: {
            screen_name: 'symbols',
            background: { background_color: { r: 0, g: 0, b: 0 }, layers: [] },
            rows: [rowForSymbols(0), rowForSymbols(1), rowForSymbols(2)]
          }
        };
        function rowForSymbols(r) {
          return '!@#$%^&*()'.split('').map((ch, i) => ({
            id: ch, x: 7 + i * 47, y: 59 + r * 31, selected_layers: []
          }));
        }
      }
      case 'animation': {
        const chosen = frames.length ? frames.slice(0, 8) : [];
        return {
          animation: {
            frames: chosen.map((p) => ({ image_path: p, x: 0, y: 0 }))
          }
        };
      }
      case 'text_template':
        return { text_size: 'medium', text_color_palette: accent };
      case 'toggle_template': {
        const onAsset = findAsset(/toggle.*on|switch.*on/i);
        const offAsset = findAsset(/toggle.*off|switch.*off/i);
        return {
          enabled: onAsset ? [{ image_path: onAsset, x: 0, y: 0 }] : [textLayer('ON', 0, 0, accent2, 'medium')],
          disabled: offAsset ? [{ image_path: offAsset, x: 0, y: 0 }] : [textLayer('OFF', 0, 0, dim, 'medium')]
        };
      }
      case 'radio_template': {
        const onAsset = findAsset(/radio.*selected|selected.*radio/i);
        const offAsset = findAsset(/radio.*(border|off)/i);
        return {
          enabled: onAsset ? [{ image_path: onAsset, x: 0, y: 0 }] : [textLayer('●', 0, 0, pick('yellow', accent2), 'large')],
          disabled: offAsset ? [{ image_path: offAsset, x: 0, y: 0 }] : [textLayer('○', 0, 0, dim, 'large')]
        };
      }
      case 'signal_template':
        return {
          min_threshold: 0, weak_threshold: 30, strong_threshold: 60, max_threshold: 90,
          minimum_signal: [textLayer('▁', 0, 0, dim, 'medium')],
          weak_signal: [textLayer('▃', 0, 0, accent, 'medium')],
          strong_signal: [textLayer('▅', 0, 0, accent2, 'medium')],
          max_signal: [textLayer('▇', 0, 0, pick('yellow', accent2), 'medium')]
        };
      case 'splash': {
        return {
          background: {
            background_color: Palette.fromHex('#000000'),
            layers: screenBg ? [{ image_path: screenBg, x: 0, y: 0 }] : []
          },
          checking_image_path: frames[0] || '',
          downloading_image_path: frames[1] || '',
          validating_image_path: frames[2] || ''
        };
      }
      case 'recon': {
        return {
          background_path: findAsset(/recon.*dashboard|dashboard.*recon/i) || '',
          graph_width: 45, bar_w: 8, bar_gap: 1,
          x_start: 23, y_top: 92, y_bottom: 178,
          y_label_x: 440, y_label_y: 83, y_half_label_x: 440, y_half_label_y: 132,
          title_x: 20, title_y: 45,
          bar_color_palette: pick('yellow', accent),
          text_color_palette: pick('yellow', accent),
          debug_graph_bounds: false, debug_nice_max_line: false,
          tight_scale_bars: false, use_nice_labels: true,
          target_recon_list: 'recon_list',
          status_bar: 'recon'
        };
      }
      case 'blank':
      default:
        return Object.assign(base, { menu_items: [] });
    }
  },

  templateGallery() {
    return [
      { type: 'dashboard', name: 'Dashboard', desc: 'A 6-item launcher grid with selected states.' },
      { type: 'list', name: 'List / picker', desc: 'A scrollable list using $ _LIST_ITEM.' },
      { type: 'dialog', name: 'Dialog', desc: 'Windowed dialog with option rows and save/cancel.' },
      { type: 'alert', name: 'Alert', desc: 'Simple alert with an OK button.' },
      { type: 'statusbar', name: 'Status bar', desc: 'Time, battery, volume, brightness, vibrate.' },
      { type: 'keyboard', name: 'Keyboard', desc: 'Input area plus qwerty, QWERTY and symbols.' },
      { type: 'animation', name: 'Animation', desc: 'Frame sequence from boot/spinner assets.' },
      { type: 'text_template', name: 'Text template', desc: 'Reusable text style.' },
      { type: 'toggle_template', name: 'Toggle template', desc: 'Enabled/disabled toggle states.' },
      { type: 'radio_template', name: 'Radio template', desc: 'Selected/unselected radio states.' },
      { type: 'signal_template', name: 'Signal template', desc: 'Weak → max signal states.' },
      { type: 'splash', name: 'Splash', desc: 'Checking / downloading / validating images.' },
      { type: 'recon', name: 'Recon graph', desc: 'Recon dashboard graph configuration.' },
      { type: 'blank', name: 'Blank screen', desc: 'An empty screen to build by hand.' }
    ];
  },

  detectType(comp) {
    if (!comp || typeof comp !== 'object') return 'blank';
    if (comp.status_bar_items) return 'statusbar';
    if (comp.input_area) return 'keyboard';
    if (comp.animation) return 'animation';
    if (Array.isArray(comp.enabled) || Array.isArray(comp.disabled)) {
      if (comp.strong_signal || comp.weak_signal) return 'signal_template';
      return comp.min_threshold != null ? 'signal_template' : 'toggle_template';
    }
    if (comp.strong_signal || comp.max_signal) return 'signal_template';
    if (comp.background_path && comp.graph_width) return 'recon';
    if (comp.checking_image_path || comp.downloading_image_path) return 'splash';
    if (comp.template && comp.template.pages) return 'dialog';
    if (comp.save_cancel_menu) return 'dialog';
    if (comp.pages) return 'list';
    if (comp.menu_items) return 'dashboard';
    if (comp.text_size != null && !comp.background) return 'text_template';
    return 'blank';
  },

  typeMeta(comp) {
    const type = ThemeTemplates.detectType(comp);
    return ThemeTemplates.TYPE_META[type] || ThemeTemplates.TYPE_META.blank;
  },

  // Keys in theme.json that point at components/assets.
  PATH_KEYS: [
    'duckyscript_list_picker', 'failsafe_duckyscript_list_picker', 'fallback_menu',
    'pager_portal_payloads_dashboard', 'pager_portal_alert_payload_categories',
    'pager_portal_user_payload_categories', 'pager_portal_recon_payload_categories',
    'pager_portal_installed_payloads_list', 'pager_portal_update_payloads_list',
    'pager_portal_get_payloads_for_category_list', 'launch_payload_dialog_path',
    'payloads_dashboard_path', 'payloads_for_category_list_path', 'payload_log_path',
    'filter_list_path', 'pineap_ssid_pool_list_path', 'pineap_clients_list_path',
    'alerts_dialog_submenu_path', 'low_battery_alert_path', 'critical_battery_alert_path',
    'error_dialog_path', 'alert_dialog_path', 'warning_dialog_path', 'spinner_path',
    'boot_spinner_path', 'keyboard_path', 'number_keyboard_path', 'ip_keyboard_path',
    'mac_keyboard_path', 'recon_payloads_dashboard_path', 'recon_payloads_for_category_list_path',
    'recon_dashboard_path', 'recon_ap_clients_list_path', 'bt_recon_list_path',
    'edit_string_dialog_path', 'edit_ip_dialog_path', 'edit_mac_dialog_path',
    'edit_number_dialog_path', 'confirmation_dialog_path', 'setup_wizard_path',
    'checking_for_updates_path', 'developer_menu_path', 'lock_screen_path',
    'buttons_locked_screen_path', 'device_too_hot_warning_path', 'device_dimming_screen_path',
    'help_info_path', 'license_info_path', 'virtual_pager_info_path'
  ],

  // Human-friendly labels for manifest keys.
  prettyKey(key) {
    return String(key || '')
      .replace(/_path$/i, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  },

  manifestSections(tj) {
    const t = tj || {};
    const comps = (prefix) => {
      return Object.keys(t[prefix] || {});
    };
    return [
      {
        id: 'identity', title: 'Theme identity', icon: '◈', kind: 'fields',
        items: [
          { key: 'theme_name', label: 'Theme name', type: 'text' },
          { key: 'author', label: 'Author', type: 'text' },
          { key: 'theme_version', label: 'Theme version', type: 'text' },
          { key: 'theme_framework_version', label: 'Framework version', type: 'text' }
        ]
      },
      {
        id: 'status_bars', title: 'Status bars', icon: '▤', kind: 'map',
        key: 'status_bars', valueType: 'component',
        note: 'Named status bar components referenced by screens.'
      },
      {
        id: 'generic_menus', title: 'Generic menus & dashboards', icon: '▦', kind: 'map',
        key: 'generic_menus', valueType: 'component',
        note: 'Navigation targets available to menu items.'
      },
      {
        id: 'templates', title: 'Templates', icon: '⧉', kind: 'maps',
        maps: [
          { key: 'string_templates', label: 'Text templates', valueType: 'component' },
          { key: 'toggle_templates', label: 'Toggle templates', valueType: 'component' },
          { key: 'radio_templates', label: 'Radio templates', valueType: 'component' },
          { key: 'signal_templates', label: 'Signal templates', valueType: 'component' }
        ]
      },
      {
        id: 'option_dialogs', title: 'Option dialog variants', icon: '▭', kind: 'map',
        key: 'option_dialogs', valueType: 'component',
        note: 'Named variants used by option pickers.'
      },
      {
        id: 'dialogs', title: 'Dialogs & alerts', icon: '⚠', kind: 'paths',
        keys: ['confirmation_dialog_path', 'error_dialog_path', 'alert_dialog_path',
          'warning_dialog_path', 'edit_string_dialog_path', 'edit_ip_dialog_path',
          'edit_mac_dialog_path', 'edit_number_dialog_path', 'low_battery_alert_path',
          'critical_battery_alert_path', 'alerts_dialog_submenu_path']
      },
      {
        id: 'core', title: 'Core surfaces', icon: '⌂', kind: 'paths',
        keys: ['payloads_dashboard_path', 'payloads_for_category_list_path', 'payload_log_path',
          'launch_payload_dialog_path', 'spinner_path', 'boot_spinner_path', 'setup_wizard_path',
          'checking_for_updates_path', 'developer_menu_path', 'lock_screen_path',
          'buttons_locked_screen_path', 'filter_list_path', 'pineap_ssid_pool_list_path',
          'pineap_clients_list_path', 'duckyscript_list_picker', 'failsafe_duckyscript_list_picker',
          'fallback_menu']
      },
      {
        id: 'recon', title: 'Recon & Bluetooth', icon: '◔', kind: 'paths',
        keys: ['recon_dashboard_path', 'recon_payloads_dashboard_path',
          'recon_payloads_for_category_list_path', 'recon_ap_clients_list_path', 'bt_recon_list_path']
      },
      {
        id: 'recon_lists', title: 'Recon list bindings', icon: '▤', kind: 'map',
        key: 'recon_lists', valueType: 'component',
        note: 'Named recon result list components.'
      },
      {
        id: 'keyboards', title: 'Keyboards', icon: '⌨', kind: 'paths',
        keys: ['keyboard_path', 'number_keyboard_path', 'ip_keyboard_path', 'mac_keyboard_path']
      },
      {
        id: 'portal', title: 'Pager Portal', icon: '◍', kind: 'paths',
        keys: ['pager_portal_payloads_dashboard', 'pager_portal_alert_payload_categories',
          'pager_portal_user_payload_categories', 'pager_portal_recon_payload_categories',
          'pager_portal_installed_payloads_list', 'pager_portal_update_payloads_list',
          'pager_portal_get_payloads_for_category_list']
      },
      {
        id: 'assets', title: 'Theme images', icon: '🖼', kind: 'paths',
        keys: ['device_too_hot_warning_path', 'device_dimming_screen_path',
          'help_info_path', 'license_info_path', 'virtual_pager_info_path']
      }
    ];
  },

  TARGET_SPECIALS: [
    'back', 'cancel', 'close', 'select', 'save', 'noop', 'next_page', 'previous_page',
    'inline_toggle', 'select_menu'
  ],

  componentTargets(tj) {
    const out = [];
    const gm = (tj && tj.generic_menus) || {};
    for (const k of Object.keys(gm)) out.push({ value: k, label: k, path: gm[k] });
    if (tj && tj.status_bars) {
      for (const k of Object.keys(tj.status_bars)) out.push({ value: 'status:' + k, label: 'status · ' + k, path: tj.status_bars[k] });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }
};

if (typeof window !== 'undefined') window.ThemeTemplates = ThemeTemplates;
