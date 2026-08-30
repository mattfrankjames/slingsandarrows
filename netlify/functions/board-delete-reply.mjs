import { route, json, notFound } from '../lib/http.mjs';
import { requireModerator } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { getChild, deleteChild } from '../lib/store.mjs';

export default route(async (req, context) => {
  const params = context.params ?? {};
  const body   = params.replyId ? {} : await readJson(req);

  const threadId = requiredId(params.threadId ?? body.threadId, 'threadId');
  const replyId  = requiredId(params.replyId  ?? body.replyId,  'replyId');

  const reply = await getChild('board-replies', threadId, replyId);
  if (!reply) throw notFound('That reply is already gone');

  await requireModerator(req, reply.author);
  await deleteChild('board-replies', threadId, replyId);

  return json({ success: true, threadId, replyId });
});

export const config = {
  method: ['DELETE', 'POST'],
  path: ['/api/v1/board/threads/:threadId/replies/:replyId', '/api/board/replies/delete'],
};
