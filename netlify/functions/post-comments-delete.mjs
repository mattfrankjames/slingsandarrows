import { route, json, notFound } from '../lib/http.mjs';
import { requireModerator } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { getStore, getOrThrow } from '../lib/store.mjs';

/** Remove a comment. Its author may; so may an admin. */
export default route(async (req, context) => {
  const params = context.params ?? {};
  const body   = params.commentId ? {} : await readJson(req);

  const postId    = requiredId(params.postId    ?? body.postId,    'postId');
  const commentId = requiredId(params.commentId ?? body.commentId, 'commentId');

  const comments = getStore('post-comments');
  const key      = `${postId}/${commentId}`;
  const comment  = await getOrThrow('post-comments', key, notFound('That comment is already gone'));

  await requireModerator(req, comment.author);
  await comments.delete(key);

  const posts = getStore('posts');
  const post  = await posts.get(postId, { type: 'json' });
  if (post) {
    post.commentCount = Math.max(0, (post.commentCount || 1) - 1);
    await posts.setJSON(postId, post);
  }

  return json({ success: true, postId, commentId });
});

export const config = {
  // POST is tolerated because the previous config accepted it; some clients
  // may still be running from a cached bundle.
  method: ['DELETE', 'POST'],
  path: ['/api/v1/posts/:postId/comments/:commentId', '/api/posts/comments/delete'],
};
