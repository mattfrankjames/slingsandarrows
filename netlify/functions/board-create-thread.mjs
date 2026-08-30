import { route, json } from '../lib/http.mjs';
import { requireUser } from '../lib/auth.mjs';
import { readJson, requiredString, cloudinaryUrl, newId, LIMITS } from '../lib/validate.mjs';
import { putRecord } from '../lib/store.mjs';

/** Start a board thread. Open to any signed-in user. */
export default route(async req => {
  const user = await requireUser(req);
  const body = await readJson(req);

  const thread = {
    id:         newId(),
    title:      requiredString(body.title, 'Title', LIMITS.title),
    body:       requiredString(body.body, 'Message', LIMITS.reply),
    mediaUrl:   cloudinaryUrl(body.mediaUrl),
    author:     user.email,
    replyCount: 0,
    createdAt:  new Date().toISOString(),
  };

  await putRecord('board-threads', thread);
  return json(thread, 201);
});

export const config = {
  method: 'POST',
  path: ['/api/v1/board/threads', '/api/board/threads/create'],
};
