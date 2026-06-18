/**
 * generate-icons.mjs
 * Converts the existing SVG icons to PNG variants required by the manifest.
 * Run once: node scripts/generate-icons.mjs
 */

import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imgDir = resolve(__dirname, '../src/images');

// ── Maskable SVGs (icon inside a safe-zone circle on a solid background) ────
function makeMaskableSvg(size) {
  const pad = Math.round(size * 0.1);   // 10% safe-zone padding
  const r   = Math.round(size / 2);
  const fs  = Math.round(size * 0.55);  // font-size
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="#000000"/>
  <circle cx="${r}" cy="${r}" r="${r - pad}" fill="#111111"/>
  <text x="${r}" y="${r}" dy=".35em" text-anchor="middle" font-size="${fs}" fill="white" font-family="sans-serif">*</text>
</svg>`;
}

const jobs = [
  // Standard PNGs from existing SVGs
  { src: `${imgDir}/icon-192.svg`, out: `${imgDir}/icon-192.png`, size: 192 },
  { src: `${imgDir}/icon-512.svg`, out: `${imgDir}/icon-512.png`, size: 512 },
  // Maskable PNGs (generated inline)
  { svgString: makeMaskableSvg(192), out: `${imgDir}/icon-192-maskable.png`, size: 192 },
  { svgString: makeMaskableSvg(512), out: `${imgDir}/icon-512-maskable.png`, size: 512 },
];

for (const job of jobs) {
  const input = job.svgString
    ? Buffer.from(job.svgString)
    : readFileSync(job.src);

  await sharp(input)
    .resize(job.size, job.size)
    .png()
    .toFile(job.out);

  console.log(`✓ ${job.out}`);
}

console.log('\nAll icons generated.');
