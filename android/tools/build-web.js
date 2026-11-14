#!/usr/bin/env node
/*
 * Assemble the Android web payload:
 *
 *   src/*                     -> build/www/*
 *   android/mobile/bridge.js  -> build/www/bridge.js
 *   android/mobile/mobile.css -> build/www/mobile.css
 *   reference/wargames        -> build/www/reference/wargames-tree.json
 *
 * index.html is patched at build time so the desktop app stays untouched.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.resolve(HERE, '..', 'build', 'www');
const SRC = path.join(ROOT, 'src');
const MOBILE = path.resolve(HERE, '..', 'mobile');

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif',
  '.raw', '.rgb', '.ttf', '.otf', '.woff', '.woff2', '.bin', '.wav',
  '.mp3', '.ogg', '.mid', '.rtttl', '.so', '.ko', '.gz', '.zip', '.svg'
]);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyRecursive(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      if (name === '.DS_Store') continue;
      copyRecursive(path.join(from, name), path.join(to, name));
    }
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function readTree(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d)) {
      if (name === '.git' || name === '.DS_Store' || name === 'node_modules') continue;
      const abs = path.join(d, name);
      const relp = rel ? rel + '/' + name : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        walk(abs, relp);
      } else if (st.isFile()) {
        files.push({
          path: relp,
          base64: fs.readFileSync(abs).toString('base64'),
          binary: BINARY_EXT.has(path.extname(name).toLowerCase())
        });
      }
    }
  };
  walk(dir, '');
  return { name: path.basename(dir), files };
}

function main() {
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // 1. the studio itself
  for (const name of fs.readdirSync(SRC)) {
    if (name === '.DS_Store') continue;
    copyRecursive(path.join(SRC, name), path.join(OUT, name));
  }

  // 2. mobile layer
  fs.copyFileSync(path.join(MOBILE, 'bridge.js'), path.join(OUT, 'bridge.js'));
  fs.copyFileSync(path.join(MOBILE, 'mobile.css'), path.join(OUT, 'mobile.css'));

  // 3. bundled reference theme
  const ref = readTree(path.join(ROOT, 'reference', 'wargames'));
  fs.mkdirSync(path.join(OUT, 'reference'), { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'reference', 'wargames-tree.json'),
    JSON.stringify(ref)
  );

  // 4. patch index.html
  const indexPath = path.join(OUT, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  html = html.replace(
    /<meta name="viewport"[^>]*>/,
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">'
  );
  html = html.replace(
    /<meta charset="utf-8">/,
    '<meta charset="utf-8">\n  <meta name="theme-color" content="#05070a">\n  <meta name="color-scheme" content="dark">'
  );
  html = html.replace(
    /<link rel="stylesheet" href="styles.css">/,
    '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="mobile.css">'
  );
  html = html.replace(
    /<script src="app.js"><\/script>/,
    '<script src="bridge.js"></script>\n  <script src="app.js"></script>'
  );

  if (!html.includes('mobile.css') || !html.includes('bridge.js')) {
    throw new Error('index.html patch failed');
  }

  fs.writeFileSync(indexPath, html);

  const count = (ref.files || []).length;
  console.log('[build-web] www ready: ' + OUT);
  console.log('[build-web] reference theme: ' + count + ' files, ' +
    (fs.statSync(path.join(OUT, 'reference', 'wargames-tree.json')).size / 1024).toFixed(0) + ' KB');
}

main();
