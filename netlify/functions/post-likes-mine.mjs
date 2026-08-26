import { route, json, noStore } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { getStore } from '../lib/store.mjs';

/**
 * The postIds the signed-in user has liked.
 *
 * Likes are keyed `${email}::${postId}`, so one prefix query answers this for
 * the whole feed — the page initialises every heart from a single request.
 *
 * Explicitly no-store: this is per-user, and a shared cache keyed by URL alone
 * would hand one person's likes to the next. The service worker skips
 * authenticated requests for the same reason.
 */
export default route(async req => {
  const user   = await requireUser(req);
  const prefix = `${user.email.toLowerCase()}::`;

  const { blobs } = await getStore('post-likes').list({ prefix });
  const postIds = blobs.map(({ key }) => key.slice(prefix.length));

  return json({ postIds }, 200, noStore);
});

export const config = {
  method: 'GET',
  path: ['/api/v1/me/likes', '/api/posts/likes/mine'],
};
