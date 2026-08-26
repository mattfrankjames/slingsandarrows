import { route, json, notFound } from '../lib/http.mjs';
import { requireModerator } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { getStore, getOrThrow } from '../lib/store.mjs';

export default route(async (req, context) => {
  const params = context.params ?? {};
  const body   = params.replyId ? {} : await readJson(req);

  const threadId = requiredId(params.threadId ?? body.threadId, 'threadId');
  const replyId  = requiredId(params.replyId  ?? body.replyId,  'replyId');

  const key   = `${threadId}/${replyId}`;
  const reply = await getOrThrow('board-replies', key, notFound('That reply is already gone'));

  await requireModerator(req, reply.author);
  await getStore('board-replies').delete(key);

  const threads = getStore('board-threads');
  const thread  = await threads.get(threadId, { type: 'json' });
  if (thread) {
    thread.replyCount = Math.max(0, (thread.replyCount || 1) - 1);
    await threads.setJSON(threadId, thread);
  }

  return json({ success: true, threadId, replyId });
});

export const config = {
  method: ['DELETE', 'POST'],
  path: ['/api/v1/board/threads/:threadId/replies/:replyId', '/api/board/replies/delete'],
};
