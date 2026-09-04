/**
 * The flag that decides which database the site reads, and the reason it needs
 * its own test file.
 *
 * `USE_POSTGRES = "true"` sat in netlify.toml's deploy-preview block from the
 * cutover onward and never once took effect: netlify.toml variables live only
 * for the duration of the build, and functions run later in a process that
 * cannot see them. Every preview reported success while serving Blobs. Nothing
 * failed, which is what made it survive — so the resolution order is pinned
 * here rather than left to be re-derived.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '../../scripts/write-build-flags.mjs';

describe('the generated build flag', () => {
  it('is true only for the exact string the build sets', () => {
    expect(render({ USE_POSTGRES: 'true' })).toMatch(/USE_POSTGRES = true;/);
  });

  it('is false when the variable is absent, which is the default deploy', () => {
    expect(render({})).toMatch(/USE_POSTGRES = false;/);
  });

  // Env vars are strings. "false", "0" and "TRUE" are all not-"true", and a
  // truthiness check here would have turned every one of them on.
  it.each(['false', '0', 'TRUE', 'yes', ''])('treats %o as off', value => {
    expect(render({ USE_POSTGRES: value })).toMatch(/USE_POSTGRES = false;/);
  });

  it('emits something valid to import, not a template with holes', () => {
    expect(render({ USE_POSTGRES: 'true' })).not.toMatch(/undefined|\[object/);
  });
});

describe('usingPostgres precedence', () => {
  const original = process.env.USE_POSTGRES;

  /** @param {boolean} baked */
  const load = async baked => {
    vi.resetModules();
    vi.doMock('../../netlify/lib/build-flags.mjs', () => ({ USE_POSTGRES: baked }));
    return import('../../netlify/lib/store.mjs');
  };

  beforeEach(() => {
    delete process.env.USE_POSTGRES;
  });

  afterEach(() => {
    vi.doUnmock('../../netlify/lib/build-flags.mjs');
    if (original === undefined) delete process.env.USE_POSTGRES;
    else process.env.USE_POSTGRES = original;
  });

  // The case that was broken in production: nothing in the runtime environment,
  // and the build is the only thing that knew which context this deploy is.
  it('falls back to the baked value when the environment says nothing', async () => {
    const { usingPostgres, backendName } = await load(true);
    expect(usingPostgres()).toBe(true);
    expect(backendName()).toBe('postgres');
  });

  it('stays on Blobs when the build baked false and nothing overrides it', async () => {
    const { backendName } = await load(false);
    expect(backendName()).toBe('blobs');
  });

  // An explicitly set variable is a decision made now — a test, `netlify dev`,
  // or a UI value added to force a rollback — and beats the build's assumption.
  it('lets the environment turn Postgres on over a false build', async () => {
    const { usingPostgres } = await load(false);
    process.env.USE_POSTGRES = 'true';
    expect(usingPostgres()).toBe(true);
  });

  it('lets the environment roll back a Postgres build without redeploying', async () => {
    const { usingPostgres } = await load(true);
    process.env.USE_POSTGRES = 'false';
    expect(usingPostgres()).toBe(false);
  });

  // Netlify hands an unset UI variable through as "", which must not read as an
  // explicit "no" and silently roll a Postgres deploy back to Blobs.
  it('treats an empty variable as unset, not as off', async () => {
    const { usingPostgres } = await load(true);
    process.env.USE_POSTGRES = '';
    expect(usingPostgres()).toBe(true);
  });

  it('is read per call, so a change does not need a new function instance', async () => {
    const { usingPostgres } = await load(false);
    expect(usingPostgres()).toBe(false);
    process.env.USE_POSTGRES = 'true';
    expect(usingPostgres()).toBe(true);
  });
});
