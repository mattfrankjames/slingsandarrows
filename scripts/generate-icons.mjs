/**
 * Generates PNG icons for the PWA manifest using only the Node.js built-ins
 * available in the project (no extra dependencies needed beyond what's already
 * installed).
 *
 * The icon design mirrors the SVG favicon: a dark radial-gradient background
 * with two stacked chevrons rendered in a cyan/magenta chromatic-aberration
 * style, topped with a near-white layer and a soft glow pass.
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
 * Encode an RGBA pixel array (Float32Array accumulator → clamped Uint8Array)
 * to a PNG Buffer.
 */
function encodePNG(width, height, pixels) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      raw[dst]     = Math.min(255, Math.max(0, Math.round(pixels[src])));
      raw[dst + 1] = Math.min(255, Math.max(0, Math.round(pixels[src + 1])));
      raw[dst + 2] = Math.min(255, Math.max(0, Math.round(pixels[src + 2])));
      raw[dst + 3] = Math.min(255, Math.max(0, Math.round(pixels[src + 3])));
    }
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────

/**
 * Blend a premultiplied RGBA colour onto the accumulation buffer at (x,y)
 * using standard "over" compositing.
 *
 * @param {Float32Array} buf
 * @param {number} width
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a  0–255
 */
function blendPixel(buf, width, x, y, r, g, b, a) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= width || yi < 0 || yi >= width) return;
  const idx  = (yi * width + xi) * 4;
  const srcA = a / 255;
  const dstA = buf[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA === 0) return;
  buf[idx]     = (r * srcA + buf[idx]     * dstA * (1 - srcA)) / outA;
  buf[idx + 1] = (g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA;
  buf[idx + 2] = (b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA;
  buf[idx + 3] = outA * 255;
}

/**
 * Draw a thick anti-aliased line segment from (x0,y0) to (x1,y1).
 *
 * @param {Float32Array} buf
 * @param {number} size    canvas size (square)
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number} r,g,b   colour 0–255
 * @param {number} alpha   overall opacity 0–1
 * @param {number} width   stroke width in pixels
 */
function drawLine(buf, size, x0, y0, x1, y1, r, g, b, alpha, strokeWidth) {
  const dx    = x1 - x0;
  const dy    = y1 - y0;
  const len   = Math.hypot(dx, dy);
  if (len === 0) return;
  // Unit tangent and normal
  const tx = dx / len;
  const ty = dy / len;
  const nx = -ty;
  const ny =  tx;

  const steps = Math.ceil(len * 2);
  const half  = strokeWidth / 2;

  for (let s = 0; s <= steps; s++) {
    const t  = s / steps;
    const cx = x0 + tx * len * t;
    const cy = y0 + ty * len * t;

    // Perpendicular sweep
    for (let w = -half; w <= half; w += 0.5) {
      const px = cx + nx * w;
      const py = cy + ny * w;

      // Simple distance-to-stroke-edge anti-aliasing
      const dist  = Math.abs(w);
      const edge  = half - dist;
      const aa    = Math.min(1, edge + 0.5);
      const finalA = alpha * aa * 255;

      blendPixel(buf, size, px, py, r, g, b, finalA);
    }
  }
}

/**
 * Draw a polyline (array of [x,y] points) with the given style.
 */
function drawPolyline(buf, size, points, r, g, b, alpha, strokeWidth) {
  for (let i = 0; i < points.length - 1; i++) {
    drawLine(buf, size, points[i][0], points[i][1],
             points[i + 1][0], points[i + 1][1],
             r, g, b, alpha, strokeWidth);
  }
}

// ─── Gaussian blur (for the glow layer) ──────────────────────────────────────

function gaussianBlur(src, width, height, radius) {
  const dst  = new Float32Array(src.length);
  const kern = [];
  const r    = Math.ceil(radius * 2.5);
  let   sum  = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * radius * radius));
    kern.push(v);
    sum += v;
  }
  for (let i = 0; i < kern.length; i++) kern[i] /= sum;

  // Horizontal pass
  const tmp = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let accR = 0, accG = 0, accB = 0, accA = 0;
      for (let k = 0; k < kern.length; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k - r));
        const idx = (y * width + sx) * 4;
        accR += src[idx]     * kern[k];
        accG += src[idx + 1] * kern[k];
        accB += src[idx + 2] * kern[k];
        accA += src[idx + 3] * kern[k];
      }
      const idx = (y * width + x) * 4;
      tmp[idx] = accR; tmp[idx+1] = accG; tmp[idx+2] = accB; tmp[idx+3] = accA;
    }
  }
  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let accR = 0, accG = 0, accB = 0, accA = 0;
      for (let k = 0; k < kern.length; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k - r));
        const idx = (sy * width + x) * 4;
        accR += tmp[idx]     * kern[k];
        accG += tmp[idx + 1] * kern[k];
        accB += tmp[idx + 2] * kern[k];
        accA += tmp[idx + 3] * kern[k];
      }
      const idx = (y * width + x) * 4;
      dst[idx] = accR; dst[idx+1] = accG; dst[idx+2] = accB; dst[idx+3] = accA;
    }
  }
  return dst;
}

// ─── Icon drawing ─────────────────────────────────────────────────────────────

