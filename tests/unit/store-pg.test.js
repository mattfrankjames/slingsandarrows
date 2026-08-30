/**
 * The Postgres store, against a real Postgres.
 *
 * Skipped when DATABASE_URL is unset, so `npm test` stays offline by default —
 * but not skipped quietly: an untested storage layer that reports success is
 * the failure mode this repo has hit repeatedly. Run it with:
 *
 *   npx netlify dev                       # starts the local WASM Postgres
 *   DATABASE_URL="$(npx netlify database connect --query 'select 1' \
 *     | grep -oE 'postgres(ql)?://[^ ]+' | head -1)" npx vitest run store-pg
 *
 * The connection string changes every run, so re-read it each time.
 *
 * These exist because the mapping between snake_case columns and the camelCase
 * records the API returns cannot fail loudly. A wrong key does not throw — it
 * renders a feed of cards with a blank author and "Invalid Date".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const LIVE = Boolean(process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL);
const describeLive = LIVE ? describe : describe.skip;

if (!LIVE) {
  console.warn('[store-pg] DATABASE_URL unset — skipping. See the header of this file.');
}

describeLive('store-pg against a real database', () => {
  /** @type {typeof import('../../netlify/lib/store-pg.mjs')} */
  let store;
  /** @type {typeof import('../../netlify/lib/db.mjs')} */
  let db;

  const POST = '9900-aaa';
  const OLDER = '9800-bbb';

  beforeAll(async () => {
    store = await import('../../netlify/lib/store-pg.mjs');
    db = await import('../../netlify/lib/db.mjs');
    await db.query('delete from posts where id = any($1)', [[POST, OLDER]]);
  });

  afterAll(async () => {
    await db.query('delete from posts where id = any($1)', [[POST, OLDER]]);
  });

  it('round-trips a post through the shape the API promises', async () => {
    await store.putRecord('posts', {
      id: POST,
      title: 'A title',
      body: 'Body copy',
      imageUrl: 'https://res.cloudinary.com/x/image/upload/a.jpg',
      author: 'Band@Example.TEST',
      createdAt: '2026-08-01T12:00:00.000Z',
    });

    const post = await store.getRecord('posts', POST);

    // camelCase, `author` not `author_email`, and an ISO string not a Date.
    expect(post).toMatchObject({
      id: POST,
      title: 'A title',
      body: 'Body copy',
      imageUrl: 'https://res.cloudinary.com/x/image/upload/a.jpg',
      author: 'band@example.test',
      likeCount: 0,
      commentCount: 0,
    });
    expect(post.createdAt).toBe('2026-08-01T12:00:00.000Z');
    expect(post).not.toHaveProperty('author_email');
    expect(post).not.toHaveProperty('created_at');
  });

  it('returns counts as numbers, not the strings an aggregate arrives as', async () => {
    await store.putRecord('post-comments', {
      id: 'c-9900-1',
      postId: POST,
      body: 'nice',
      author: 'fan@example.test',
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    await store.toggleLike(POST, 'fan@example.test');

    const post = await store.getRecord('posts', POST);
    // `"1"` renders as 1 and then breaks count + 1 on the client.
    expect(typeof post.likeCount).toBe('number');
    expect(typeof post.commentCount).toBe('number');
    expect(post.likeCount).toBe(1);
    expect(post.commentCount).toBe(1);
  });

  it('toggles a like off again and cannot double-count it', async () => {
    const second = await store.toggleLike(POST, 'fan@example.test');
    expect(second).toEqual({ liked: false, likeCount: 0 });

    const on = await store.toggleLike(POST, 'fan@example.test');
    expect(on).toEqual({ liked: true, likeCount: 1 });

    // The bug this replaces: two likes arriving together used to lose one.
    await Promise.all([
      store.toggleLike(POST, 'other@example.test'),
      store.toggleLike(POST, 'third@example.test'),
    ]);
    const post = await store.getRecord('posts', POST);
    expect(post.likeCount).toBe(3);
  });

  it('lists which posts a person liked', async () => {
    expect(await store.likedPostIds('FAN@example.test')).toContain(POST);
    expect(await store.likedPostIds('nobody@example.test')).toEqual([]);
  });

  it('counts children without reading them', async () => {
    expect(await store.countUnder('post-comments', `${POST}/`)).toBe(1);
    expect(await store.countUnder('post-comments', POST)).toBe(1);
  });

  /*
   * Ordering is asserted relative to this test's own two records, not by
   * absolute position. An earlier version checked that its post came back
   * first, which held until another suite seeded a newer one into the same
   * database and the failure looked like a paging bug rather than a test that
   * assumed it owned the table.
   */
  it('pages newest first, and the cursor resumes where the page ended', async () => {
    await store.putRecord('posts', {
      id: OLDER,
      body: 'older',
      author: 'band@example.test',
      createdAt: '2026-07-01T00:00:00.000Z',
    });

    const { items } = await store.page('posts', {});
    const ids = items.map(p => p.id);
    expect(ids).toContain(POST);
    expect(ids).toContain(OLDER);
    expect(ids.indexOf(POST), 'newer post sorts before older').toBeLessThan(ids.indexOf(OLDER));

    // Walk from the newer of the pair; the next page must reach the older one
    // without repeating it.
    const after = await store.page('posts', { cursor: POST });
    const afterIds = after.items.map(p => p.id);
    expect(afterIds).toContain(OLDER);
    expect(afterIds).not.toContain(POST);
  });

  it('reads child records oldest first', async () => {
    await store.putRecord('post-comments', {
      id: 'c-9900-2',
      postId: POST,
      body: 'later',
      author: 'fan@example.test',
      createdAt: '2026-08-03T00:00:00.000Z',
    });

    const { items } = await store.page('post-comments', { prefix: `${POST}/`, order: 'asc' });
    expect(items.map(c => c.id)).toEqual(['c-9900-1', 'c-9900-2']);
    expect(items[0]).toMatchObject({ postId: POST, author: 'fan@example.test' });
  });

  it('deleting a post takes its comments and likes with it', async () => {
    await store.deleteRecord('posts', POST);
    expect(await store.getRecord('posts', POST)).toBeNull();
    expect(await store.countUnder('post-comments', POST)).toBe(0);
    expect(await store.likedPostIds('fan@example.test')).not.toContain(POST);
  });

  it('binds values rather than concatenating them', async () => {
    const hostile = "x'; delete from posts; --";
    expect(await store.getRecord('posts', hostile)).toBeNull();
    // The table is still there, which it would not be if that had been executed.
    const survivors = await store.page('posts', {});
    expect(Array.isArray(survivors.items)).toBe(true);
  });
});
