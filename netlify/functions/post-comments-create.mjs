import { route, json, notFound } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { readJson, requiredString, requiredId, newId, LIMITS } from '../lib/validate.mjs';
import { getStore } from '../lib/store.mjs';

export default route(async (req, context) => {
  const user = await requireUser(req);
  const body = await readJson(req);

  const postId = requiredId(context.params?.postId ?? body.postId, 'postId');

  const posts = getStore('posts');
  const post  = await posts.get(postId, { type: 'json' });
  if (!post) throw notFound('That post no longer exists');

  const comment = {
    id:        newId(),
    postId,
    body:      requiredString(body.body, 'Comment', LIMITS.comment),
    author:    user.email,
    createdAt: new Date().toISOString(),
  };

  await getStore('post-comments').setJSON(`${postId}/${comment.id}`, comment);

  // Denormalised count for the feed listing. Same read-modify-write caveat as
  // likes — see post-likes-toggle.mjs.
  post.commentCount = (post.commentCount || 0) + 1;
  await posts.setJSON(postId, post);

  return json(comment, 201);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/posts/:postId/comments', '/api/posts/comments/create'],
};
