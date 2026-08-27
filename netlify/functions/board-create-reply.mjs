import { route, json, notFound } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { readJson, requiredString, requiredId, cloudinaryUrl, newId, LIMITS } from '../lib/validate.mjs';
import { getStore } from '../lib/store.mjs';

export default route(async (req, context) => {
  const user = await requireUser(req);
  const body = await readJson(req);

  const threadId = requiredId(context.params?.threadId ?? body.threadId, 'threadId');

  const threads = getStore('board-threads');
  const thread  = await threads.get(threadId, { type: 'json' });
  if (!thread) throw notFound('That thread no longer exists');

  const reply = {
    id:        newId(),
    threadId,
    body:      requiredString(body.body, 'Reply', LIMITS.reply),
    mediaUrl:  cloudinaryUrl(body.mediaUrl),
    author:    user.email,
    createdAt: new Date().toISOString(),
  };

  await getStore('board-replies').setJSON(`${threadId}/${reply.id}`, reply);

  // Denormalised badge count. board-get-threads reconciles it on read, because
  // this increment is read-modify-write and can lose a concurrent update.
  thread.replyCount = (thread.replyCount || 0) + 1;
  await threads.setJSON(threadId, thread);

  return json(reply, 201);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/board/threads/:threadId/replies', '/api/board/replies/create'],
};
