/**
 * Generates PNG icons for the PWA manifest using only the Node.js built-ins
 * available in the project (no extra dependencies needed beyond what's already
 * installed).  We write minimal valid PNG files by hand — each icon is a
 * solid-black square with a white asterisk rendered as a simple pixel pattern
 * embedded via a hand-crafted PNG binary.
 *
 * Because the project already ships SVG icons that look identical, the PNGs
 * are generated programmatically here so we don't need to check in large
 * binary blobs.  The script is intentionally dependency-free (pure Node.js).
 */

import { createWriteStream, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = join(__dirname, '..', 'src', 'images');

mkdirSync(OUT_DIR, { recursive: true });

// ─── Minimal PNG encoder ──────────────────────────────────────────────────────

function crc32(buf) {
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len       = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput  = Buffer.concat([typeBytes, data]);
  const crc       = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

/**
 * Encode an RGBA pixel array (Uint8Array, width*height*4 bytes) to a PNG Buffer.
 */
function encodePNG(width, height, pixels) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // colour type: RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  // Raw scanlines with filter byte 0 (None) prepended to each row
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      raw[dst]     = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Icon drawing ─────────────────────────────────────────────────────────────

/**
 * Draw a simple asterisk (*) on a square canvas of `size` pixels.
 * Returns a Uint8Array of RGBA values.
 *
 * @param {number} size        - Canvas size in pixels
 * @param {number[]} bg        - Background RGBA [r,g,b,a]
 * @param {number[]} fg        - Foreground RGBA [r,g,b,a]
 * @param {boolean} maskable   - If true, add safe-zone padding (~10 %)
 */
function drawAsterisk(size, bg, fg, maskable = false) {
  const pixels = new Uint8Array(size * size * 4);

  // Fill background
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4]     = bg[0];
    pixels[i * 4 + 1] = bg[1];
    pixels[i * 4 + 2] = bg[2];
    pixels[i * 4 + 3] = bg[3];
  }

  // Asterisk geometry — drawn as 6 lines radiating from center
  const cx = size / 2;
  const cy = size / 2;
  const pad = maskable ? size * 0.15 : size * 0.08;
  const r   = size / 2 - pad;           // outer radius
  const lineW = Math.max(1, size * 0.03); // Much thinner: 3% instead of 6%

  const angles = [0, 30, 60, 90, 120, 150]; // degrees

  function setPixel(x, y) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= size || yi < 0 || yi >= size) return;
    const i = (yi * size + xi) * 4;
    pixels[i]     = fg[0];
    pixels[i + 1] = fg[1];
    pixels[i + 2] = fg[2];
    pixels[i + 3] = fg[3];
  }

  // Draw each arm as a thin line
  for (const deg of angles) {
    const rad = (deg * Math.PI) / 180;
    const dx  = Math.cos(rad);
    const dy  = Math.sin(rad);
    const px  = -dy;
    const py  =  dx;

    const steps = Math.ceil(r * 2);
    for (let s = 0; s <= steps; s++) {
      const t  = (s / steps) * 2 - 1;
      const bx = cx + dx * r * t;
      const by = cy + dy * r * t;

      // Thinner stroke
      const half = lineW / 2;
      for (let w = -half; w <= half; w += 0.33) {
        setPixel(bx + px * w, by + py * w);
      }
    }
  }

  return pixels;
}

// ─── Generate all icon variants ───────────────────────────────────────────────

const specs = [
  { name: 'icon-192.png',          size: 192, maskable: false, bg: [0,0,0,255],   fg: [255,255,255,255] },
  { name: 'icon-512.png',          size: 512, maskable: false, bg: [0,0,0,255],   fg: [255,255,255,255] },
  { name: 'icon-maskable-192.png', size: 192, maskable: true,  bg: [0,0,0,255],   fg: [255,255,255,255] },
  { name: 'icon-maskable-512.png', size: 512, maskable: true,  bg: [0,0,0,255],   fg: [255,255,255,255] },
];

for (const spec of specs) {
  const pixels = drawAsterisk(spec.size, spec.bg, spec.fg, spec.maskable);
  const png    = encodePNG(spec.size, spec.size, pixels);
  const dest   = join(OUT_DIR, spec.name);

  const ws = createWriteStream(dest);
  ws.write(png);
  ws.end();
  console.log(`✓ ${spec.name}  (${png.length} bytes)`);
}
