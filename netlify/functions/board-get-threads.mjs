import { route, json, cacheFor } from '../lib/http.mjs';
import { readPageParams } from '../lib/validate.mjs';
import { page, countUnder, getStore } from '../lib/store.mjs';

/**
 * Board threads, newest first.
 *
 * Reply counts are reconciled against the reply store, because the stored
 * `replyCount` drifts — a delete that fails partway, or two replies racing on
 * the same read-modify-write, and the badge is wrong until something corrects
 * it. That reconciliation is why this used to be the most expensive endpoint
 * on the site: it listed every thread, read every thread, then listed every
 * thread's replies, then wrote back any thread whose count disagreed.
 *
 * Two things make it cheaper here. Only the current page is reconciled rather
 * than the whole board, and counting uses a key listing instead of reading
 * reply records. It still writes on a GET, which is the wrong shape; that
 * disappears in Phase 4 when the count becomes an aggregate and cannot drift.
 */
export default route(async req => {
  const { limit, cursor } = readPageParams(req, { defaultLimit: 0 });

  const { items: threads, nextCursor, total } = await page('board-threads', {
    limit: limit || undefined,
    cursor,
  });

  const store = getStore('board-threads');
  await Promise.all(threads.map(async thread => {
    try {
      const actual = await countUnder('board-replies', `${thread.id}/`);
      if (thread.replyCount !== actual) {
        thread.replyCount = actual;
        await store.setJSON(thread.id, thread);
      }
    } catch {
      // Reply store unavailable — serve the stored count rather than failing
      // the whole listing over a badge.
    }
  }));

  return json(limit ? { threads, nextCursor, total } : threads, 200, cacheFor(30));
});

export const config = {
  method: 'GET',
  path: ['/api/v1/board/threads', '/api/board/threads'],
};
