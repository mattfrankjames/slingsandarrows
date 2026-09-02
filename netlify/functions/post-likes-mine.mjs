import { route, json, noStore } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { likedPostIds } from '../lib/store.mjs';

/**
 * The postIds the signed-in user has liked.
 *
 * One query answers this for the whole feed, so the page initialises every
 * heart from a single request. How that query is answered differs by backend:
 * Blobs keys likes `${email}::${postId}` and lists by prefix, Postgres has an
 * index on the email column.
 *
 * Explicitly no-store: this is per-user, and a shared cache keyed by URL alone
 * would hand one person's likes to the next. The service worker skips
 * authenticated requests for the same reason.
 */
export default route(async req => {
  const user = await requireUser(req);
  const postIds = await likedPostIds(user.email);

  return json({ postIds }, 200, noStore);
});

export const config = {
  method: 'GET',
  path: ['/api/v1/me/likes', '/api/posts/likes/mine'],
};
