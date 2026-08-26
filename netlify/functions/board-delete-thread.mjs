import { route, json, notFound } from '../lib/http.mjs';
import { requireModerator } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { getStore, getOrThrow } from '../lib/store.mjs';

/**
 * Delete a thread and the replies under it.
 *
 * Replies go first: if the run dies between the two steps, orphaned replies
 * under a missing thread are invisible and harmless, whereas a thread whose
 * replies were deleted first would render as an empty conversation. Neither is
 * atomic — Blobs has no transaction — which is what Phase 4's cascade fixes.
 */
export default route(async (req, context) => {
  const id = context.params?.id
    ? requiredId(context.params.id)
    : requiredId((await readJson(req)).id, 'Thread id');

  const thread = await getOrThrow('board-threads', id, notFound('That thread is already gone'));
  await requireModerator(req, thread.author);

  const replies = getStore('board-replies');
  const { blobs } = await replies.list({ prefix: `${id}/` });
  await Promise.all(blobs.map(({ key }) => replies.delete(key)));

  await getStore('board-threads').delete(id);

  return json({ success: true, id, repliesDeleted: blobs.length });
});

export const config = {
  method: ['DELETE', 'POST'],
  path: ['/api/v1/board/threads/:id', '/api/board/threads/delete'],
};
