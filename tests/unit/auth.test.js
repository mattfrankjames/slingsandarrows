import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// auth.mjs caches verified tokens in module state, so each test needs a fresh
// copy of the module rather than a shared one.
async function loadAuth() {
  vi.resetModules();
  return import('../../netlify/lib/auth.mjs');
}

/** A syntactically valid JWT with an arbitrary payload and a junk signature. */
function forge(payload) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.not-a-real-signature`;
}

const withToken = (token, url = 'https://example.test/api/v1/posts') =>
  new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

const identityReplies = body =>
  vi.fn(async () => new Response(JSON.stringify(body.payload ?? {}), {
    status: body.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  }));

let warn;
beforeEach(() => {
  process.env.URL = 'https://example.test';
  process.env.ALLOWED_AUTHORS = 'author@band.test, Owner@Band.test';
  process.env.ALLOWED_ADMINS = 'admin@band.test';
  warn = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });

describe('getUser — forged tokens', () => {
  // The vulnerability this module exists to close: the old helper base64-decoded
  // the payload and trusted the email, so a hand-written token passed the
  // author and admin allowlists.
  it('rejects a forged token claiming an allowlisted author', async () => {
    const { getUser } = await loadAuth();
    globalThis.fetch = identityReplies({ status: 401 });
    expect(await getUser(withToken(forge({ email: 'author@band.test' })))).toBeNull();
  });

  it('verifies against Identity rather than just decoding', async () => {
    const { getUser } = await loadAuth();
    const fetchSpy = identityReplies({ status: 401 });
    globalThis.fetch = fetchSpy;

    await getUser(withToken(forge({ email: 'author@band.test' })));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.test/.netlify/identity/user');
  });

  it('rejects a forged token claiming an admin', async () => {
    const { getUser } = await loadAuth();
    globalThis.fetch = identityReplies({ status: 401 });
    expect(await getUser(withToken(forge({ email: 'admin@band.test' })))).toBeNull();
  });
});

describe('getUser — rejection paths', () => {
  it.each([
    ['no Authorization header', null],
    ['a malformed token', 'garbage'],
    ['a two-segment token', 'aaa.bbb'],
  ])('returns null for %s without calling Identity', async (_label, token) => {
    const { getUser } = await loadAuth();
    const fetchSpy = identityReplies({ status: 200 });
    globalThis.fetch = fetchSpy;

    expect(await getUser(withToken(token))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed when Identity is unreachable', async () => {
    const { getUser } = await loadAuth();
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await getUser(withToken(forge({ email: 'author@band.test' })))).toBeNull();
  });

  it('rejects a 200 response with no email', async () => {
    const { getUser } = await loadAuth();
    globalThis.fetch = identityReplies({ payload: { id: 'u1' } });
    expect(await getUser(withToken(forge({ email: 'x@y.test' })))).toBeNull();
  });
});

describe('getUser — accepted tokens', () => {
  it('resolves an Identity-confirmed token and forwards the bearer', async () => {
    const { getUser } = await loadAuth();
    const fetchSpy = identityReplies({
      payload: { id: 'u1', email: 'author@band.test', app_metadata: { roles: ['editor'] } },
    });
    globalThis.fetch = fetchSpy;

    const token = forge({ email: 'author@band.test' });
    const user = await getUser(withToken(token));

    expect(user).toMatchObject({ email: 'author@band.test', id: 'u1', roles: ['editor'] });
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
  });
});

describe('getUser — caching', () => {
  it('serves a repeat call from cache', async () => {
    const { getUser } = await loadAuth();
    const fetchSpy = identityReplies({ payload: { email: 'author@band.test' } });
    globalThis.fetch = fetchSpy;

    const req = withToken(forge({ email: 'author@band.test' }));
    await getUser(req);
    await getUser(req);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('never caches a rejection', async () => {
    const { getUser } = await loadAuth();
    const fetchSpy = identityReplies({ status: 401 });
    globalThis.fetch = fetchSpy;

    const req = withToken(forge({ email: 'author@band.test' }));
    await getUser(req);
    await getUser(req);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('getUser — Identity URL resolution', () => {
  const capture = async token => {
    const { getUser } = await loadAuth();
    const fetchSpy = identityReplies({ payload: { email: 'a@b.test' } });
    globalThis.fetch = fetchSpy;
    await getUser(token);
    return fetchSpy.mock.calls[0][0];
  };

  it('uses IDENTITY_URL verbatim when set', async () => {
    process.env.IDENTITY_URL = 'https://override.test/.netlify/identity';
    expect(await capture(withToken(forge({ email: 'a@b.test' }))))
      .toBe('https://override.test/.netlify/identity/user');
    delete process.env.IDENTITY_URL;
  });

  it('appends the Identity path to URL', async () => {
    expect(await capture(withToken(forge({ email: 'a@b.test' }))))
      .toBe('https://example.test/.netlify/identity/user');
  });

  // Without this, a missing env var would take down every write endpoint.
  it('falls back to the request origin when no env var is set', async () => {
    delete process.env.URL;
    const req = withToken(forge({ email: 'a@b.test' }), 'https://deploy-preview-7.netlify.app/api/v1/posts');
    expect(await capture(req)).toBe('https://deploy-preview-7.netlify.app/.netlify/identity/user');
  });
});

describe('allowlists', () => {
  it('admits a listed author', async () => {
    const { isAuthor } = await loadAuth();
    expect(isAuthor({ email: 'author@band.test' })).toBe(true);
  });

  it('matches case-insensitively', async () => {
    const { isAuthor } = await loadAuth();
    expect(isAuthor({ email: 'OWNER@band.TEST' })).toBe(true);
  });

  it.each([
    ['an unlisted address', { email: 'stranger@band.test' }],
    ['a null user', null],
  ])('refuses %s', async (_label, user) => {
    const { isAuthor } = await loadAuth();
    expect(isAuthor(user)).toBe(false);
  });

  it('does not treat an author as an admin', async () => {
    const { isAdmin } = await loadAuth();
    expect(isAdmin({ email: 'author@band.test' })).toBe(false);
  });

  it('falls back to the author list when ALLOWED_ADMINS is unset', async () => {
    delete process.env.ALLOWED_ADMINS;
    const { isAdmin } = await loadAuth();
    expect(isAdmin({ email: 'author@band.test' })).toBe(true);
  });

  it('denies everyone when the allowlists are empty', async () => {
    process.env.ALLOWED_AUTHORS = '';
    delete process.env.ALLOWED_ADMINS;
    const { isAuthor, isAdmin } = await loadAuth();
    expect(isAuthor({ email: 'author@band.test' })).toBe(false);
    expect(isAdmin({ email: 'author@band.test' })).toBe(false);
  });
});

describe('canModerate', () => {
  it('lets an owner remove their own content', async () => {
    const { canModerate } = await loadAuth();
    expect(canModerate({ email: 'stranger@band.test' }, 'stranger@band.test')).toBe(true);
  });

  // The old inline check was `reply.author === user.email`, which could deny
  // someone their own post on a case difference.
  it('matches the owner case-insensitively', async () => {
    const { canModerate } = await loadAuth();
    expect(canModerate({ email: 'Stranger@Band.test' }, 'stranger@band.test')).toBe(true);
  });

  it('lets an admin remove anyone\'s', async () => {
    const { canModerate } = await loadAuth();
    expect(canModerate({ email: 'admin@band.test' }, 'stranger@band.test')).toBe(true);
  });

  it('refuses a stranger', async () => {
    const { canModerate } = await loadAuth();
    expect(canModerate({ email: 'stranger@band.test' }, 'someone@band.test')).toBe(false);
  });
});

describe('require* helpers', () => {
  it('requireUser throws 401 when unauthenticated', async () => {
    const { requireUser } = await loadAuth();
    await expect(requireUser(withToken(null))).rejects.toMatchObject({ status: 401 });
  });

  it('requireAuthor throws 403 for a signed-in non-author', async () => {
    const { requireAuthor } = await loadAuth();
    globalThis.fetch = identityReplies({ payload: { email: 'stranger@band.test' } });
    await expect(requireAuthor(withToken(forge({ email: 'stranger@band.test' }))))
      .rejects.toMatchObject({ status: 403 });
  });

  it('requireAuthor returns the user for a listed author', async () => {
    const { requireAuthor } = await loadAuth();
    globalThis.fetch = identityReplies({ payload: { email: 'author@band.test' } });
    const user = await requireAuthor(withToken(forge({ email: 'author@band.test' })));
    expect(user.email).toBe('author@band.test');
  });

  it('requireModerator throws 403 for someone else\'s content', async () => {
    const { requireModerator } = await loadAuth();
    globalThis.fetch = identityReplies({ payload: { email: 'stranger@band.test' } });
    await expect(requireModerator(withToken(forge({ email: 'stranger@band.test' })), 'other@band.test'))
      .rejects.toMatchObject({ status: 403 });
  });
});
