/**
 * generate-icons.mjs
 * Writes minimal valid PNG icons for the PWA manifest.
 * Uses only Node built-ins — no native dependencies required.
 *
 * Output:
 *   src/images/icon-192.png          (black bg, white *)
 *   src/images/icon-192-maskable.png (black bg, white * with safe-zone padding)
 *   src/images/icon-512.png
 *   src/images/icon-512-maskable.png
 *   src/images/screenshot-540.png   (placeholder — narrow)
 *   src/images/screenshot-1280.png  (placeholder — wide)
 */

import { createWriteStream } from 'fs';
import { deflateSync }        from 'zlib';
import { join, dirname }      from 'path';
import { fileURLToPath }      from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'src', 'images');

// ── Tiny pure-JS PNG encoder ──────────────────────────────────────────────────

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crcBuf = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4); crcVal.writeUInt32BE(crc32(crcBuf));
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

/**
 * Build a PNG from a pixel callback.
 * @param {number} w
 * @param {number} h
 * @param {(x:number,y:number)=>[number,number,number,number]} getPixel  RGBA
 */
function buildPNG(w, h, getPixel) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 2;  // colour type: RGB  (we'll use RGBA → type 6)
  ihdr[9]  = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw image data — one filter byte per row then RGBA pixels
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter type None
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const off = y * (1 + w * 4) + 1 + x * 4;
      raw[off]   = r;
      raw[off+1] = g;
      raw[off+2] = b;
      raw[off+3] = a;
    }
  }

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon pixel logic ──────────────────────────────────────────────────────────

/**
 * Draw a filled circle (for the * dot / asterisk approximation).
 * We render a simple asterisk as 6 lines radiating from centre.
 */
function iconPixel(x, y, size, padding) {
  const cx = size / 2, cy = size / 2;
  const r  = size / 2 - padding;

  // Normalise to [-1, 1]
  const nx = (x - cx) / r;
  const ny = (y - cy) / r;
  const dist = Math.sqrt(nx * nx + ny * ny);

  if (dist > 1) return [0, 0, 0, 255]; // outside circle → black bg

  // Draw 6-pointed asterisk via line distance
  const angles = [0, 60, 120]; // degrees — each produces 2 arms
  const lineWidth = 0.13;

  for (const deg of angles) {
    const rad = (deg * Math.PI) / 180;
    // Project point onto line through origin at angle `rad`
    const proj = Math.abs(nx * Math.sin(rad) - ny * Math.cos(rad));
    if (proj < lineWidth && dist < 0.85) return [255, 255, 255, 255];
  }

  return [0, 0, 0, 255];
}

function makeIconPixel(size, maskable) {
  // Maskable icons need ~10 % safe-zone padding on each side
  const padding = maskable ? size * 0.1 : size * 0.04;
  return (x, y) => iconPixel(x, y, size, padding);
}

// ── Screenshot placeholder ────────────────────────────────────────────────────

function screenshotPixel(x, y, w, h) {
  // Dark gradient with a centred label band
  const cx = w / 2, cy = h / 2;
  const inBand = Math.abs(y - cy) < h * 0.06;
  if (inBand) return [30, 30, 30, 255];
  const t = y / h;
  const v = Math.round(10 + t * 20);
  return [v, v, v, 255];
}

// ── Write files ───────────────────────────────────────────────────────────────

function writePNG(filename, png) {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filename);
    ws.on('finish', resolve);
    ws.on('error', reject);
    ws.end(png);
  });
}

async function main() {
  const jobs = [
    { file: 'icon-192.png',          size: 192, maskable: false },
    { file: 'icon-192-maskable.png', size: 192, maskable: true  },
    { file: 'icon-512.png',          size: 512, maskable: false },
    { file: 'icon-512-maskable.png', size: 512, maskable: true  },
  ];

  for (const { file, size, maskable } of jobs) {
    const png = buildPNG(size, size, makeIconPixel(size, maskable));
    await writePNG(join(OUT, file), png);
    console.log(`✓ ${file}  (${png.length} bytes)`);
  }

  // Screenshots
  const ss = [
    { file: 'screenshot-540.png',  w: 540,  h: 720  },
    { file: 'screenshot-1280.png', w: 1280, h: 720  },
  ];
  for (const { file, w, h } of ss) {
    const png = buildPNG(w, h, (x, y) => screenshotPixel(x, y, w, h));
    await writePNG(join(OUT, file), png);
    console.log(`✓ ${file}  (${png.length} bytes)`);
  }

  console.log('\nAll icons generated.');
}

main().catch(err => { console.error(err); process.exit(1); });
