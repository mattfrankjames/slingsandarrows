/**
 * Phase 0 acceptance check for netlify/lib/auth.mjs.
 *
 * The headline case: a hand-forged token claiming an allowlisted email — the
 * exact attack the old base64-decode helper accepted — must be rejected.
 *
 * GoTrue is stubbed by replacing globalThis.fetch, so this runs offline and
 * asserts on what the module *sends* as well as what it accepts.
 *
 * Run with `npm run verify:auth`. Phase 2 folds these cases into Vitest; until
 * a test runner exists this stays a plain script with no dependencies.
 */
process.env.URL = 'https://example.test';
process.env.ALLOWED_AUTHORS = 'author@band.test, Owner@Band.test';
process.env.ALLOWED_ADMINS = 'admin@band.test';

const { getUser, isAuthor, isAdmin, canModerate } = await import(
  new URL('../netlify/lib/auth.mjs', import.meta.url).href
);

let pass = 0, fail = 0;
const ok = (name, cond) => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.log(`  FAIL ${name}`));

/** Build a syntactically valid JWT with an arbitrary payload and a junk signature. */
function forge(payload) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.not-a-real-signature`;
}

const req = token => new Request('https://example.test/api/x', {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

let calls = [];
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts?.headers?.Authorization });
    return handler();
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ── The vulnerability ────────────────────────────────────────────────────────
console.log('\nForged tokens (the bug this phase fixes)');

stubFetch(() => json({ error: 'unauthorized' }, 401));
const forged = forge({ email: 'author@band.test', sub: '123' });
ok('forged token claiming an allowlisted author is rejected',
  (await getUser(req(forged))) === null);
ok('...and it was checked against Identity, not just decoded',
  calls.length === 1 && calls[0].url === 'https://example.test/.netlify/identity/user');

stubFetch(() => json({ error: 'unauthorized' }, 401));
ok('forged token claiming an admin is rejected',
  (await getUser(req(forge({ email: 'admin@band.test' })))) === null);

// ── Rejection paths ──────────────────────────────────────────────────────────
console.log('\nRejection paths');

stubFetch(() => json({}, 200));
ok('no Authorization header → null, no network call',
  (await getUser(req(null))) === null && calls.length === 0);

stubFetch(() => json({}, 200));
ok('malformed token → null, no network call',
  (await getUser(req('garbage'))) === null && calls.length === 0);

stubFetch(() => { throw new Error('ECONNREFUSED'); });
ok('Identity unreachable → fails closed',
  (await getUser(req(forge({ email: 'author@band.test' })))) === null);

stubFetch(() => json({ id: 'u1' }, 200));
ok('valid response with no email → null',
  (await getUser(req(forge({ email: 'x@y.test' })))) === null);

// ── The happy path ───────────────────────────────────────────────────────────
console.log('\nAccepted tokens');

const good = forge({ email: 'author@band.test' });
stubFetch(() => json({ id: 'u1', email: 'author@band.test', app_metadata: { roles: ['editor'] } }));
const user = await getUser(req(good));
ok('Identity-confirmed token resolves to a user', user?.email === 'author@band.test');
ok('roles are carried through', user?.roles?.[0] === 'editor');
ok('the bearer token was forwarded to Identity', calls[0].auth === `Bearer ${good}`);

// ── Cache ────────────────────────────────────────────────────────────────────
console.log('\nCaching');

stubFetch(() => json({ id: 'u9', email: 'nobody@band.test' }));
const second = await getUser(req(good));
ok('a repeat call is served from cache, not re-verified', calls.length === 0);
ok('cached identity is the original one', second?.email === 'author@band.test');

stubFetch(() => json({ error: 'unauthorized' }, 401));
await getUser(req(forge({ email: 'author@band.test', jti: 'distinct' })));
const before = calls.length;
await getUser(req(forge({ email: 'author@band.test', jti: 'distinct' })));
ok('rejections are never cached — each attempt is re-checked', calls.length === before + 1);

// ── Identity URL resolution ──────────────────────────────────────────────────
console.log('\nIdentity URL resolution');

process.env.IDENTITY_URL = 'https://override.test/.netlify/identity';
stubFetch(() => json({ email: 'a@b.test' }));
await getUser(req(forge({ email: 'a@b.test', jti: 'url-1' })));
ok('IDENTITY_URL wins when set',
  calls[0].url === 'https://override.test/.netlify/identity/user');

delete process.env.IDENTITY_URL;
stubFetch(() => json({ email: 'a@b.test' }));
await getUser(req(forge({ email: 'a@b.test', jti: 'url-2' })));
ok('falls back to URL', calls[0].url === 'https://example.test/.netlify/identity/user');

// With neither variable set, the request's own origin has to carry it —
// otherwise a missing env var would take down every authenticated endpoint.
delete process.env.URL;
stubFetch(() => json({ email: 'a@b.test' }));
await getUser(new Request('https://deploy-preview-7.example.test/api/x', {
  headers: { Authorization: `Bearer ${forge({ email: 'a@b.test', jti: 'url-3' })}` },
}));
ok('falls back to the request origin when no env var is set',
  calls[0].url === 'https://deploy-preview-7.example.test/.netlify/identity/user');
process.env.URL = 'https://example.test';

// ── Allowlists ───────────────────────────────────────────────────────────────
console.log('\nAllowlists');

ok('listed author passes isAuthor', isAuthor({ email: 'author@band.test' }));
ok('author match is case-insensitive', isAuthor({ email: 'OWNER@band.TEST' }));
ok('unlisted email fails isAuthor', !isAuthor({ email: 'stranger@band.test' }));
ok('null user fails isAuthor', !isAuthor(null));
ok('listed admin passes isAdmin', isAdmin({ email: 'admin@band.test' }));
ok('an author is not automatically an admin', !isAdmin({ email: 'author@band.test' }));
ok('owner may moderate their own content',
  canModerate({ email: 'stranger@band.test' }, 'stranger@band.test'));
ok('owner match is case-insensitive',
  canModerate({ email: 'Stranger@Band.test' }, 'stranger@band.test'));
ok('admin may moderate anyone', canModerate({ email: 'admin@band.test' }, 'stranger@band.test'));
ok('a stranger may not moderate someone else',
  !canModerate({ email: 'stranger@band.test' }, 'someone@band.test'));

// ── ALLOWED_ADMINS fallback ──────────────────────────────────────────────────
console.log('\nALLOWED_ADMINS fallback');
delete process.env.ALLOWED_ADMINS;
ok('falls back to the author list when unset', isAdmin({ email: 'author@band.test' }));
process.env.ALLOWED_AUTHORS = '';
ok('empty allowlists deny everyone', !isAdmin({ email: 'author@band.test' }));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
