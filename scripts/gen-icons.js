#!/usr/bin/env node
/**
 * Generates icon-192.png, icon-512.png, and icon-maskable-512.png
 * using only Node.js built-ins (zlib + raw PNG construction).
 *
 * Icon design: black background, white asterisk (*) centred.
 * Maskable variant adds a safe-zone padding (~10 %) so the glyph
 * sits inside the "safe area" on all platforms.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ─── PNG helpers ─────────────────────────────────────────────────────────── */

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len       = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput  = Buffer.concat([typeBytes, data]);
  const crcBuf    = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function buildPNG(width, height, pixelFn) {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 2;   // colour type: RGB
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  // Raw scanlines: filter byte (0x00) + R G B per pixel
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ─── Rasterise a single character with a hand-drawn bitmap ──────────────── */
// We use a simple signed-distance-field approach: render the glyph as a
// circle (the asterisk * has a roughly circular envelope) with six spokes.
// This avoids any font-rendering dependency while still looking clean at 192+.

function asteriskSDF(nx, ny) {
  // nx, ny are normalised coordinates in [-1, 1]
  const cx = nx, cy = ny;
  const r  = Math.hypot(cx, cy);

  // Centre dot
  if (r < 0.09) return true;

  // Six spokes at 0°, 60°, 120°, 180°, 240°, 300°
  const angles = [0, 60, 120, 180, 240, 300].map(d => d * Math.PI / 180);
  const spokeW = 0.07;  // half-width of each spoke in normalised units
  const spokeL = 0.55;  // spoke length

  for (const a of angles) {
    const dx = Math.cos(a), dy = Math.sin(a);
    // Project (cx, cy) onto the spoke direction
    const proj  = cx * dx + cy * dy;
    const perp  = Math.abs(-cx * dy + cy * dx);
    if (proj >= 0 && proj <= spokeL && perp < spokeW) return true;
  }

  return false;
}

function makePixelFn(size, padding) {
  return function(x, y) {
    // Map pixel to normalised [-1, 1] with padding
    const usable = size - 2 * padding;
    const nx = ((x - padding) / usable) * 2 - 1;
    const ny = ((y - padding) / usable) * 2 - 1;

    if (asteriskSDF(nx, ny)) return [255, 255, 255]; // white glyph
    return [0, 0, 0];                                 // black background
  };
}

/* ─── Write icons ─────────────────────────────────────────────────────────── */

const outDir = path.join(__dirname, '..', 'src', 'images');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [
  { size: 192, padding: 20,  name: 'icon-192.png' },
  { size: 512, padding: 52,  name: 'icon-512.png' },
  // Maskable: extra padding so glyph clears the safe zone (centre 80 %)
  { size: 512, padding: 100, name: 'icon-maskable-512.png' },
];

for (const { size, padding, name } of sizes) {
  const png = buildPNG(size, size, makePixelFn(size, padding));
  const dest = path.join(outDir, name);
  fs.writeFileSync(dest, png);
  console.log(`✓ ${name}  (${size}×${size}, ${png.length} bytes)`);
}

console.log('Icons generated successfully.');
