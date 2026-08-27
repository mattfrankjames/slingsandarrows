import { describe, it, expect } from 'vitest';
import {
  readJson, requiredString, optionalString, cloudinaryUrl,
  requiredId, newId, readPageParams, LIMITS,
} from '../../netlify/lib/validate.mjs';
import { HttpError } from '../../netlify/lib/http.mjs';

const body = payload =>
  new Request('https://x.test/api/v1/posts', {
    method: 'POST',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

const rejects = fn => {
  try { fn(); return false; } catch (e) { return e instanceof HttpError && e.status === 400; }
};

describe('readJson', () => {
  it('parses an object body', async () => {
    expect(await readJson(body({ a: 1 }))).toEqual({ a: 1 });
  });

  it.each([
    ['malformed JSON', 'not json at all'],
    ['a JSON array', '[1,2,3]'],
    ['a bare string', '"hello"'],
    ['null', 'null'],
  ])('rejects %s with 400, not 500', async (_label, payload) => {
    await expect(readJson(body(payload))).rejects.toMatchObject({ status: 400 });
  });
});

describe('requiredString', () => {
  it('trims', () => expect(requiredString('  hi  ', 'Body')).toBe('hi'));
  it('rejects whitespace-only', () => expect(rejects(() => requiredString('   ', 'Body'))).toBe(true));
  it('rejects non-strings', () => expect(rejects(() => requiredString(42, 'Body'))).toBe(true));
  it('enforces the cap', () => expect(rejects(() => requiredString('abcdef', 'Body', 3))).toBe(true));

  it('names the field in the message, so the UI can show it', () => {
    try { requiredString('', 'Comment'); } catch (e) { expect(e.message).toMatch(/^Comment/); }
  });
});

describe('optionalString', () => {
  it.each([undefined, null, ''])('allows %s', v => expect(optionalString(v, 'Title')).toBe(''));
  it('still enforces the cap', () => expect(rejects(() => optionalString('abcdef', 'Title', 3))).toBe(true));
});

describe('cloudinaryUrl', () => {
  it('accepts a Cloudinary URL', () => {
    const url = 'https://res.cloudinary.com/x/image/upload/a.jpg';
    expect(cloudinaryUrl(url)).toBe(url);
  });

  it.each([
    ['another host', 'https://evil.test/x.jpg'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a lookalike host', 'https://res.cloudinary.com.evil.test/x.jpg'],
    ['a protocol-relative lookalike', '//res.cloudinary.com/x.jpg'],
    ['a non-string', null],
  ])('drops %s', (_label, value) => expect(cloudinaryUrl(value)).toBe(''));
});

describe('requiredId', () => {
  it('accepts a normal id', () => expect(requiredId('1756-abc', 'postId')).toBe('1756-abc'));

  it.each([
    ['a slash, which would escape the blob prefix', 'a/b'],
    ['traversal', '..'],
    ['missing', undefined],
  ])('rejects %s', (_label, value) => expect(rejects(() => requiredId(value, 'postId'))).toBe(true));
});

describe('newId', () => {
  // Ids already in the blob stores are unpadded 13-digit timestamps. Padding
  // these would sort every new record ahead of every old one and invert the feed.
  it('is <13-digit timestamp>-<random>', () => expect(newId()).toMatch(/^\d{13}-[a-z0-9]{1,7}$/));
  it('sorts after an existing-format id', () => expect(newId() > '1700000000000-aaaaaaa').toBe(true));
  it('is unique across many calls', () => {
    expect(new Set(Array.from({ length: 2000 }, newId)).size).toBe(2000);
  });
  // store.mjs pages by sorting keys, so the timestamp prefix must be
  // non-decreasing. Ids minted within the same millisecond tie on the prefix
  // and order by their random suffix, which is fine — they are the same instant.
  it('has a non-decreasing timestamp prefix', async () => {
    const stamps = [];
    for (let i = 0; i < 5; i++) {
      stamps.push(newId().split('-')[0]);
      await new Promise(r => setTimeout(r, 2));
    }
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('orders ids from different milliseconds chronologically', async () => {
    const first = newId();
    await new Promise(r => setTimeout(r, 2));
    const second = newId();
    expect(second > first).toBe(true);
  });
});

describe('readPageParams', () => {
  const at = query => new Request(`https://x.test/api/v1/posts${query}`);

  it('defaults when absent', () => expect(readPageParams(at('')).limit).toBe(25));
  it('honours an explicit limit', () => expect(readPageParams(at('?limit=10')).limit).toBe(10));
  it('clamps to maxLimit', () => expect(readPageParams(at('?limit=9999')).limit).toBe(100));
  it('reads a cursor', () => expect(readPageParams(at('?cursor=abc')).cursor).toBe('abc'));
  it('null cursor when absent', () => expect(readPageParams(at('')).cursor).toBeNull());

  it.each(['?limit=0', '?limit=-5', '?limit=abc'])('rejects %s', q => {
    expect(rejects(() => readPageParams(at(q)))).toBe(true);
  });
});

describe('LIMITS', () => {
  it('caps every user-supplied field', () => {
    for (const [field, max] of Object.entries(LIMITS)) {
      expect(max, `${field} must have a positive cap`).toBeGreaterThan(0);
    }
  });
});
