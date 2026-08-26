import { route, json, notFound } from '../lib/http.mjs';
import { requireModerator } from '../lib/auth.mjs';
import { readJson, requiredId } from '../lib/validate.mjs';
import { getStore, getOrThrow } from '../lib/store.mjs';

export default route(async (req, context) => {
  const id = context.params?.id
    ? requiredId(context.params.id)
    : requiredId((await readJson(req)).id, 'Item id');

  const item = await getOrThrow('gallery', id, notFound('That item is already gone'));
  await requireModerator(req, item.author);

  await getStore('gallery').delete(id);
  return json({ success: true, id });
});

export const config = {
  method: ['DELETE', 'POST'],
  path: ['/api/v1/gallery/:id', '/api/gallery/delete'],
};
