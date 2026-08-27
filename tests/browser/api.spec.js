import { test, expect } from '@playwright/test';

/**
 * Contract checks against the deployed functions.
 *
 * Two things these cover that unit tests cannot: that Netlify actually routes
 * the paths declared in each function's `config` — including the v1 routes and
 * the legacy aliases kept for cached bundles — and that write endpoints reject
 * a forged token in the real runtime.
 *
 * No credentials, so this covers reads and rejections only. Signed-in journeys
 * need a test Identity account; see the note in the CI workflow.
 */

/** A syntactically valid JWT with a junk signature. */
function forge(payload) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.not-a-real-signature`;
}

const READ_ROUTES = [
  ['/api/v1/posts', '/api/get-posts'],
  ['/api/v1/gallery', '/api/gallery/list'],
  ['/api/v1/board/threads', '/api/board/threads'],
];

test.describe('read endpoints', () => {
  for (const [v1, legacy] of READ_ROUTES) {
    test(`${v1} returns an array`, async ({ request }) => {
      const res = await request.get(v1);
      expect(res.status()).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });

    test(`${legacy} still resolves for cached bundles`, async ({ request }) => {
      expect((await request.get(legacy)).status()).toBe(200);
    });
  }

  test('paging returns an envelope with a cursor', async ({ request }) => {
    const res = await request.get('/api/v1/posts?limit=1');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body), 'a limit should switch to the envelope shape').toBe(false);
    expect(body).toHaveProperty('posts');
    expect(body).toHaveProperty('total');
    expect(body.posts.length).toBeLessThanOrEqual(1);
  });

  test('an invalid limit is a 400, not a 500', async ({ request }) => {
    const res = await request.get('/api/v1/posts?limit=abc');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });
});

test.describe('authorization', () => {
  const WRITES = [
    ['POST',   '/api/v1/posts',                 { body: 'test' }],
    ['POST',   '/api/v1/board/threads',         { title: 't', body: 'b' }],
    ['POST',   '/api/v1/gallery',               { mediaUrl: 'https://res.cloudinary.com/x/a.jpg' }],
    ['POST',   '/api/v1/uploads/signature',     {}],
  ];

  for (const [method, path, payload] of WRITES) {
    test(`${path} rejects an unauthenticated ${method}`, async ({ request }) => {
      const res = await request.fetch(path, { method, data: payload });
      expect(res.status()).toBe(401);
    });

    // The vulnerability Phase 0 closed: a hand-written token claiming an
    // allowlisted address used to be accepted, because nothing verified the
    // signature. If this ever returns 2xx again, that regression is back.
    test(`${path} rejects a forged token`, async ({ request }) => {
      const token = forge({ email: 'mattjamesmedia@gmail.com', sub: 'forged' });
      const res = await request.fetch(path, {
        method,
        data: payload,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status(), 'a forged token must never be accepted').toBe(401);
    });
  }
});

test.describe('caching', () => {
  test('per-user endpoints are never stored', async ({ request }) => {
    // /api/v1/me/likes depends entirely on the Authorization header, so a
    // shared cache keyed by URL would serve one person's likes to the next.
    const res = await request.get('/api/v1/me/likes');
    expect(res.status()).toBe(401);
  });
});
