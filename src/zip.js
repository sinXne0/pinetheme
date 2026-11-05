// Minimal ZIP read/write with zero dependencies.
// - Writing: STORE (no compression) — PNGs are already compressed.
// - Reading: STORE + DEFLATE (via the browser's DecompressionStream).
const Zip = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8');

  const BINARY_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif',
    '.raw', '.rgb', '.ttf', '.otf', '.woff', '.woff2', '.bin', '.wav',
    '.mp3', '.ogg', '.mid', '.rtttl', '.so', '.ko', '.gz', '.zip'
  ]);

  function isBinaryName(p) {
    return BINARY_EXT.has(('.' + p.split('.').pop()).toLowerCase());
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- CRC32 --------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function ui8(x) {
    return x instanceof Uint8Array ? x : new Uint8Array(x);
  }

  // ---- Write --------------------------------------------------------------
  // files: [{ path, base64 }]
  function build(files) {
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    const localChunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.path);
      const data = base64ToBytes(f.base64);
      const crc = crc32(data);
      const size = data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // UTF-8 names
      lh.setUint16(8, 0, true);      // store
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);

      localChunks.push(ui8(lh.buffer), nameBytes, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);

      centralChunks.push(ui8(ch.buffer), nameBytes);
      offset += 30 + nameBytes.length + size;
    }

    let centralSize = 0;
    for (const c of centralChunks) centralSize += c.byteLength;

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);
    eocd.setUint16(20, 0, true);

    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let pos = 0;
    const put = (arr) => {
      out.set(arr, pos);
      pos += arr.byteLength;
    };
    for (const c of localChunks) put(c);
    for (const c of centralChunks) put(c);
    put(ui8(eocd.buffer));

    return bytesToBase64(out);
  }

  // ---- Read ---------------------------------------------------------------
  async function parse(base64) {
    const bytes = base64ToBytes(base64);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let eocd = -1;
    const min = Math.max(0, bytes.length - 22 - 65536);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP archive');

    const count = dv.getUint16(eocd + 10, true);
    let pos = dv.getUint32(eocd + 16, true);
    const files = [];

    for (let n = 0; n < count; n++) {
      if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error('Corrupt central directory');
      const method = dv.getUint16(pos + 10, true);
      const csize = dv.getUint32(pos + 20, true);
      const nameLen = dv.getUint16(pos + 28, true);
      const extraLen = dv.getUint16(pos + 30, true);
      const commentLen = dv.getUint16(pos + 32, true);
      const localOffset = dv.getUint32(pos + 42, true);
      const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/')) continue;

      const lNameLen = dv.getUint16(localOffset + 26, true);
      const lExtraLen = dv.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const compressed = bytes.subarray(dataStart, dataStart + csize);

      let data;
      if (method === 0) {
        data = compressed;
      } else if (method === 8) {
        const stream = new Blob([compressed])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        const ab = await new Response(stream).arrayBuffer();
        data = new Uint8Array(ab);
      } else {
        throw new Error('Unsupported compression method ' + method + ' for ' + name);
      }

      files.push({ path: name, base64: bytesToBase64(data), binary: isBinaryName(name) });
    }

    return { files };
  }

  return { build, parse, isBinaryName, bytesToBase64, base64ToBytes, crc32 };
})();

if (typeof window !== 'undefined') window.Zip = Zip;
