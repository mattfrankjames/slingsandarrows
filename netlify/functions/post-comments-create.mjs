import { route, json, notFound } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { readJson, requiredString, requiredId, newId, LIMITS } from '../lib/validate.mjs';
import { createChild, exists } from '../lib/store.mjs';

export default route(async (req, context) => {
  const user = await requireUser(req);
  const body = await readJson(req);

  const postId = requiredId(context.params?.postId ?? body.postId, 'postId');

  if (!(await exists('posts', postId))) throw notFound('That post no longer exists');

  const comment = {
    id:        newId(),
    postId,
    body:      requiredString(body.body, 'Comment', LIMITS.comment),
    author:    user.email,
    createdAt: new Date().toISOString(),
  };

  // The comment count is the storage layer's problem — an aggregate in
  // Postgres, a read-modify-write in Blobs — and not this handler's.
  await createChild('post-comments', comment);

  return json(comment, 201);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/posts/:postId/comments', '/api/posts/comments/create'],
};
