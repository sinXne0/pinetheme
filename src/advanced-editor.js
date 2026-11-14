// Advanced editor bridge. Runs inside advanced-editor.html (its own sandbox).
(() => {
  let editor = null;

  function createEditor(dataUrl, name) {
    if (editor) {
      editor.loadImageFromURL(dataUrl, name || 'image').then(() => {
        resizeCanvas();
      }).catch((e) => console.error('load failed', e));
      return;
    }
    const holder = document.getElementById('editor');
    holder.innerHTML = '<div id="tui-image-editor"></div>';
    editor = new tui.ImageEditor('#tui-image-editor', {
      includeUI: {
        loadImage: { path: dataUrl, name: name || 'image' },
        initMenu: 'filter',
        menuBarPosition: 'bottom',
        theme: {
          'common.backgroundColor': '#171d18',
          'common.border': '1px solid #2b3a30',
          'common.bi.image': '',
          'common.bisize.width': '0px',
          'common.bisize.height': '0px',
          'header.backgroundColor': '#171d18',
          'header.border': '1px solid #2b3a30',
          'menu.backgroundColor': '#141a15',
          'menu.normalIcon.color': '#8fae9b',
          'menu.activeIcon.color': '#00ff9c',
          'menu.disabledIcon.color': '#3c5044',
          'menu.hoverIcon.color': '#00ff9c',
          'submenu.backgroundColor': '#141a15',
          'submenu.partition.color': '#2b3a30',
          'submenu.normalIcon.color': '#8fae9b',
          'submenu.activeIcon.color': '#00ff9c',
          'submenu.normalLabel.color': '#a9c4b3',
          'submenu.activeLabel.color': '#00ff9c',
          'checkbox.border': '1px solid #3a5144',
          'checkbox.backgroundColor': '#0b100d',
          'range.pointer.color': '#00ff9c',
          'range.bar.color': '#3a5144',
          'range.subbar.color': '#00c878',
          'range.value.color': '#cfe9dc',
          'range.disabledPointer.color': '#3a5144',
          'range.disabledBar.color': '#242f28',
          'range.disabledSubbar.color': '#2b3a30',
          'colorpicker.title.color': '#cfe9dc'
        }
      },
      cssMaxWidth: 1200,
      cssMaxHeight: 780,
      usageStatistics: false
    });
    resizeCanvas();
    setTimeout(() => {
      document.querySelectorAll('.tui-image-editor-header-logo, .tui-image-editor-header-buttons').forEach((el) => {
        el.style.display = 'none';
      });
    }, 100);
  }

  function resizeCanvas() {
    const holder = document.getElementById('editor');
    const stage = holder.querySelector('.tui-image-editor-canvas-container');
    if (!stage) return;
    stage.style.maxWidth = '100%';
  }

  window.addEventListener('message', (e) => {
    const data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'load') {
      createEditor(data.dataUrl, data.name);
    } else if (data.type === 'export') {
      if (!editor) return;
      try {
        const dataUrl = editor.toDataURL({ format: 'png' });
        parent.postMessage({ type: 'result', dataUrl }, '*');
      } catch (err) {
        console.error(err);
        parent.postMessage({ type: 'error', message: String(err && err.message || err) }, '*');
      }
    }
  });

  parent.postMessage({ type: 'ready' }, '*');
})();
