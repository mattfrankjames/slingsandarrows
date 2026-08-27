/**
 * api.js — every call to our own backend goes through here.
 *
 * The pattern this replaces appeared a dozen times: fetch a token by hand,
 * spread a conditional Authorization header, check `res.ok`, try to pull an
 * `error` field out of the body, fall back to a status code, throw. Each copy
 * got the error path slightly differently wrong — some surfaced
 * "Server error (403)" to the reader, some swallowed the response entirely.
 *
 * Endpoints are named here rather than spelled at call sites, so the routes are
 * listed in one place and the /api/v1 move didn't touch six files.
 */

import { getToken } from './session.js';

/** An HTTP error carrying the status, so callers can branch on 401 vs 404. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Turn a failed response into an ApiError with the most useful message
 * available: the server's own text when it sent one, otherwise something
 * readable. The backend answers errors as `{ error }` (see netlify/lib/http).
 */
async function toError(res) {
  let message = '';
  try {
    message = (await res.json())?.error || '';
  } catch {
    // Non-JSON error body — a proxy or platform error page.
  }

  if (!message) {
    if (res.status === 401) message = 'Your session expired — sign in again';
    else if (res.status === 403) message = 'You do not have permission to do that';
    else if (res.status === 404) message = 'That is no longer available';
    else if (res.status >= 500) message = 'The server had a problem. Try again.';
    else message = `Request failed (${res.status})`;
  }
  return new ApiError(res.status, message);
}

/**
 * @param {string} path
 * @param {object} [opts]
 * @param {'GET'|'POST'|'DELETE'} [opts.method]
 * @param {unknown} [opts.body]      Serialised as JSON when present.
 * @param {boolean} [opts.auth]      Attach a bearer token. Throws 401 if none.
 * @param {AbortSignal} [opts.signal]
 */
async function request(path, { method = 'GET', body, auth = false, signal } = {}) {
  const headers = {};

  if (auth) {
    const token = await getToken();
    // Fail here rather than letting the server answer 401, so the caller gets
    // the same ApiError shape either way.
    if (!token) throw new ApiError(401, 'Sign in to do that');
    headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'You appear to be offline');
  }

  if (!res.ok) throw await toError(res);
  if (res.status === 204) return null;

  return res.json();
}

// ── Endpoints ────────────────────────────────────────────────────────────────
// Paths are /api/v1/*. The previous /api/* routes still resolve — the functions
// answer to both — so a page loaded from a stale cache keeps working.

const q = encodeURIComponent;

export const api = {
  posts: {
    list:   ({ limit, cursor, signal } = {}) =>
      request(`/api/v1/posts${pageQuery(limit, cursor)}`, { signal }),
    create: post => request('/api/v1/posts', { method: 'POST', body: post, auth: true }),
    remove: id   => request(`/api/v1/posts/${q(id)}`, { method: 'DELETE', auth: true }),

    comments: {
      list:   postId => request(`/api/v1/posts/${q(postId)}/comments`),
      create: (postId, body) =>
        request(`/api/v1/posts/${q(postId)}/comments`, { method: 'POST', body: { body }, auth: true }),
      remove: (postId, commentId) =>
        request(`/api/v1/posts/${q(postId)}/comments/${q(commentId)}`, { method: 'DELETE', auth: true }),
    },

    toggleLike: postId =>
      request(`/api/v1/posts/${q(postId)}/likes`, { method: 'POST', auth: true }),
  },

  me: {
    likes: () => request('/api/v1/me/likes', { auth: true }),
  },

  board: {
    threads: {
      list:   ({ limit, cursor } = {}) => request(`/api/v1/board/threads${pageQuery(limit, cursor)}`),
      create: thread => request('/api/v1/board/threads', { method: 'POST', body: thread, auth: true }),
      remove: id     => request(`/api/v1/board/threads/${q(id)}`, { method: 'DELETE', auth: true }),
    },
    replies: {
      list:   threadId => request(`/api/v1/board/threads/${q(threadId)}/replies`),
      create: (threadId, reply) =>
        request(`/api/v1/board/threads/${q(threadId)}/replies`, { method: 'POST', body: reply, auth: true }),
      remove: (threadId, replyId) =>
        request(`/api/v1/board/threads/${q(threadId)}/replies/${q(replyId)}`, { method: 'DELETE', auth: true }),
    },
  },

  gallery: {
    list:   ({ limit, cursor } = {}) => request(`/api/v1/gallery${pageQuery(limit, cursor)}`),
    add:    item => request('/api/v1/gallery', { method: 'POST', body: item, auth: true }),
    remove: id   => request(`/api/v1/gallery/${q(id)}`, { method: 'DELETE', auth: true }),
  },

  uploads: {
    signature: () => request('/api/v1/uploads/signature', { method: 'POST', auth: true }),
  },
};

function pageQuery(limit, cursor) {
  if (!limit) return '';
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  return `?${params}`;
}
