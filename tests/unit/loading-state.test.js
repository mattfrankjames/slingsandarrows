import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadingIndicator } from '../../src/core/js/lib/loading-state.js';

/** A stand-in for the `<div id="loading" hidden>` the pages ship. */
const element = () => ({ hidden: true });

describe('loadingIndicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /*
   * The case this exists for. Measured on the live feed, a repeat visit fetched
   * /api/v1/posts from the service worker cache in 2ms — and the loader was on
   * screen the whole time anyway, because it shipped visible and was only
   * hidden once the module graph had loaded and the fetch resolved.
   */
  it('never reveals the element when the work finishes quickly', () => {
    const el = element();
    const settled = loadingIndicator(el, 250);

    vi.advanceTimersByTime(2); // the cache hit
    settled();

    vi.advanceTimersByTime(10_000); // and well past the threshold
    expect(el.hidden).toBe(true);
  });

  it('reveals it when the work is genuinely slow', () => {
    const el = element();
    const settled = loadingIndicator(el, 250);

    vi.advanceTimersByTime(249);
    expect(el.hidden, 'still within the threshold').toBe(true);

    vi.advanceTimersByTime(1);
    expect(el.hidden, 'threshold passed, so say something').toBe(false);

    settled();
    expect(el.hidden).toBe(true);
  });

  it('hides an already-revealed element when the work fails', () => {
    // The error paths call the same function; a loader left on screen under an
    // error message is worse than either alone.
    const el = element();
    const settled = loadingIndicator(el, 250);
    vi.advanceTimersByTime(300);
    expect(el.hidden).toBe(false);

    settled();
    expect(el.hidden).toBe(true);
  });

  it('starts from hidden even if the markup forgot the attribute', () => {
    const el = { hidden: false };
    loadingIndicator(el, 250);
    expect(el.hidden, 'armed means hidden until proven slow').toBe(true);
  });

  it('is safe to settle more than once', () => {
    const el = element();
    const settled = loadingIndicator(el, 250);
    settled();
    settled();
    vi.advanceTimersByTime(10_000);
    expect(el.hidden).toBe(true);
  });

  it('tolerates a missing element so call sites need no special case', () => {
    // post-view.js has a path where no fetch happens at all.
    expect(() => loadingIndicator(null)()).not.toThrow();
  });

  it('uses a non-zero default, because zero is the old behaviour', () => {
    const el = element();
    loadingIndicator(el);
    vi.advanceTimersByTime(1);
    expect(el.hidden, 'a default of 0 would reveal immediately').toBe(true);
  });
});
