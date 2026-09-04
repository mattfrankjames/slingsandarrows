import { route, json } from '../lib/http.mjs';
import { backendName, exists } from '../lib/store.mjs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Which data backend this deploy is actually serving, and whether it answers.
 *
 * store.mjs has reported `backendName()` since the cutover, but nothing asked
 * it, so USE_POSTGRES could be set — or unset, or misspelled — with no way to
 * tell from outside which store a deploy was really reading. That is the whole
 * risk of promoting behind a flag: the flag is not the evidence, the response
 * is.
 *
 * The lookup is a miss by construction. It costs one indexed read and proves
 * the round trip, which a bare `backendName()` would not: a deploy can be
 * flagged for Postgres while DATABASE_URL is wrong, and that must read as
 * unhealthy rather than as a confident "postgres".
 */
export default route(async () => {
  const backend = backendName();
  try {
    await exists('posts', '__health__');
    return json({ ok: true, backend }, 200, NO_STORE);
  } catch {
    // Deliberately not the error: it can carry a connection string.
    return json({ ok: false, backend }, 503, NO_STORE);
  }
});

export const config = {
  method: 'GET',
  path: '/api/v1/health',
};
