import { route, json, notFound } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { readJson, requiredString, requiredId, cloudinaryUrl, newId, LIMITS } from '../lib/validate.mjs';
import { createChild, exists } from '../lib/store.mjs';

export default route(async (req, context) => {
  const user = await requireUser(req);
  const body = await readJson(req);

  const threadId = requiredId(context.params?.threadId ?? body.threadId, 'threadId');

  if (!(await exists('board-threads', threadId))) throw notFound('That thread no longer exists');

  const reply = {
    id:        newId(),
    threadId,
    body:      requiredString(body.body, 'Reply', LIMITS.reply),
    mediaUrl:  cloudinaryUrl(body.mediaUrl),
    author:    user.email,
    createdAt: new Date().toISOString(),
  };

  // The reply count is the storage layer's problem — an aggregate in Postgres,
  // a read-modify-write in Blobs — and not this handler's.
  await createChild('board-replies', reply);

  return json(reply, 201);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/board/threads/:threadId/replies', '/api/board/replies/create'],
};
