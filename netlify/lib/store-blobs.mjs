/**
 * store-blobs.mjs — Blob access, with paging.
 *
 * The implementation this project has been running on. store.mjs chooses
 * between it and store-pg.mjs; nothing else should import it directly. It is
 * kept whole rather than deleted so USE_POSTGRES can be turned off again
 * without a revert, and so the Blob data stays reachable as a rollback for a
 * few deploys after the cutover.
 *
 * Five functions independently did this:
 *
 *     const { blobs } = await store.list();
 *     const items = await Promise.all(blobs.map(b => store.get(b.key, ...)));
 *     items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
 *
 * — read every record in the store, sort in memory, return all of it. Cost grows
 * with total content on every request, forever, and the whole feed crosses the
 * wire on each cold load.
 *
 * `page()` fixes the read amplification without changing the storage model:
 * blob keys start with a millisecond timestamp (see validate.newId), so keys
 * alone sort chronologically. We sort the *key list*, take one page, and fetch
 * only those records. A store with 500 posts serving a 25-item page does 25
 * reads instead of 500.
 *
 * It does not fix the underlying issue — list() still enumerates every key, so
 * this is O(keys) metadata plus O(page) reads rather than O(1). Blobs has no
 * index to do better. Phase 4 replaces this with a keyset query.
 */

import { getStore as getBlobStore } from '@netlify/blobs';

/**
 * A blob store, by name.
 *
 * Inside a function, @netlify/blobs finds the site and token from the ambient
 * runtime and a bare name is enough. Outside one it finds nothing and throws
 * "The environment has not been configured to use Netlify Blobs" — which is
 * where the data migration runs, since it reads Blobs and writes Postgres from
 * an ordinary node process.
 *
 * `netlify dev:exec` does not close that gap: it injects the site's environment
 * variables, and Blobs credentials are not among them. So explicit siteID and
 * token are read from the environment when present, and ignored when not.
 * Handlers are unaffected — they never set these.
 *
 * @param {string} name
 */
function blobStore(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
  return siteID && token ? getBlobStore({ name, siteID, token }) : getBlobStore(name);
}

export { blobStore as getStore };

/**
 * One page of records, newest first.
 *
 * @param {string} name            Blob store name.
 * @param {object} [opts]
 * @param {string} [opts.prefix]   Restrict to keys under this prefix.
 * @param {number} [opts.limit]    Page size. Omit for everything.
 * @param {string} [opts.cursor]   `nextCursor` from the previous page.
 * @param {'desc'|'asc'} [opts.order]  Newest first (default), or oldest first.
 * @returns {Promise<{ items: object[], nextCursor: string|null, total: number }>}
 */
export async function page(name, opts = {}) {
  const store = blobStore(name);
  const { blobs } = await store.list(opts.prefix ? { prefix: opts.prefix } : undefined);

  const { keys, nextCursor, total } = selectPage(blobs.map(b => b.key), opts);

  const items = (
    await Promise.all(keys.map(key => store.get(key, { type: 'json' }).catch(() => null)))
  ).filter(Boolean);

  return { items, nextCursor, total };
}

/**
 * Choose which keys make up a page. Pure, so the paging rules can be tested
 * without a blob store — `page()` is only the I/O around this.
 *
 * @param {string[]} allKeys
 * @param {{ limit?: number, cursor?: string|null, order?: 'desc'|'asc' }} [opts]
 * @returns {{ keys: string[], nextCursor: string|null, total: number }}
 */
export function selectPage(allKeys, { limit, cursor, order = 'desc' } = {}) {
  // Keys are `<timestamp>-<random>`, optionally behind a prefix, so sorting the
  // key strings is chronological without reading a single record. Feeds and
  // galleries want newest first; comment and reply threads read oldest first.
  const keys = [...allKeys].sort();
  if (order === 'desc') keys.reverse();

  let start = 0;
  if (cursor) {
    const at = keys.indexOf(cursor);
    // An unknown cursor means the record was deleted between pages. Starting
    // from the top is the safe answer — better a repeated item than a silently
    // truncated list.
    start = at === -1 ? 0 : at + 1;
  }

  const pageKeys = limit ? keys.slice(start, start + limit) : keys.slice(start);
  const more = limit ? start + pageKeys.length < keys.length : false;

  return {
    keys: pageKeys,
    nextCursor: more ? pageKeys[pageKeys.length - 1] : null,
    total: keys.length,
  };
}

/**
 * Count keys under a prefix without reading any records.
 * Used for reply/comment counts, where the record contents are irrelevant.
 */
export async function countUnder(name, prefix) {
  const { blobs } = await blobStore(name).list({ prefix });
  return blobs.length;
}

/**
 * Read one record, or throw the caller's chosen 404.
 *
 * @param {string} name
 * @param {string} key
 * @param {Error} missing  Error to throw when absent.
 */
export async function getOrThrow(name, key, missing) {
  const record = await blobStore(name).get(key, { type: 'json' });
  if (!record) throw missing;
  return record;
}