/**
 * The SVG design uses a 100×100 coordinate space.  We scale all coordinates
 * to the target `size`.
 *
 * SVG chevron points (in the 100×100 space):
 *   upper chevron: 24,66 → 50,30 → 76,66
 *   lower chevron: 24,90 → 50,54 → 76,90
 *
 * Layers (back to front):
 *   1. Background — dark radial gradient (#1a1030 → #0a0714)
 *   2. Cyan offset  translate(-2.6,0)  #2fe6ff  opacity 0.85
 *   3. Magenta offset translate(2.6,0) #ff2fb9  opacity 0.85
 *   4. Glow layer (blurred white)       #f7f2ff  opacity 0.55
 *   5. White top layer                  #f7f2ff  opacity 1.0
 *
 * @param {number} size       canvas size in pixels
 * @param {boolean} maskable  if true, add 10% safe-zone padding
 */
function drawIcon(size, maskable = false) {
  const buf = new Float32Array(size * size * 4);

  // ── 1. Background: radial gradient ────────────────────────────────────────
  // Centre of gradient is at cx=50%, cy=38%, radius=72% of the canvas diagonal
  const gcx = size * 0.5;
  const gcy = size * 0.38;
  const gr  = size * 0.72;

  // Inner colour #1a1030 → outer colour #0a0714
  const innerR = 0x1a, innerG = 0x10, innerB = 0x30;
  const outerR = 0x0a, outerG = 0x07, outerB = 0x14;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - gcx, y - gcy);
      const t    = Math.min(1, dist / gr);
      const idx  = (y * size + x) * 4;
      buf[idx]     = innerR + (outerR - innerR) * t;
      buf[idx + 1] = innerG + (outerG - innerG) * t;
      buf[idx + 2] = innerB + (outerB - innerB) * t;
      buf[idx + 3] = 255;
    }
  }

  // ── Coordinate mapping ────────────────────────────────────────────────────
  // The SVG viewBox is 0 0 100 100.  We also apply an optional safe-zone pad.
  const pad   = maskable ? size * 0.10 : 0;
  const scale = (size - pad * 2) / 100;
  const off   = pad;

  function sx(v) { return v * scale + off; }
  function sy(v) { return v * scale + off; }

  // Stroke width: SVG uses 11 in a 100-unit space
  const sw = 11 * scale;

  // Chevron point sets (SVG coords)
  const upper = [[24, 66], [50, 30], [76, 66]];
  const lower = [[24, 90], [50, 54], [76, 90]];

  function toPixels(pts, dx = 0, dy = 0) {
    return pts.map(([x, y]) => [sx(x) + dx * scale, sy(y) + dy * scale]);
  }

  // ── 2. Cyan layer  (translate -2.6,0) ─────────────────────────────────────
  drawPolyline(buf, size, toPixels(upper, -2.6), 0x2f, 0xe6, 0xff, 0.85, sw);
  drawPolyline(buf, size, toPixels(lower, -2.6), 0x2f, 0xe6, 0xff, 0.85, sw);

  // ── 3. Magenta layer (translate +2.6,0) ───────────────────────────────────
  drawPolyline(buf, size, toPixels(upper,  2.6), 0xff, 0x2f, 0xb9, 0.85, sw);
  drawPolyline(buf, size, toPixels(lower,  2.6), 0xff, 0x2f, 0xb9, 0.85, sw);

  // ── 4. Glow layer — draw white chevrons onto a temp buffer, blur, composite
  const glowBuf = new Float32Array(size * size * 4);
  drawPolyline(glowBuf, size, toPixels(upper), 0xf7, 0xf2, 0xff, 1.0, sw);
  drawPolyline(glowBuf, size, toPixels(lower), 0xf7, 0xf2, 0xff, 1.0, sw);

  const blurRadius = 1.6 * scale;
  const blurred    = gaussianBlur(glowBuf, size, size, blurRadius);

  // Composite blurred glow at 0.55 opacity over buf
  for (let i = 0; i < size * size; i++) {
    const idx  = i * 4;
    const srcA = (blurred[idx + 3] / 255) * 0.55;
    const dstA =  buf[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) continue;
    buf[idx]     = (blurred[idx]     * srcA + buf[idx]     * dstA * (1 - srcA)) / outA;
    buf[idx + 1] = (blurred[idx + 1] * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA;
    buf[idx + 2] = (blurred[idx + 2] * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA;
    buf[idx + 3] = outA * 255;
  }

  // ── 5. White top layer ────────────────────────────────────────────────────
  drawPolyline(buf, size, toPixels(upper), 0xf7, 0xf2, 0xff, 1.0, sw);
  drawPolyline(buf, size, toPixels(lower), 0xf7, 0xf2, 0xff, 1.0, sw);

  return buf;
}

// ─── Generate all icon variants ───────────────────────────────────────────────

const specs = [
  { name: 'icon-192.png',          size: 192, maskable: false },
  { name: 'icon-512.png',          size: 512, maskable: false },
  { name: 'icon-maskable-192.png', size: 192, maskable: true  },
  { name: 'icon-maskable-512.png', size: 512, maskable: true  },
];

for (const spec of specs) {
  const pixels = drawIcon(spec.size, spec.maskable);
  const png    = encodePNG(spec.size, spec.size, pixels);
  const dest   = join(OUT_DIR, spec.name);

  const ws = createWriteStream(dest);
  ws.write(png);
  ws.end();
  console.log(`✓ ${spec.name}  (${png.length} bytes)`);
}
