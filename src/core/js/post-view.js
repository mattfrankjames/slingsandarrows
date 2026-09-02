import { initAuthBar, ensureFreshSession } from './auth-modal.js';
import { loadingIndicator } from './lib/loading-state.js';
import { renderPost, loadMyLikes } from './post-render.js';
import { api } from './lib/api.js';

const loading    = document.getElementById('loading');
const errorState = document.getElementById('error-state');
/**
 * The site's own name, taken from the title the page was served with rather
 * than written in here. post.html ships `<title>Slings &amp; Arrows | Post</title>`,
 * so everything before the separator is the part worth keeping when the title
 * becomes "<post title> — <site>".
 *
 * Captured at module load, before the title is rewritten.
 */
const SITE_TITLE = document.title.split('|')[0].trim() || document.title;

const detail     = document.getElementById('post-detail');

function getPostId() {
  // /post/<id> is served (status 200 rewrite) as this same page's content,
  // but the browser's address bar — and window.location — never changes:
  // Netlify only passes ?id=:splat to the *file lookup* server-side, it's
  // never exposed to client-side JS. So the id has to be read from the
  // pathname the user actually navigated to, not the (always-empty) query
  // string. Falls back to ?id= for direct /post.html?id=... access.
  const pathMatch = window.location.pathname.match(/^\/post\/(.+)$/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  return new URLSearchParams(window.location.search).get('id');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register(new URL('../../sw.js', import.meta.url), { scope: '/' })
    .catch(err => console.warn('[post-view] SW registration failed:', err));
}

(async () => {
  await ensureFreshSession();
  initAuthBar();
  registerServiceWorker();

  const id = getPostId();
  if (!id) {
    // No fetch is coming, so there is nothing to indicate. The element is
    // already hidden in the markup; this is the error path, not a wait.
    errorState.hidden = false;
    return;
  }

  const settled = loadingIndicator(loading);

  try {
    const posts = await api.posts.list();
    const post = posts.find(p => p.id === id);

    settled();

    if (!post) {
      errorState.hidden = false;
      return;
    }

    await loadMyLikes();
    document.title = post.title ? `${post.title} — ${SITE_TITLE}` : SITE_TITLE;
    detail.appendChild(renderPost(post, { fullView: true }));
  } catch (err) {
    console.warn('[post-view] load error:', err);
    settled();
    errorState.hidden = false;
  }
})();
