/**
 * http.mjs — request/response plumbing shared by every function.
 *
 * Before this, each function hand-built its own responses. `{'Content-Type':
 * 'application/json'}` appeared 97 times across 20 files, every handler had its
 * own try/catch, and every one of those catches did this:
 *
 *     return new Response(JSON.stringify({ error: err.message }), { status: 500 })
 *
 * — which hands the caller whatever an internal failure happened to say. Blob
 * store names, stack-adjacent detail, driver messages. Errors are now logged
 * server-side and answered with something deliberately uninformative, unless
 * they are an HttpError, whose message we wrote on purpose.
 */

/** JSON response with the right header. The one place that header is spelled. */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * An error that is safe to show the caller.
 *
 * Anything thrown that is *not* one of these is treated as a bug and reported
 * as a generic 500, so a new failure mode can never start leaking internals
 * just because someone threw a raw Error.
 */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const badRequest   = msg => new HttpError(400, msg);
export const unauthorized = (msg = 'Sign in to do that')      => new HttpError(401, msg);
export const forbidden    = (msg = 'You cannot do that')      => new HttpError(403, msg);
export const notFound     = (msg = 'Not found')               => new HttpError(404, msg);
export const conflict     = msg => new HttpError(409, msg);

/**
 * Wrap a handler with the error handling every function needs.
 *
 * HTTP method filtering is not done here — `config.method` already stops
 * Netlify from invoking the function at all, so a guard inside would be dead
 * code that still needs maintaining.
 *
 * @param {(req: Request, context: object) => Promise<Response>} handler
 */
export function route(handler) {
  return async (req, context) => {
    try {
      return await handler(req, context);
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: err.message }, err.status);
      }

      // A genuine bug. Log everything, tell the caller nothing.
      console.error(`[${new URL(req.url).pathname}]`, err);
      return json({ error: 'Something went wrong. Try again.' }, 500);
    }
  };
}

/**
 * Cache-Control for public, cacheable reads. Kept here so the values are
 * consistent and visible in one place rather than sprinkled per-function.
 */
export const cacheFor = seconds => ({ 'Cache-Control': `public, max-age=${seconds}` });

/** For responses that must never be stored — anything user-specific. */
export const noStore = { 'Cache-Control': 'no-store' };
