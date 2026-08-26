/**
 * store.mjs — Blob access, with paging.
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

import { getStore } from '@netlify/blobs';

export { getStore };

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
  const store = getStore(name);
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
  const { blobs } = await getStore(name).list({ prefix });
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
  const record = await getStore(name).get(key, { type: 'json' });
  if (!record) throw missing;
  return record;
}
