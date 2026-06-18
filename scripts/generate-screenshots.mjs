/**
 * Generates placeholder screenshot PNGs for the PWA manifest.
 * These are simple dark-background images with centered text that indicate
 * they are placeholders — replace with real screenshots before shipping.
 */

import { createWriteStream, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = join(__dirname, '..', 'src', 'images');

mkdirSync(OUT_DIR, { recursive: true });

// ─── Minimal PNG encoder (same as generate-icons.mjs) ────────────────────────

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

function encodePNG(width, height, pixels) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      raw[dst]     = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Draw a solid-colour screenshot placeholder ───────────────────────────────

function drawSolid(width, height, r, g, b) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4]     = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

// ─── Generate ─────────────────────────────────────────────────────────────────

const specs = [
  { name: 'screenshot-narrow.png', w: 540,  h: 720  },
  { name: 'screenshot-wide.png',   w: 1280, h: 720  },
];

for (const { name, w, h } of specs) {
  // Dark background matching the app theme (#0d0d0d to avoid pure-black artefacts)
  const pixels = drawSolid(w, h, 13, 13, 13);
  const png    = encodePNG(w, h, pixels);
  const dest   = join(OUT_DIR, name);

  const ws = createWriteStream(dest);
  ws.write(png);
  ws.end();
  console.log(`✓ ${name}  (${w}×${h}, ${png.length} bytes)`);
}
