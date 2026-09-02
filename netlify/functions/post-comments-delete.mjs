import { route, json, notFound } from '../lib/http.mjs';
import { requireModerator } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { getChild, deleteChild } from '../lib/store.mjs';

/** Remove a comment. Its author may; so may an admin. */
export default route(async (req, context) => {
  const params = context.params ?? {};
  const body   = params.commentId ? {} : await readJson(req);

  const postId    = requiredId(params.postId    ?? body.postId,    'postId');
  const commentId = requiredId(params.commentId ?? body.commentId, 'commentId');

  const comment = await getChild('post-comments', postId, commentId);
  if (!comment) throw notFound('That comment is already gone');

  await requireModerator(req, comment.author);
  await deleteChild('post-comments', postId, commentId);

  return json({ success: true, postId, commentId });
});

export const config = {
  // POST is tolerated because the previous config accepted it; some clients
  // may still be running from a cached bundle.
  method: ['DELETE', 'POST'],
  path: ['/api/v1/posts/:postId/comments/:commentId', '/api/posts/comments/delete'],
};
