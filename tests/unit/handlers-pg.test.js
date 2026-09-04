/**
 * The read endpoints, invoked as functions, against a real Postgres.
 *
 * Skipped without DATABASE_URL — see tests/unit/store-pg.test.js for how to get
 * one. No HTTP server is involved: the handlers are ordinary async functions
 * taking a Request, so calling them directly tests the same code the platform
 * runs, in CI, without `netlify dev` (whose Parcel watcher dies on iCloud
 * Drive, and which cannot inject a connection string for a database that is not
 * provisioned yet).
 *
 * These cover the read paths only. Writing requires a verified Netlify Identity
 * token, which cannot be produced locally — those endpoints stay covered by the
 * browser suite against a deploy preview.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const LIVE = Boolean(process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL);
const describeLive = LIVE ? describe : describe.skip;

if (!LIVE) console.warn('[handlers-pg] DATABASE_URL unset — skipping.');

describeLive('read endpoints on the Postgres backend', () => {
  let db;
  const NEWER = '1756000000000-aaa';
  const OLDER = '1755000000000-bbb';

  const call = async (module, url, params = {}) => {
    const handler = (await import(`../../netlify/functions/${module}.mjs`)).default;
    const res = await handler(new Request(url), { params });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    process.env.USE_POSTGRES = 'true';
    db = await import('../../netlify/lib/db.mjs');
    await db.query('delete from posts where id = any($1)', [[NEWER, OLDER]]);
    await db.query('delete from gallery_items where id = $1', ['g-test']);
    await db.query('delete from threads where id = $1', ['t-test']);

    await db.query(
      `insert into posts (id, title, body, image_url, author_email, created_at) values
       ($1,'Second','Newer body',null,'band@example.test','2026-08-20T10:00:00Z'),
       ($2,'First','Older body','https://res.cloudinary.com/x/image/upload/a.jpg','band@example.test','2026-08-10T10:00:00Z')`,
      [NEWER, OLDER]
    );
    await db.query(
      `insert into post_comments (id, post_id, body, author_email, created_at)
       values ('c-test',$1,'nice one','fan@example.test','2026-08-21T10:00:00Z')`,
      [NEWER]
    );
    await db.query(`insert into post_likes (post_id, email) values ($1,'fan@example.test')`, [NEWER]);
    await db.query(
      `insert into gallery_items (id, media_url, media_type, caption, author_email, created_at)
       values ('g-test','https://res.cloudinary.com/x/image/upload/g.jpg','image','A photo','band@example.test','2026-08-15T10:00:00Z')`
    );
    await db.query(
      `insert into threads (id, title, body, author_email, created_at)
       values ('t-test','A thread','Thread body','fan@example.test','2026-08-18T10:00:00Z')`
    );
    await db.query(
      `insert into replies (id, thread_id, body, author_email, created_at)
       values ('r-test','t-test','a reply','other@example.test','2026-08-19T10:00:00Z')`
    );
  });

  afterAll(async () => {
    await db.query('delete from posts where id = any($1)', [[NEWER, OLDER]]);
    await db.query('delete from gallery_items where id = $1', ['g-test']);
    await db.query('delete from threads where id = $1', ['t-test']);
    delete process.env.USE_POSTGRES;
  });

  it('GET /api/v1/posts returns the record shape the frontend renders', async () => {
    const { status, body } = await call('get-posts', 'http://x/api/v1/posts');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);

    const post = body.find(p => p.id === NEWER);
    expect(post).toMatchObject({
      title: 'Second',
      body: 'Newer body',
      author: 'band@example.test',
      likeCount: 1,
      commentCount: 1,
    });
    // The keys post-render.js actually reads.
    expect(typeof post.createdAt).toBe('string');
    expect(new Date(post.createdAt).toString()).not.toBe('Invalid Date');
    expect(post).not.toHaveProperty('author_email');
  });

  it('GET /api/v1/posts is newest first', async () => {
    const { body } = await call('get-posts', 'http://x/api/v1/posts');
    const ids = body.map(p => p.id);
    expect(ids.indexOf(NEWER)).toBeLessThan(ids.indexOf(OLDER));
  });

  it('paging returns the envelope shape and a working cursor', async () => {
    const first = await call('get-posts', 'http://x/api/v1/posts?limit=1');
    expect(first.body).toHaveProperty('posts');
    expect(first.body).toHaveProperty('nextCursor');
    expect(first.body).toHaveProperty('total');
    expect(first.body.posts).toHaveLength(1);

    const second = await call(
      'get-posts',
      `http://x/api/v1/posts?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`
    );
    expect(second.body.posts[0].id).not.toBe(first.body.posts[0].id);
  });

  it('GET /api/v1/gallery maps media fields', async () => {
    const { status, body } = await call('gallery-list', 'http://x/api/v1/gallery');
    expect(status).toBe(200);
    const item = body.find(i => i.id === 'g-test');
    expect(item).toMatchObject({
      mediaUrl: 'https://res.cloudinary.com/x/image/upload/g.jpg',
      mediaType: 'image',
      caption: 'A photo',
      author: 'band@example.test',
    });
  });

  it('GET /api/v1/board/threads carries a reply count from the aggregate', async () => {
    const { status, body } = await call('board-get-threads', 'http://x/api/v1/board/threads');
    expect(status).toBe(200);
    const thread = body.find(t => t.id === 't-test');
    expect(thread).toMatchObject({ title: 'A thread', author: 'fan@example.test', replyCount: 1 });
    expect(typeof thread.replyCount).toBe('number');
  });

  it('GET a post’s comments reads oldest first with the right keys', async () => {
    const { status, body } = await call(
      'post-comments-list',
      `http://x/api/v1/posts/${NEWER}/comments`,
      { postId: NEWER }
    );
    expect(status).toBe(200);
    expect(body[0]).toMatchObject({ postId: NEWER, body: 'nice one', author: 'fan@example.test' });
  });

  it('GET a thread’s replies', async () => {
    const { status, body } = await call(
      'board-get-replies',
      'http://x/api/v1/board/threads/t-test/replies',
      { threadId: 't-test' }
    );
    expect(status).toBe(200);
    expect(body[0]).toMatchObject({ threadId: 't-test', body: 'a reply' });
  });
});

/**
 * Authorisation on the Postgres path.
 *
 * The read tests above all pass with an empty `roles` table, which is precisely
 * how the cutover shipped with nobody able to publish: content migrated,
 * permissions did not — they had been ALLOWED_AUTHORS / ALLOWED_ADMINS, which
 * are environment variables in the Netlify UI and so were never Blob data for
 * the migration to copy.
 *
 * These assert the table is actually consulted, in both directions.
 */
