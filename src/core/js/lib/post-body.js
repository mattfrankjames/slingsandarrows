// Post-body → HTML. Pure (no DOM), so it can be unit-tested in Node.
//
// The whole body is escaped first, so a post can never inject arbitrary
// markup. Only two exact patterns become real tags afterwards:
//   - the composer's `[text](https://…)` link syntax → <a>
//   - a YouTube video (pasted "Share → Embed" iframe snippet, or a bare
//     YouTube URL on its own line) → an iframe we build ourselves from the
//     validated 11-character video ID. Nothing from the pasted iframe's
//     attributes is kept.

const VIDEO_ID = '([A-Za-z0-9_-]{11})';

// YouTube's own embed snippet: <iframe … src="https://www.youtube.com/embed/ID…" …></iframe>
const IFRAME_RE = new RegExp(
  String.raw`<iframe\b[^>]*?\bsrc\s*=\s*["']https?://(?:www\.)?youtube(?:-nocookie)?\.com/embed/` +
    VIDEO_ID +
    String.raw`[^"']*["'][^>]*>\s*</iframe>`,
  'gi'
);

// A YouTube watch / share / shorts / live URL alone on a line.
const BARE_URL_RE = new RegExp(
  String.raw`^[ \t]*https?://(?:(?:www\.|m\.)?youtube\.com/(?:watch\?(?:[^\s#]*&)?v=|shorts/|live/|embed/)|youtu\.be/)` +
    VIDEO_ID +
    String.raw`[^\s]*[ \t]*$`,
  'gm'
);

// Private-use code point: survives escapeHtml untouched and can't be typed
// into a post by accident (we strip any that are there anyway).
const MARK = '';
const TOKEN_RE = new RegExp(String.raw`\n?${MARK}(\d+)${MARK}\n?`, 'g');

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function youTubeEmbedHtml(id) {
  // `id` has already matched [A-Za-z0-9_-]{11}, so it's safe in an attribute.
  // A <span> (styled display:block) because the body renders inside a <p>.
  return (
    '<span class="post-embed">' +
    `<iframe src="https://www.youtube-nocookie.com/embed/${id}" title="YouTube video player"` +
    ' loading="lazy" referrerpolicy="strict-origin-when-cross-origin"' +
    ' allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"' +
    ' allowfullscreen></iframe></span>'
  );
}

export function renderBodyHtml(body) {
  const ids = [];
  const stash = (_m, id) => `${MARK}${ids.push(id) - 1}${MARK}`;

  const withTokens = String(body ?? '')
    .split(MARK).join('')
    .replace(IFRAME_RE, stash)
    .replace(BARE_URL_RE, stash);

  return escapeHtml(withTokens)
    .replace(
      /\[([^[\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g,
      (_match, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
    )
    // Swallow one newline either side so pre-wrap doesn't add blank gaps
    // around the (block-level) player.
    .replace(TOKEN_RE, (_m, n) => youTubeEmbedHtml(ids[Number(n)]));
}
