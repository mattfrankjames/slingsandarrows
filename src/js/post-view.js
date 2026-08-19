import { initAuthBar, ensureFreshSession } from './auth-modal.js';
import { renderPost, loadMyLikes } from './post-render.js';

const loading    = document.getElementById('loading');
const errorState = document.getElementById('error-state');
const detail     = document.getElementById('post-detail');

function getPostId() {
  // /post/:id is rewritten by Netlify to /post.html?id=:id
  return new URLSearchParams(window.location.search).get('id');
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url), { scope: '/' })
    .catch(err => console.warn('[post-view] SW registration failed:', err));
}

(async () => {
  await ensureFreshSession();
  initAuthBar();
  registerServiceWorker();

  const id = getPostId();
  if (!id) {
    loading.hidden = true;
    errorState.hidden = false;
    return;
  }

  try {
    const res = await fetch('/api/get-posts');
    if (!res.ok) throw new Error(res.statusText);
    const posts = await res.json();
    const post = posts.find(p => p.id === id);

    loading.hidden = true;

    if (!post) {
      errorState.hidden = false;
      return;
    }

    await loadMyLikes();
    document.title = `${post.title ? post.title + ' — ' : ''}Slings & Arrows`;
    detail.appendChild(renderPost(post, { fullView: true }));
  } catch (err) {
    console.warn('[post-view] load error:', err);
    loading.hidden = true;
    errorState.hidden = false;
  }
})();
