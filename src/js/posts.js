const feed       = document.getElementById('posts-feed');
const loading    = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');

function isCloudinaryUrl(url) {
  return typeof url === 'string' && url.startsWith('https://res.cloudinary.com/');
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function renderPost(post) {
  const article = document.createElement('article');
  article.className = 'post-card';

  if (post.title) {
    const h3 = document.createElement('h3');
    h3.className = 'post-title';
    h3.textContent = post.title;
    article.appendChild(h3);
  }

  if (isCloudinaryUrl(post.imageUrl)) {
    const img = document.createElement('img');
    img.className = 'post-image';
    img.src = post.imageUrl;
    img.alt = post.title || '';
    img.loading = 'lazy';
    article.appendChild(img);
  }

  const p = document.createElement('p');
  p.className = 'post-body';
  p.textContent = post.body;
  article.appendChild(p);

  const meta = document.createElement('p');
  meta.className = 'post-meta';
  meta.textContent = formatDate(post.createdAt);
  article.appendChild(meta);

  return article;
}

async function loadPosts() {
  try {
    const res = await fetch('/api/get-posts');
    if (!res.ok) throw new Error(res.statusText);
    const posts = await res.json();

    loading.hidden = true;

    if (posts.length === 0) {
      emptyState.hidden = false;
      return;
    }

    posts.forEach(post => feed.appendChild(renderPost(post)));
  } catch {
    loading.hidden = true;
    errorState.hidden = false;
  }
}

loadPosts();

// ── Service Worker registration ───────────────────────────────────────────────
// Register on the public posts page so the SW can cache assets here too.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url), { scope: '/' })
    .then(reg => console.log('[SW] Registered on /posts. Scope:', reg.scope))
    .catch(err => console.warn('[SW] Registration failed:', err));
}
