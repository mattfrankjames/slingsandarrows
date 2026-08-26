import { route, json, notFound, noStore } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { getStore } from '../lib/store.mjs';

/**
 * Like or unlike a post.
 *
 * Known gap, unchanged by this refactor: likeCount is read-modify-write on the
 * post record, so two simultaneous likes both read the same value and one is
 * lost. Blobs offers no compare-and-set, so there is no correct fix at this
 * layer — Phase 4 makes it an aggregate. The per-user like rows are always
 * right; only the cached count can drift.
 */
export default route(async (req, context) => {
  const user   = await requireUser(req);
  const postId = requiredId(context.params?.postId ?? (await readJson(req)).postId, 'postId');

  const posts = getStore('posts');
  const post  = await posts.get(postId, { type: 'json' });
  if (!post) throw notFound('That post no longer exists');

  const likes   = getStore('post-likes');
  const likeKey = `${user.email.toLowerCase()}::${postId}`;
  const liked   = !(await likes.get(likeKey));

  if (liked) {
    await likes.setJSON(likeKey, { postId, email: user.email.toLowerCase(), createdAt: new Date().toISOString() });
    post.likeCount = (post.likeCount || 0) + 1;
  } else {
    await likes.delete(likeKey);
    post.likeCount = Math.max(0, (post.likeCount || 1) - 1);
  }

  await posts.setJSON(postId, post);
  return json({ liked, likeCount: post.likeCount }, 200, noStore);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/posts/:postId/likes', '/api/posts/likes/toggle'],
};
