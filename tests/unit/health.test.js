/**
 * The health endpoint, which is the only outside evidence of which backend a
 * deploy is really reading. Its failure mode matters more than its success
 * one: a deploy flagged for Postgres whose database is unreachable must not
 * answer 200 "postgres", or the flag becomes self-certifying.
 *
 * store.mjs is mocked so both branches are reachable without a database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const exists = vi.fn();
const backendName = vi.fn();

vi.mock('../../netlify/lib/store.mjs', () => ({ exists, backendName }));

const call = async () => {
  const handler = (await import('../../netlify/functions/health.mjs')).default;
  const res = await handler(new Request('http://x/api/v1/health'), { params: {} });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

describe('GET /api/v1/health', () => {
  beforeEach(() => {
    exists.mockReset();
    backendName.mockReset();
  });

  it('reports the live backend when it answers', async () => {
    backendName.mockReturnValue('postgres');
    exists.mockResolvedValue(false);

    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, backend: 'postgres' });
  });

  it('names blobs when the flag is off', async () => {
    backendName.mockReturnValue('blobs');
    exists.mockResolvedValue(false);

    expect((await call()).body).toEqual({ ok: true, backend: 'blobs' });
  });

  // The point of the round trip: the flag says postgres, the database does not.
  it('is unhealthy when the flagged backend cannot be read', async () => {
    backendName.mockReturnValue('postgres');
    exists.mockRejectedValue(new Error('ECONNREFUSED'));

    const { status, body } = await call();
    expect(status).toBe(503);
    expect(body).toEqual({ ok: false, backend: 'postgres' });
  });

  it('does not leak the connection error to the caller', async () => {
    backendName.mockReturnValue('postgres');
    exists.mockRejectedValue(new Error('postgres://user:pw@host/db unreachable'));

    expect(JSON.stringify((await call()).body)).not.toMatch(/postgres:\/\//);
  });

  // A cached health check would report the previous deploy's backend.
  it('is never cached', async () => {
    backendName.mockReturnValue('postgres');
    exists.mockResolvedValue(false);

    expect((await call()).headers.get('cache-control')).toBe('no-store');
  });
});
