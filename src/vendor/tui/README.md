# Vendored advanced editor

These files are bundled so PineTheme Studio's advanced image editor works fully
offline. They are not runtime dependencies of the studio's core editor.

- `tui-image-editor.min.js` — Toast UI Image Editor 3.15.3, MIT, NHN Cloud.
  The distribution bundles Fabric.js 4.6.0 (MIT, Printio / Juriy Zaytsev and
  Maxim Chernyak).
- `tui-image-editor.min.css` — Toast UI Image Editor styles.
- `tui-color-picker.min.js` — tui-color-picker 2.2.x, MIT, NHN Cloud.
- `tui-color-picker.min.css` — tui-color-picker styles.

Source: https://github.com/nhn/tui.image-editor and
https://github.com/nhn/tui.color-picker

They are used only by `src/advanced-editor.html`, which runs in an isolated
local iframe. The optional external analytics/logo resources are disabled/hidden;
no network requests are needed.

MIT License

Copyright (c) 2019 - present NHN Cloud Corp.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
