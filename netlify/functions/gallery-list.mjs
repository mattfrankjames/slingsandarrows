import { route, json, cacheFor } from '../lib/http.mjs';
import { readPageParams } from '../lib/validate.mjs';
import { page } from '../lib/store.mjs';

/** Gallery items, newest first. */
export default route(async req => {
  const { limit, cursor } = readPageParams(req, { defaultLimit: 0 });
  const { items, nextCursor, total } = await page('gallery', {
    limit: limit || undefined,
    cursor,
  });

  return json(limit ? { items, nextCursor, total } : items, 200, cacheFor(60));
});

export const config = {
  method: 'GET',
  path: ['/api/v1/gallery', '/api/gallery/list'],
};
