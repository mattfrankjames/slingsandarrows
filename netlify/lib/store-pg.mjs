/**
 * The Postgres half of the storage layer. store.mjs chooses between this and
 * store-blobs.mjs; nothing else should import it directly.
 *
 * ── The contract this has to honour ──────────────────────────────────────────
 *
 * The records handed back must be byte-identical in shape to the ones the Blob
 * store returned, because they are serialised straight to the browser and the
 * frontend, the service worker's cached responses and the visual baselines all
 * expect that shape. So: camelCase keys, `author` rather than `author_email`,
 * `createdAt` as an ISO string rather than a Date. The schema is snake_case
 * because that is Postgres convention; the mapping lives here so exactly one
 * file knows about both.
 *
 * Getting this wrong would not throw. It would render a feed of cards with
 * blank authors and "Invalid Date", which is why the mapping has its own tests.
 *
 * ── Cursors ──────────────────────────────────────────────────────────────────
 *
 * A cursor stays what it has always been: a record id. It travels through the
 * API to the browser and back, and existing clients hold ones already issued,
 * so changing the format would break paging for anyone mid-scroll.
 *
 * Keyset paging needs (created_at, id) to be stable, so each query resolves the
 * cursor's timestamp in a subquery rather than trusting the caller to send one.
 * An unknown cursor — a record deleted between pages — yields no rows from that
 * subquery and the comparison is null, so the page comes back empty rather than
 * wrong. store-blobs restarts from the top in that case; neither is obviously
 * right, and empty is the one that cannot silently repeat content.
 */

import { query } from './db.mjs';

/**
 * How each logical store maps onto the schema.
 *
 * `read` is a view where counts are involved and the table otherwise. `write`
 * is always the table — a view with subselects is not updatable.
 */
const TABLES = {
  posts:            { read: 'posts_with_counts',   write: 'posts',         parent: null },
  'post-comments':  { read: 'post_comments',       write: 'post_comments', parent: 'post_id' },
  'post-likes':     { read: 'post_likes',          write: 'post_likes',    parent: 'post_id' },
  'board-threads':  { read: 'threads_with_counts', write: 'threads',       parent: null },
  'board-replies':  { read: 'replies',             write: 'replies',       parent: 'thread_id' },
  gallery:          { read: 'gallery_items',       write: 'gallery_items', parent: null },
};

function tableFor(name) {
  const entry = TABLES[name];
  if (!entry) throw new Error(`Unknown store "${name}"`);
  return entry;
}

/** snake_case row → the camelCase record the API has always returned. */
export function toRecord(name, row) {
  if (!row) return null;
  const iso = value => (value instanceof Date ? value.toISOString() : value);

  const base = { id: row.id, createdAt: iso(row.created_at) };

  switch (name) {
    case 'posts':
      return {
        ...base,
        title: row.title ?? '',
        body: row.body,
        imageUrl: row.image_url ?? '',
        author: row.author_email,
        // Counts come from the view. Numeric aggregates arrive as strings over
        // the wire, and `"3"` renders as 3 but breaks `count + 1` on the client.
        likeCount: Number(row.like_count ?? 0),
        commentCount: Number(row.comment_count ?? 0),
      };
    case 'post-comments':
      return { ...base, postId: row.post_id, body: row.body, author: row.author_email };
    case 'post-likes':
      return { postId: row.post_id, email: row.email, createdAt: iso(row.created_at) };
    case 'board-threads':
      return {
        ...base,
        title: row.title,
        body: row.body,
        mediaUrl: row.media_url ?? '',
        author: row.author_email,
        replyCount: Number(row.reply_count ?? 0),
      };
    case 'board-replies':
      return {
        ...base,
        threadId: row.thread_id,
        body: row.body,
        mediaUrl: row.media_url ?? '',
        author: row.author_email,
      };
    case 'gallery':
      return {
        ...base,
        mediaUrl: row.media_url,
        mediaType: row.media_type,
        caption: row.caption ?? '',
        author: row.author_email,
      };
    default:
      throw new Error(`Unknown store "${name}"`);
  }
}

/** The inverse: a record as the handlers build it → column values. */
export function toColumns(name, record) {
  const created = record.createdAt ?? new Date().toISOString();
  switch (name) {
    case 'posts':
      return {
        id: record.id,
        title: record.title || null,
        body: record.body,
        image_url: record.imageUrl || null,
        author_email: (record.author || '').toLowerCase(),
        created_at: created,
      };
    case 'post-comments':
      return {
        id: record.id,
        post_id: record.postId,
        body: record.body,
        author_email: (record.author || '').toLowerCase(),
        created_at: created,
      };
    case 'post-likes':
      return {
        post_id: record.postId,
        email: (record.email || '').toLowerCase(),
        created_at: created,
      };
    case 'board-threads':
      return {
        id: record.id,
        title: record.title,
        body: record.body,
        media_url: record.mediaUrl || null,
        author_email: (record.author || '').toLowerCase(),
        created_at: created,
      };
    case 'board-replies':
      return {
        id: record.id,
        thread_id: record.threadId,
        body: record.body,
        media_url: record.mediaUrl || null,
        author_email: (record.author || '').toLowerCase(),
        created_at: created,
      };
    case 'gallery':
      return {
        id: record.id,
        media_url: record.mediaUrl,
        media_type: record.mediaType || 'image',
        caption: record.caption || null,
        author_email: (record.author || '').toLowerCase(),
        created_at: created,
      };
    default:
      throw new Error(`Unknown store "${name}"`);
  }
}

