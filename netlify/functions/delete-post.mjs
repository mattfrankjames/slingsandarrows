import { route, json, notFound } from '../lib/http.mjs';
import { requireAuthor } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { getStore } from '../lib/store.mjs';

/**
 * Delete a post. Any band member may remove any post — that was the existing
 * rule and it is preserved here.
 *
 * The id arrives as a path parameter on /api/v1/posts/:id and in the body on
 * the legacy route, so both are accepted.
 *
 * Known gap, unchanged by this refactor: the post's comments and likes are left
 * behind in their own stores. Blobs has no cascade and no transaction to make
 * a multi-store delete safe, so this waits for Phase 4's foreign keys rather
 * than getting a best-effort loop that can fail halfway.
 */
export default route(async (req, context) => {
  await requireAuthor(req);

  const id = context.params?.id
    ? requiredId(context.params.id)
    : requiredId((await readJson(req)).id, 'Post id');

  const store = getStore('posts');
  if (!await store.get(id, { type: 'json' })) throw notFound('That post no longer exists');

  await store.delete(id);
  return json({ success: true, id });
});

export const config = {
  method: 'DELETE',
  path: ['/api/v1/posts/:id', '/api/delete-post'],
};