// ── The record-level operations store.mjs dispatches ─────────────────────────
//
// These wrap the raw blob calls the handlers used to make directly, so both
// halves of the storage layer present the same surface. The key layout is the
// interesting part: children are stored under `<parentId>/<id>` so that a
// prefix list gets a thread's replies, and likes under `<email>::<postId>` so
// that a prefix list gets one person's likes. Those two schemes are why the
// Blob version could answer its queries at all, and they are exactly what the
// foreign keys and indexes replace.

/** The blob key for a record, which depends on the store's layout. */
function keyFor(name, record) {
  switch (name) {
    case 'post-comments':
      return `${record.postId}/${record.id}`;
    case 'board-replies':
      return `${record.threadId}/${record.id}`;
    case 'post-likes':
      return `${String(record.email).toLowerCase()}::${record.postId}`;
    default:
      return record.id;
  }
}

export async function getRecord(name, id) {
  return (await blobStore(name).get(id, { type: 'json' })) || null;
}

export async function putRecord(name, record) {
  await blobStore(name).setJSON(keyFor(name, record), record);
  return record;
}

/** The parent store and count field for a child store, or null. */
const CHILD_OF = {
  'post-comments': { parent: 'posts', count: 'commentCount', key: 'postId' },
  'board-replies': { parent: 'board-threads', count: 'replyCount', key: 'threadId' },
};

/**
 * Adjust a parent's denormalised count.
 *
 * This is the read-modify-write that Postgres replaces with an aggregate, and
 * it is wrong in the same way toggleLike is: two children created at once both
 * read the same number. It lives here rather than in the handlers because it is
 * a fact about this storage model and not about the site — store-pg has nothing
 * corresponding, because a count over rows cannot drift.
 */
async function adjustCount(name, parentId, delta) {
  const child = CHILD_OF[name];
  if (!child) return;

  const store = blobStore(child.parent);
  const parent = await store.get(parentId, { type: 'json' });
  if (!parent) return;

  parent[child.count] = Math.max(0, (parent[child.count] || 0) + delta);
  await store.setJSON(parentId, parent);
}

export async function createChild(name, record) {
  const child = CHILD_OF[name];
  if (!child) throw new Error(`Store "${name}" is not a child store`);
  await blobStore(name).setJSON(`${record[child.key]}/${record.id}`, record);
  await adjustCount(name, record[child.key], +1);
  return record;
}

export async function getChild(name, parentId, childId) {
  return (await blobStore(name).get(`${parentId}/${childId}`, { type: 'json' })) || null;
}

export async function deleteChild(name, parentId, childId) {
  await blobStore(name).delete(`${parentId}/${childId}`);
  await adjustCount(name, parentId, -1);
}

/**
 * Delete a record and anything hanging off it.
 *
 * Blobs has no cascade, so the children are enumerated and removed by hand.
 * board-delete-thread already did this for replies; deleting a post did not,
 * which is the "deleting a post leaves its comments and likes behind" entry in
 * the status doc. Doing it here fixes that on this path too, and — more
 * importantly for the cutover — means both halves behave the same, so a
 * comparison between them is meaningful.
 */
export async function deleteRecord(name, id) {
  const children = Object.entries(CHILD_OF).filter(([, c]) => c.parent === name);

  for (const [childStore] of children) {
    const store = blobStore(childStore);
    const { blobs } = await store.list({ prefix: `${id}/` });
    await Promise.all(blobs.map(({ key }) => store.delete(key)));
  }

  if (name === 'posts') {
    // Likes are keyed <email>::<postId>, so they cannot be found by prefix.
    // Listing the store is acceptable here only because deletes are rare.
    const likes = blobStore('post-likes');
    const { blobs } = await likes.list();
    await Promise.all(
      blobs.filter(({ key }) => key.endsWith(`::${id}`)).map(({ key }) => likes.delete(key))
    );
  }

  await blobStore(name).delete(id);
}

export async function likedPostIds(email) {
  const prefix = `${String(email).toLowerCase()}::`;
  const { blobs } = await blobStore('post-likes').list({ prefix });
  return blobs.map(({ key }) => key.slice(prefix.length));
}

/**
 * Like or unlike, and report the resulting count.
 *
 * The known-broken one. likeCount lives on the post record, so this is
 * read-modify-write: two likes arriving together read the same number and one
 * is lost. Blobs offers no compare-and-set, so there is no correct version of
 * this function — which is why the count became an aggregate in Postgres.
 */
export async function toggleLike(postId, email) {
  const posts = blobStore('posts');
  const post = await posts.get(postId, { type: 'json' });
  if (!post) return null;

  const likes = blobStore('post-likes');
  const key = `${String(email).toLowerCase()}::${postId}`;
  const liked = !(await likes.get(key));

  if (liked) {
    await likes.setJSON(key, {
      postId,
      email: String(email).toLowerCase(),
      createdAt: new Date().toISOString(),
    });
    post.likeCount = (post.likeCount || 0) + 1;
  } else {
    await likes.delete(key);
    post.likeCount = Math.max(0, (post.likeCount || 1) - 1);
  }

  await posts.setJSON(postId, post);
  return { liked, likeCount: post.likeCount };
}

export async function exists(name, id) {
  return Boolean(await blobStore(name).get(id, { type: 'json' }));
}