/**
 * One page of records.
 *
 * Table names are interpolated because an identifier cannot be a bind
 * parameter; they come from TABLES above and cannot be influenced by a request.
 * `order` is narrowed to two literals rather than passed through. Everything a
 * caller supplies — parent ids, cursors, limits — is bound.
 */
/**
 * @param {string} name
 * @param {{ prefix?: string, limit?: number, cursor?: string|null, order?: 'desc'|'asc' }} [opts]
 */
export async function page(name, { prefix, limit, cursor, order = 'desc' } = {}) {
  const { read, parent } = tableFor(name);
  const dir = order === 'asc' ? 'asc' : 'desc';
  const cmp = dir === 'asc' ? '>' : '<';

  // store-blobs takes a key prefix; for child records that prefix is the
  // parent's id followed by a slash. Strip it back to the id.
  const parentId = prefix ? String(prefix).replace(/\/$/, '') : null;

  const params = [];
  const where = [];

  if (parentId && parent) {
    params.push(parentId);
    where.push(`${parent} = $${params.length}`);
  }

  const scoped = where.length ? `where ${where.join(' and ')}` : '';
  const totalRows = await query(`select count(*)::int as n from ${read} ${scoped}`, [...params]);
  const total = totalRows[0]?.n ?? 0;

  if (cursor) {
    params.push(cursor);
    where.push(
      `(created_at, id) ${cmp} (select created_at, id from ${read} where id = $${params.length})`
    );
  }

  const filtered = where.length ? `where ${where.join(' and ')}` : '';
  let limits = '';
  if (limit) {
    params.push(Number(limit));
    limits = `limit $${params.length}`;
  }

  const rows = await query(
    `select * from ${read} ${filtered} order by created_at ${dir}, id ${dir} ${limits}`,
    params
  );

  const items = rows.map(row => toRecord(name, row));
  const more = limit ? items.length === Number(limit) && total > items.length : false;

  return {
    items,
    nextCursor: more ? items[items.length - 1].id : null,
    total,
  };
}

export async function getRecord(name, id) {
  const { read } = tableFor(name);
  const rows = await query(`select * from ${read} where id = $1`, [id]);
  return toRecord(name, rows[0]);
}

/** Insert or replace, by primary key. */
export async function putRecord(name, record) {
  const { write } = tableFor(name);
  const columns = toColumns(name, record);
  const names = Object.keys(columns);
  const values = Object.values(columns);

  const placeholders = names.map((_, i) => `$${i + 1}`).join(', ');
  const conflict = name === 'post-likes' ? '(post_id, email)' : '(id)';
  const updates = names.map(column => `${column} = excluded.${column}`).join(', ');

  await query(
    `insert into ${write} (${names.join(', ')}) values (${placeholders})
     on conflict ${conflict} do update set ${updates}`,
    values
  );
  return record;
}

/**
 * Child records.
 *
 * No count maintenance and no manual cascade: the counts are views over the
 * rows and the foreign keys carry `on delete cascade`, so both are the
 * database's job. store-blobs has to do that work by hand, which is most of
 * why these operations exist as a pair rather than as raw writes.
 */
const CHILD_KEY = { 'post-comments': 'postId', 'board-replies': 'threadId' };

export async function createChild(name, record) {
  if (!CHILD_KEY[name]) throw new Error(`Store "${name}" is not a child store`);
  return putRecord(name, record);
}

export async function getChild(name, parentId, childId) {
  const { read, parent } = tableFor(name);
  const rows = await query(`select * from ${read} where ${parent} = $1 and id = $2`, [
    parentId,
    childId,
  ]);
  return toRecord(name, rows[0]);
}

export async function deleteChild(name, parentId, childId) {
  const { write, parent } = tableFor(name);
  await query(`delete from ${write} where ${parent} = $1 and id = $2`, [parentId, childId]);
}

export async function deleteRecord(name, id) {
  const { write } = tableFor(name);
  await query(`delete from ${write} where id = $1`, [id]);
}

/** Count children under a parent, without reading them. */
export async function countUnder(name, prefix) {
  const { read, parent } = tableFor(name);
  if (!parent) throw new Error(`Store "${name}" has no parent to count under`);
  const parentId = String(prefix).replace(/\/$/, '');
  const rows = await query(`select count(*)::int as n from ${read} where ${parent} = $1`, [parentId]);
  return rows[0]?.n ?? 0;
}

/** Which posts this person has liked — the /api/v1/me/likes query. */
export async function likedPostIds(email) {
  const rows = await query(`select post_id from post_likes where email = $1`, [
    String(email).toLowerCase(),
  ]);
  return rows.map(row => row.post_id);
}

/**
 * Like or unlike, and report the resulting count.
 *
 * The read-modify-write this replaces could lose a like when two arrived at
 * once, because the count lived on the post record. Here the delete or insert
 * is one statement against a primary key, and the count is a count.
 */
export async function toggleLike(postId, email) {
  const address = String(email).toLowerCase();

  const removed = await query(
    `delete from post_likes where post_id = $1 and email = $2 returning post_id`,
    [postId, address]
  );

  const liked = removed.length === 0;
  if (liked) {
    await query(`insert into post_likes (post_id, email) values ($1, $2) on conflict do nothing`, [
      postId,
      address,
    ]);
  }

  const counted = await query(`select count(*)::int as n from post_likes where post_id = $1`, [
    postId,
  ]);
  return { liked, likeCount: counted[0]?.n ?? 0 };
}

/** Does this record exist? Cheaper than fetching it to find out. */
export async function exists(name, id) {
  const { read } = tableFor(name);
  const rows = await query(`select 1 as ok from ${read} where id = $1 limit 1`, [id]);
  return rows.length > 0;
}
