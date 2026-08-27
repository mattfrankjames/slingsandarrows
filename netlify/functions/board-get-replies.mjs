import { route, json, cacheFor } from '../lib/http.mjs';
import { requiredId, readPageParams } from '../lib/validate.mjs';
import { page } from '../lib/store.mjs';

/** Replies to a thread, oldest first. */
export default route(async (req, context) => {
  const threadId = requiredId(
    context.params?.threadId ?? new URL(req.url).searchParams.get('threadId'),
    'threadId'
  );
  const { limit, cursor } = readPageParams(req, { defaultLimit: 0 });

  const { items, nextCursor, total } = await page('board-replies', {
    prefix: `${threadId}/`,
    limit:  limit || undefined,
    cursor,
    order:  'asc',
  });

  return json(limit ? { replies: items, nextCursor, total } : items, 200, cacheFor(30));
});

export const config = {
  method: 'GET',
  path: ['/api/v1/board/threads/:threadId/replies', '/api/board/replies'],
};
