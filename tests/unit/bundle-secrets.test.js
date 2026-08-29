import { describe, it, expect } from 'vitest';
import { findSecrets } from '../../scripts/check-bundle-secrets.mjs';

/** A JWT with the given claims. The signature is never checked, only the payload. */
const jwt = claims =>
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  Buffer.from(JSON.stringify(claims)).toString('base64url') +
  '.c2lnbmF0dXJl';

describe('bundle secret scanner', () => {
  /*
   * The credential that actually matters now. NETLIFY_DATABASE_URL grants the
   * connecting role everything, and migrations/0001 has no row level security
   * underneath it, so this in a bundle is the whole database.
   */
  it('catches a Postgres connection string with credentials', () => {
    const url = 'postgresql://neondb_owner:npg_S3cr3tPw@ep-cool-frog-123.us-east-2.aws.neon.tech/neondb';
    const hits = findSecrets(`const DB="${url}";`);
    expect(hits).toHaveLength(1);
    // The report must not repeat the password back into CI logs.
    expect(hits[0]).not.toContain('npg_S3cr3tPw');
    expect(hits[0]).toContain('neon.tech');
  });

  it('catches the postgres:// spelling as well as postgresql://', () => {
    expect(findSecrets('a="postgres://u:p@host.tld/db"')).toHaveLength(1);
  });

  /*
   * A check people learn to wave through is worse than no check, so a bare
   * scheme with no credentials in it must not fire — that shape turns up in
   * comments, docs and error messages.
   */
  it('ignores a connection string with no credentials in it', () => {
    expect(findSecrets('// see postgres://localhost/dev for local runs')).toEqual([]);
    expect(findSecrets('const doc="postgresql://host/db";')).toEqual([]);
  });

  it('catches a current-format secret key', () => {
    expect(findSecrets('const k="sb_secret_9xKq2LmNpRtVwZaB3cDeFg";')).toHaveLength(1);
  });

  /*
   * The reason this file exists.
   *
   * A legacy key is a JWT claiming service_role, and the payload is base64url
   * of the claims JSON. base64 encodes in three-byte groups, so the encoding of
   * "service_role" depends on its byte offset within that JSON — the same claim
   * has three different encoded forms. The first version of this check grepped
   * for one of them, passed its own probe, and would have shipped.
   *
   * Shifting the claim order moves the offset, which is what these three cover.
   */
  it('catches a legacy service_role JWT at every base64 alignment', () => {
    // Chosen so the claim lands at byte offset 0, 1 and 2 respectively — the
    // assertion below enforces that, since picking them by eye gets it wrong.
    const shapes = [
      { role: 'service_role', iss: 'supabase', ref: 'abc' },
      { iss: 'supa', role: 'service_role' },
      { iss: 'supabase', role: 'service_role', ref: 'abc' },
    ];

    const offsets = new Set();
    for (const claims of shapes) {
      const json = JSON.stringify(claims);
      offsets.add(json.indexOf('service_role') % 3);
      expect(findSecrets(`const k="${jwt(claims)}";`), json).toHaveLength(1);
    }

    // Guard the guard: if all three shapes happened to share an alignment this
    // test would prove nothing, which is precisely how the first version passed.
    expect(offsets.size, 'shapes must cover distinct base64 alignments').toBe(3);
  });

  // A real key's signature is 43 characters, so this is not a realistic key —
  // but the scanner should not be the thing deciding what counts as one. An
  // earlier version required four or more signature characters and a probe
  // with three passed straight through it.
  it('does not let signature length become a way past it', () => {
    const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
    expect(findSecrets(`k="eyJhbGciOiJIUzI1NiJ9.${payload}.sig"`)).toHaveLength(1);
    expect(findSecrets(`k="eyJhbGciOiJIUzI1NiJ9.${payload}."`)).toHaveLength(1);
  });

  it('leaves the publishable key alone — it is meant to ship', () => {
    expect(findSecrets('const k="sb_publishable_4tYuIoPaSdFgHjKlZx";')).toEqual([]);
  });

  it('leaves an ordinary user token alone', () => {
    expect(findSecrets(`const t="${jwt({ role: 'authenticated', email: 'a@b.c' })}";`)).toEqual([]);
  });

  it('ignores JWT-shaped strings that are not JWTs', () => {
    expect(findSecrets('const x="eyJhbGciOiJub3Q.bm90LWpzb24tYXQtYWxs.zzzz";')).toEqual([]);
  });

  it('reports every hit, not just the first', () => {
    const source = `a="sb_secret_AAAAAAAAAAAA";b="${jwt({ role: 'service_role', ref: 'z' })}";`;
    expect(findSecrets(source)).toHaveLength(2);
  });
});
