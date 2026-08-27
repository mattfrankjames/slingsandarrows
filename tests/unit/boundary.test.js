import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `src/core/` is the part of this codebase that is not about one band.
 *
 * Enforcing that is the cheap half of the template work (see docs — the
 * expensive half is retrofitting the discipline later, which means auditing
 * every file). ESLint stops core importing from site; this stops core
 * *containing* the band, which no import rule can see.
 *
 * It is a real check, not a formality: moving the JS under core/ immediately
 * surfaced three violations — a hardcoded production Identity URL, the band
 * name in a document title, and a licensed Typekit family written into an
 * injected inline style.
 */

const CORE = 'src/core';

/** Every file under a directory, recursively. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const coreFiles = walk(CORE).filter(f => /\.(js|mjs|css)$/.test(f));

/**
 * Things that identify this particular band. A match in core/ means the file
 * would carry Slings & Arrows into anyone else's deployment.
 */
const BAND_SPECIFIC = [
  [/slingsandarrows/i,        'this band\'s domain or handle'],
  [/slings\s*&\s*arrows/i,    'this band\'s name'],
  [/mjtestrun/i,              'this band\'s Cloudinary account'],
  [/mattjamesmedia/i,         'this band\'s contact address'],
  [/use\.typekit\.net|typekit/i, 'a licensed Adobe Fonts kit, which cannot be redistributed'],
  [/fatfrank|ballinger-mono/i,   'a commercial typeface licensed to this account'],
  [/bandcamp\.com/i,          'this band\'s Bandcamp'],
];

describe('src/core stays band-agnostic', () => {
  it('finds files to check', () => {
    expect(coreFiles.length).toBeGreaterThan(10);
  });

  it.each(BAND_SPECIFIC)('contains no %s', (pattern, description) => {
    const offenders = [];

    for (const file of coreFiles) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // Comments may name these while explaining why they are absent.
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (pattern.test(code)) {
          offenders.push(`${relative('.', file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }

    expect(
      offenders.join('\n'),
      `src/core must not contain ${description}. Move it to src/site, or take it from configuration.`
    ).toBe('');
  });
});
