/**
 * validate.mjs — reading and checking what callers send.
 *
 * The rules themselves were already in the codebase; they were just written out
 * longhand in each function, which is how they drifted. Post bodies were capped
 * at no length, comments at 2000, replies at none. Media URLs were checked
 * against the Cloudinary prefix in four places with three spellings. Collecting
 * them here makes the limits reviewable in one screen.
 */

import { badRequest } from './http.mjs';

/** Cloudinary is the only host we will store a media URL for. */
const CLOUDINARY_PREFIX = 'https://res.cloudinary.com/';

/** Field length ceilings, applied on write. */
export const LIMITS = {
  title:   200,
  body:    20_000,
  comment: 2_000,
  reply:   10_000,
  caption: 500,
};

/**
 * Parse a JSON request body, or fail with 400 rather than a 500.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(req) {
  let parsed;
  try {
    parsed = await req.json();
  } catch {
    throw badRequest('Expected a JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Expected a JSON object');
  }
  return parsed;
}

/**
 * A required, non-empty string, trimmed and length-capped.
 *
 * @param {unknown} value
 * @param {string} field  Name used in the error message.
 * @param {number} [max]
 */
export function requiredString(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest(`${field} is required`);
  }
  const trimmed = value.trim();
  if (max && trimmed.length > max) {
    throw badRequest(`${field} must be ${max} characters or fewer`);
  }
  return trimmed;
}

/** Same, but absent/empty is allowed and yields ''. */
export function optionalString(value, field, max) {
  if (value === undefined || value === null || value === '') return '';
  return requiredString(value, field, max);
}

/**
 * Accept a media URL only if Cloudinary served it, otherwise store nothing.
 *
 * Deliberately silent rather than an error: these arrive from our own upload
 * flow, so a non-Cloudinary value means something odd happened and dropping the
 * media is a better outcome than failing the whole post.
 */
export function cloudinaryUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.startsWith(CLOUDINARY_PREFIX) ? raw : '';
}

/**
 * An identifier from a path parameter or body field.
 * Rejects anything with a slash so a caller cannot walk out of a blob prefix.
 */
export function requiredId(value, field = 'id') {
  const id = requiredString(value, field, 128);
  if (id.includes('/') || id.includes('..')) throw badRequest(`${field} is not valid`);
  return id;
}

/**
 * Sortable unique id: millisecond timestamp, then random.
 *
 * The timestamp prefix is load-bearing — store.mjs orders by key to page
 * through blobs without reading them, which only works while these sort
 * chronologically.
 *
 * The format matches what the individual functions generated before, and must
 * keep matching: every id already in the blob stores is an unpadded 13-digit
 * `Date.now()`. Zero-padding these to a fixed width would be the more careful
 * choice for a greenfield store, but here it would sort every new record ahead
 * of every existing one and quietly invert the feed. Unpadded millisecond
 * timestamps stay 13 digits until 2286, so lexicographic order matches
 * chronological order for anything this site will hold.
 */
export function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Read `limit` and `cursor` from a URL, clamped to something sane.
 * @param {Request} req
 */
export function readPageParams(req, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const params = new URL(req.url).searchParams;

  let limit = defaultLimit;
  const raw = params.get('limit');
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1) throw badRequest('limit must be a positive number');
    limit = Math.min(parsed, maxLimit);
  }

  return { limit, cursor: params.get('cursor') || null };
}
