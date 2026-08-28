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
      // Comments legitimately name these things while explaining why they are
      // absent, so strip them first.
      //
      // Block comments are blanked in place rather than removed, so the line
      // numbers reported below stay accurate — an earlier version only handled
      // comments opening and closing on one line, and read a multi-line one as
      // code.
      //
      // `//` is only stripped from JavaScript. CSS has no line comments, and
      // stripping them there truncated every url(https://…) at the protocol
      // slashes — which silently hid four Cloudinary URLs in the stylesheets.
      const isJs = /\.(js|mjs)$/.test(file);
      let source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '));
      if (isJs) source = source.replace(/\/\/.*$/gm, '');

      source.split('\n').forEach((line, i) => {
        if (pattern.test(line)) {
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
