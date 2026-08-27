/**
 * Deterministic content for the visual baselines.
 *
 * The first attempt masked the content containers instead, which produced a
 * feed baseline that was one pink rectangle — every post card hidden, so the
 * refactor those baselines exist to protect could have broken all of them
 * silently. Serving fixed data instead means the cards actually render, and the
 * screenshot covers the layout that Phase 3 is going to move.
 *
 * Dates are fixed so "3 days ago" style formatting cannot drift.
 */

const AUTHOR = 'band@slingsandarrows.test';
const T1 = '2026-01-15T18:30:00.000Z';
const T2 = '2026-01-10T12:00:00.000Z';

export const POSTS = [
  {
    id: '1736966000000-aaaaaaa',
    title: 'A post with a title',
    body: 'Short body copy that exercises the paragraph styling.\n\nA second paragraph, so line height and spacing between blocks are visible.',
    imageUrl: '',
    author: AUTHOR,
    createdAt: T1,
    likeCount: 12,
    commentCount: 3,
  },
  {
    id: '1736966000000-bbbbbbb',
    title: '',
    body: 'An untitled post, which renders without the heading — a distinct layout worth covering.',
    imageUrl: '',
    author: AUTHOR,
    createdAt: T2,
    likeCount: 0,
    commentCount: 0,
  },
];

export const THREADS = [
  {
    id: '1736966000000-ccccccc',
    title: 'A discussion thread',
    body: 'Thread body copy.',
    mediaUrl: '',
    author: AUTHOR,
    replyCount: 2,
    createdAt: T1,
  },
  {
    id: '1736966000000-ddddddd',
    title: 'A thread with no replies',
    body: 'Covers the zero-reply badge state.',
    mediaUrl: '',
    author: AUTHOR,
    replyCount: 0,
    createdAt: T2,
  },
];

export const GALLERY = [
  {
    id: '1736966000000-eeeeeee',
    mediaUrl: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    mediaType: 'image',
    caption: 'A caption',
    author: AUTHOR,
    createdAt: T1,
  },
  {
    id: '1736966000000-fffffff',
    mediaUrl: 'https://res.cloudinary.com/demo/image/upload/sample2.jpg',
    mediaType: 'image',
    caption: '',
    author: AUTHOR,
    createdAt: T2,
  },
];

/**
 * A stand-in for uploaded media.
 *
 * Served in place of every Cloudinary request. Hiding images instead was the
 * first approach and it made the gallery baseline two empty boxes — the tile
 * frames captured, nothing inside them, which is the same failure as masking
 * the feed. An actual image keeps aspect ratio, object-fit and the tile grid
 * under test while staying byte-identical between runs.
 *
 * SVG rather than a binary asset: no file to manage, crisp at any size, and
 * obviously a placeholder if one ever turns up in a diff.
 */
const PLACEHOLDER_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
  <rect width="800" height="600" fill="#1b2740"/>
  <path d="M0 600 L280 300 L470 470 L590 360 L800 560 L800 600 Z" fill="#2c3d63"/>
  <circle cx="620" cy="150" r="70" fill="#3d5285"/>
  <text x="400" y="320" font-family="monospace" font-size="34" fill="#7f92bd"
        text-anchor="middle">test media</text>
</svg>`;

/**
 * Answer the read endpoints from the fixtures above. Both the /api/v1 routes
 * and their legacy aliases, since a page may call either.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function stubContent(page) {
  const json = data => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  });

  await page.route('**/api/v1/posts', route => route.fulfill(json(POSTS)));
  await page.route('**/api/get-posts', route => route.fulfill(json(POSTS)));
  await page.route('**/api/v1/board/threads', route => route.fulfill(json(THREADS)));
  await page.route('**/api/board/threads', route => route.fulfill(json(THREADS)));
  await page.route('**/api/v1/gallery', route => route.fulfill(json(GALLERY)));
  await page.route('**/api/gallery/list', route => route.fulfill(json(GALLERY)));

  await page.route('**/api/v1/me/likes', route =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Unauthorized"}' })
  );

  // Uploaded media, deterministically.
  await page.route('**res.cloudinary.com/**', route =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PLACEHOLDER_IMAGE })
  );
}

/**
 * Present the page with a signed-in session before any script runs.
 *
 * Seeds the same localStorage record the sign-in modal writes, which is what
 * lib/session.js reads. No refresh token, so ensureFreshSession() returns
 * immediately and nothing hits the network.
 *
 * This is what makes the composer surfaces reachable at all: /app renders the
 * auth gate when signed out, and the feed's "+ New Post" button and the
 * gallery's upload button are hidden. Those are the screens most likely to
 * gain features, so they are the ones most worth having a baseline for.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function signIn(page) {
  await page.addInitScript(email => {
    localStorage.setItem('gotrue.user', JSON.stringify({
      access_token: 'test-token-not-valid-server-side',
      expires_at: Date.now() + 86_400_000,
      email,
    }));
  }, AUTHOR);
}
