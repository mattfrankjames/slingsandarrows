import { route, json, notFound, noStore } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { toggleLike, exists } from '../lib/store.mjs';

/**
 * Like or unlike a post.
 *
 * The concurrency bug this used to carry is now a property of the backend
 * rather than of this handler. On Blobs the count still lives on the post
 * record and is read-modify-write, so two likes arriving together lose one —
 * Blobs offers no compare-and-set and there is no correct version. On Postgres
 * the rows are the count, and the primary key makes a double-like impossible.
 *
 * Both live behind store.toggleLike, which is why this function no longer
 * knows which is which.
 */
export default route(async (req, context) => {
  const user   = await requireUser(req);
  const postId = requiredId(context.params?.postId ?? (await readJson(req)).postId, 'postId');

  if (!(await exists('posts', postId))) throw notFound('That post no longer exists');

  const result = await toggleLike(postId, user.email);
  return json(result, 200, noStore);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/posts/:postId/likes', '/api/posts/likes/toggle'],
};
