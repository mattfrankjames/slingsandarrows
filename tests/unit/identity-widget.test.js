/**
 * The widget is loaded on demand now. These cover the decision of *whether* to
 * load it, because getting that wrong is silent in both directions: load it
 * always and every page pays 481ms for nothing; load it never and an emailed
 * confirmation link does nothing at all, leaving an account unconfirmed and a
 * later sign-in failing with "email is not verified".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

async function freshModule() {
  vi.resetModules();
  return import('../../src/core/js/identity-widget.js');
}

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'https://example.test', hash: '' } });
});

describe('hasIdentityToken', () => {
  it('recognises every token an Identity email can carry', async () => {
    const { hasIdentityToken } = await freshModule();
    for (const hash of [
      '#confirmation_token=abc',
      '#recovery_token=abc',
      '#invite_token=abc',
      '#email_change_token=abc',
    ]) {
      expect(hasIdentityToken(hash), hash).toBe(true);
    }
  });

  it('recognises a token that is not the first fragment', async () => {
    // Netlify has shipped links shaped both ways.
    const { hasIdentityToken } = await freshModule();
    expect(hasIdentityToken('#error=x&confirmation_token=abc')).toBe(true);
  });

  it('says no for an ordinary page load', async () => {
    const { hasIdentityToken } = await freshModule();
    expect(hasIdentityToken('')).toBe(false);
    expect(hasIdentityToken('#some-anchor')).toBe(false);
    // The thing this must not do: fire on any hash at all.
    expect(hasIdentityToken('#token')).toBe(false);
  });
});

describe('loadIdentityWidgetIfTokenPresent', () => {
  it('loads nothing on an ordinary page view', async () => {
    const mod = await freshModule();
    const appended = [];
    vi.stubGlobal('document', { head: { appendChild: n => appended.push(n) }, createElement: () => ({ addEventListener() {} }) });

    await mod.loadIdentityWidgetIfTokenPresent();
    expect(appended, 'no script for a page with no token').toEqual([]);
  });

  it('loads the widget when a token is present', async () => {
    const mod = await freshModule();
    window.location.hash = '#confirmation_token=abc';

    const appended = [];
    const script = {
      addEventListener(event, fn) {
        // Resolve as the browser would once the script arrives.
        if (event === 'load') setTimeout(fn, 0);
      },
    };
    vi.stubGlobal('document', { head: { appendChild: n => appended.push(n) }, createElement: () => script });

    await mod.loadIdentityWidgetIfTokenPresent();
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toContain('netlify-identity-widget.js');
    expect(appended[0].async, 'must not block rendering').toBe(true);
  });
});

describe('loadIdentityWidget', () => {
  it('injects the script once however often it is called', async () => {
    const mod = await freshModule();
    const appended = [];
    const script = { addEventListener(e, fn) { if (e === 'load') setTimeout(fn, 0); } };
    vi.stubGlobal('document', { head: { appendChild: n => appended.push(n) }, createElement: () => script });

    await Promise.all([mod.loadIdentityWidget(), mod.loadIdentityWidget(), mod.loadIdentityWidget()]);
    expect(appended).toHaveLength(1);
  });

  /*
   * Ad blockers block this script by name. Every caller was already written
   * against a widget that might be absent, so the promise must settle rather
   * than hang — otherwise "forgot password" spins forever instead of showing
   * the fallback message.
   */
  it('resolves rather than hanging when the script fails to load', async () => {
    const mod = await freshModule();
    const script = { addEventListener(e, fn) { if (e === 'error') setTimeout(fn, 0); } };
    vi.stubGlobal('document', { head: { appendChild() {} }, createElement: () => script });

    await expect(mod.loadIdentityWidget()).resolves.toBeUndefined();
  });
});
