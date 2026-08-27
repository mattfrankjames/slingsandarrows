import { describe, it, expect, vi } from 'vitest';
import { json, HttpError, route, badRequest, notFound, forbidden } from '../../netlify/lib/http.mjs';

const req = (url = 'https://x.test/api/v1/thing') => new Request(url, { method: 'POST' });

describe('json()', () => {
  it('sets the JSON content type', () => {
    expect(json({}).headers.get('Content-Type')).toBe('application/json');
  });

  it('honours status and extra headers', () => {
    const res = json({}, 201, { 'Cache-Control': 'no-store' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serialises the body', async () => {
    expect(await json({ a: 1 }).json()).toEqual({ a: 1 });
  });
});

describe('route()', () => {
  it('passes a successful response through untouched', async () => {
    const res = await route(async () => json({ fine: true }))(req(), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fine: true });
  });

  it('maps an HttpError to its status and message', async () => {
    const res = await route(async () => { throw badRequest('threadId is required'); })(req(), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'threadId is required' });
  });

  it.each([
    ['notFound', notFound(), 404],
    ['forbidden', forbidden(), 403],
  ])('%s carries its own status', async (_name, error, status) => {
    const res = await route(async () => { throw error; })(req(), {});
    expect(res.status).toBe(status);
  });

  // The regression this replaced: every handler ended with
  // `json({ error: err.message }, 500)`, handing internals to the caller.
  it('never leaks an unexpected error message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await route(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.4:5432 password=hunter2');
    })(req(), {});

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain('hunter2');
    expect(body.error).not.toContain('ECONNREFUSED');
    expect(body.error).toBe('Something went wrong. Try again.');

    // ...but it is still logged for us.
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0])).toContain('/api/v1/thing');
  });

  it('treats a thrown non-Error as a 500 too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await route(async () => { throw 'a bare string'; })(req(), {});
    expect(res.status).toBe(500);
  });
});

describe('HttpError', () => {
  it('is an Error with a status', () => {
    const err = new HttpError(418, 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(418);
    expect(err.message).toBe('nope');
  });
});
