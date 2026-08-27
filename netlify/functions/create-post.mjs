import { route, json } from '../lib/http.mjs';
import { requireAuthor } from '../lib/auth.mjs';
import { readJson, requiredString, optionalString, cloudinaryUrl, newId, LIMITS } from '../lib/validate.mjs';
import { getStore } from '../lib/store.mjs';

export default route(async req => {
  const user = await requireAuthor(req);
  const body = await readJson(req);

  const post = {
    id:        newId(),
    title:     optionalString(body.title, 'Title', LIMITS.title),
    body:      requiredString(body.body, 'Post body', LIMITS.body),
    imageUrl:  cloudinaryUrl(body.imageUrl),
    author:    user.email,
    createdAt: new Date().toISOString(),
  };

  await getStore('posts').setJSON(post.id, post);
  return json(post, 201);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/posts', '/api/create-post'],
};
