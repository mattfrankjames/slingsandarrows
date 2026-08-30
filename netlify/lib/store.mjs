/**
 * store.mjs — which storage layer the handlers are talking to.
 *
 * Phase 4 moves this site from Netlify Blobs to Postgres. Both implementations
 * are present and complete, and this file picks between them from one
 * environment variable, so the cutover is a setting rather than a deploy and
 * the way back is the same setting.
 *
 * ── USE_POSTGRES ─────────────────────────────────────────────────────────────
 *
 * Off by default, deliberately. A flag that defaults on is not a flag — it is a
 * migration with extra steps, and the first environment to discover a problem
 * is production. Turn it on for one deploy preview, look at the site, then turn
 * it on in production. The Blob data is untouched either way and stays a
 * rollback for as long as the flag exists.
 *
 * ── Why both halves present the same surface ─────────────────────────────────
 *
 * The handlers used to call blob methods directly — setJSON, delete, list with
 * a key prefix — which meant the storage model leaked into twenty files. That
 * is fine while there is one storage model. It is a rewrite of twenty files the
 * moment there are two.
 *
 * So the operations are named for what the site does rather than for how a blob
 * store does it: `putRecord`, `countUnder`, `toggleLike`, `likedPostIds`. Each
 * half implements them its own way. The Blob key layouts that made those
 * queries possible — `<parentId>/<id>` for children, `<email>::<postId>` for
 * likes — stay an implementation detail of store-blobs.mjs, which is where they
 * always belonged.
 */

import * as blobs from './store-blobs.mjs';
import * as postgres from './store-pg.mjs';

/**
 * Read at call time rather than at import.
 *
 * Module scope is evaluated once per function instance and outlives any single
 * request, so caching this would mean a flag change needing a redeploy to take
 * effect — and, worse, instances disagreeing with each other while the old ones
 * aged out.
 */
function backend() {
  return process.env.USE_POSTGRES === 'true' ? postgres : blobs;
}

/** Which one is live. For the health endpoint and for reading logs. */
export function backendName() {
  return process.env.USE_POSTGRES === 'true' ? 'postgres' : 'blobs';
}

export const page = (name, opts) => backend().page(name, opts);
export const getRecord = (name, id) => backend().getRecord(name, id);
export const putRecord = (name, record) => backend().putRecord(name, record);
export const deleteRecord = (name, id) => backend().deleteRecord(name, id);
export const countUnder = (name, prefix) => backend().countUnder(name, prefix);
export const likedPostIds = email => backend().likedPostIds(email);
export const toggleLike = (postId, email) => backend().toggleLike(postId, email);
export const exists = (name, id) => backend().exists(name, id);
export const createChild = (name, record) => backend().createChild(name, record);
export const getChild = (name, parentId, childId) => backend().getChild(name, parentId, childId);
export const deleteChild = (name, parentId, childId) =>
  backend().deleteChild(name, parentId, childId);

/**
 * Read one record, or throw the caller's chosen 404.
 *
 * @param {string} name
 * @param {string} id
 * @param {Error} missing  Error to throw when absent.
 */
export async function getOrThrow(name, id, missing) {
  const record = await backend().getRecord(name, id);
  if (!record) throw missing;
  return record;
}

/** Pure paging arithmetic, used by store-blobs and covered by its own tests. */
export { selectPage } from './store-blobs.mjs';
