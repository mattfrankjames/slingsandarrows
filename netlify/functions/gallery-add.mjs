import { route, json, badRequest } from '../lib/http.mjs';
import { requireAuthor } from '../lib/auth.mjs';
import { readJson, optionalString, cloudinaryUrl, newId, LIMITS } from '../lib/validate.mjs';
import { getStore } from '../lib/store.mjs';

export default route(async req => {
  const user = await requireAuthor(req);
  const body = await readJson(req);

  // Unlike posts and threads, a gallery item is nothing but its media — so a
  // rejected URL is an error here rather than a silently dropped field.
  const mediaUrl = cloudinaryUrl(body.mediaUrl);
  if (!mediaUrl) throw badRequest('A Cloudinary media URL is required');

  const item = {
    id:        newId(),
    mediaUrl,
    mediaType: body.mediaType || (mediaUrl.includes('/video/upload/') ? 'video' : 'image'),
    caption:   optionalString(body.caption, 'Caption', LIMITS.caption),
    author:    user.email,
    createdAt: new Date().toISOString(),
  };

  await getStore('gallery').setJSON(item.id, item);
  return json(item, 201);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/gallery', '/api/gallery/add'],
};
