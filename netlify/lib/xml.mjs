/**
 * xml.mjs — escaping and response helpers for the RSS feeds.
 * `escapeXml` was defined identically at the bottom of both feed functions.
 */

/** Escape text for inclusion in an XML element or attribute. */
export function escapeXml(value) {
  if (!value) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** An RSS response with the right content type and a short cache. */
export function rss(body, { maxAge = 300 } = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  });
}

/**
 * How many items a feed carries. Readers show a recent window, and the whole
 * feed is regenerated on every request, so there is no reason to serialise the
 * entire archive into every response.
 */
export const FEED_LIMIT = 50;
