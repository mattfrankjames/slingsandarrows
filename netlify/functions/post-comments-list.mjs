import { route, json, cacheFor } from '../lib/http.mjs';
import { requiredId, readPageParams } from '../lib/validate.mjs';
import { page } from '../lib/store.mjs';

/** Comments on a post, oldest first — reading order for a thread. */
export default route(async (req, context) => {
  const postId = requiredId(
    context.params?.postId ?? new URL(req.url).searchParams.get('postId'),
    'postId'
  );
  const { limit, cursor } = readPageParams(req, { defaultLimit: 0 });

  const { items, nextCursor, total } = await page('post-comments', {
    prefix: `${postId}/`,
    limit:  limit || undefined,
    cursor,
    order:  'asc',
  });

  return json(limit ? { comments: items, nextCursor, total } : items, 200, cacheFor(30));
});

export const config = {
  method: 'GET',
  path: ['/api/v1/posts/:postId/comments', '/api/posts/comments'],
};
