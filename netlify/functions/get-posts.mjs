import { route, json, cacheFor } from '../lib/http.mjs';
import { readPageParams } from '../lib/validate.mjs';
import { page } from '../lib/store.mjs';

/**
 * List posts, newest first.
 *
 * Paging is opt-in: without a `limit` the whole feed comes back, because the
 * deployed frontend asks for everything and must keep working through this
 * change. New callers should send one — see lib/store.mjs for why unbounded
 * reads are a problem.
 */
export default route(async req => {
  const { limit, cursor } = readPageParams(req, { defaultLimit: 0 });
  const { items, nextCursor, total } = await page('posts', {
    limit: limit || undefined,
    cursor,
  });

  // Unpaged callers get the bare array they have always got. Paged callers get
  // the cursor too, which needs an envelope.
  const body = limit ? { posts: items, nextCursor, total } : items;
  return json(body, 200, cacheFor(60));
});

export const config = {
  method: 'GET',
  path: ['/api/v1/posts', '/api/get-posts'],
};