describeLive('roles on the Postgres backend', () => {
  let db;
  let auth;
  const AUTHOR = 'author-test@example.test';
  const NOBODY = 'nobody-test@example.test';

  beforeAll(async () => {
    process.env.USE_POSTGRES = 'true';
    db = await import('../../netlify/lib/db.mjs');
    auth = await import('../../netlify/lib/auth.mjs');
    await db.query('delete from roles where email = any($1)', [[AUTHOR, NOBODY]]);
    await db.query(
      "insert into roles (email, role) values ($1,'author') on conflict do nothing",
      [AUTHOR]
    );
  });

  afterAll(async () => {
    await db.query('delete from roles where email = any($1)', [[AUTHOR, NOBODY]]);
    delete process.env.USE_POSTGRES;
  });

  it('grants the author role from the table', async () => {
    expect(await auth.isAuthor({ email: AUTHOR })).toBe(true);
  });

  // The failure that went unnoticed: an account with no row cannot publish, and
  // an empty table means nobody can.
  it('refuses someone with no row', async () => {
    expect(await auth.isAuthor({ email: NOBODY })).toBe(false);
  });

  it('matches regardless of the case the token presents', async () => {
    expect(await auth.isAuthor({ email: AUTHOR.toUpperCase() })).toBe(true);
  });

  // The env path let an unset ALLOWED_ADMINS fall back to the author list. The
  // table has no fallback, so an author is not automatically an admin.
  it('does not make an author an admin', async () => {
    expect(await auth.isAdmin({ email: AUTHOR })).toBe(false);
  });

  it('grants admin only where the row says so', async () => {
    await db.query("insert into roles (email, role) values ($1,'admin')", [AUTHOR]);
    expect(await auth.isAdmin({ email: AUTHOR })).toBe(true);
  });

  it('has no role for a missing user', async () => {
    expect(await auth.isAuthor(null)).toBe(false);
  });
});
