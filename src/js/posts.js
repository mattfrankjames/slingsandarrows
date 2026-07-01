const feed       = document.getElementById('posts-feed');
const loading    = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isCloudinaryUrl(url) {
  return typeof url === 'string' && url.startsWith('https://res.cloudinary.com/');
}

function isCloudinaryVideo(url) {
  if (!isCloudinaryUrl(url)) return false;
  return url.includes('/video/upload/');
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year:  'numeric',
    month: 'long',
    day:   'numeric',
  });
}

// ─── Get a JWT from Netlify Identity if available ─────────────────────────────
// netlify-identity-widget is only loaded on app.html; on posts.html we access
// the global if it happens to be present (e.g. user opened both pages), but we
// never require it — the delete button is simply hidden when no session exists.
async function getToken() {
  try {
    const identity = window.netlifyIdentity;
    if (!identity) return null;
    const user = identity.currentUser();
    if (!user) return null;
    return await user.jwt();
  } catch {
    return null;
  }
}

// ─── Render a single post card ────────────────────────────────────────────────
function renderPost(post, { pending = false } = {}) {
  const article = document.createElement('article');
  article.className = 'post-card';
  if (pending) {
    article.dataset.pendingId = post.id;
    article.classList.add('post-card--pending');
  }

  if (post.title) {
    const h3 = document.createElement('h3');
    h3.className   = 'post-title';
    h3.textContent = post.title;
    article.appendChild(h3);
  }

  // Media — image or video
  if (isCloudinaryUrl(post.imageUrl)) {
    if (isCloudinaryVideo(post.imageUrl)) {
      const video = document.createElement('video');
      video.className = 'post-image';
      video.controls  = true;
      video.preload   = 'metadata';
      video.setAttribute('playsinline', '');

      const source = document.createElement('source');
      source.src  = post.imageUrl;
      video.appendChild(source);
      article.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.className = 'post-image';
      img.src       = post.imageUrl;
      img.alt       = post.title || '';
      img.loading   = 'lazy';
      article.appendChild(img);
    }
  }

  const p = document.createElement('p');
  p.className   = 'post-body';
  p.textContent = post.body;
  article.appendChild(p);

<<<<<<< HEAD
  // Footer: metadata + optional delete button
=======
  // Footer: meta + optional delete button
>>>>>>> 7e85b5b (fix: wire up delete-post function and auth on posts page)
  const footer = document.createElement('div');
  footer.className = 'post-footer';

  const meta = document.createElement('p');
  meta.className = 'post-meta';
  if (pending) {
    meta.textContent = '⏳ Pending sync…';
    meta.classList.add('post-meta--pending');
  } else {
    meta.textContent = formatDate(post.createdAt);
  }
  footer.appendChild(meta);

<<<<<<< HEAD
  // Delete button — only for published (non-pending) posts
  if (!pending) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className   = 'post-delete-btn';
    deleteBtn.textContent = '✕ Delete';
    deleteBtn.setAttribute('aria-label', 'Delete post');

    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to delete this post?')) return;

      deleteBtn.disabled    = true;
      deleteBtn.textContent = 'Deleting…';

      try {
        const token = await getIdentityToken();

        const res = await fetch('/api/delete-post', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ id: post.id }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || `Server error (${res.status})`);
        }

        // Remove the card from the DOM
        article.remove();
      } catch (err) {
        console.error('[posts] Delete error:', err);
        deleteBtn.disabled    = false;
        deleteBtn.textContent = '✕ Delete';
        alert(`Failed to delete post: ${err.message}`);
      }
    });

    footer.appendChild(deleteBtn);
=======
  // Delete button — only for published posts when a session is active
  if (!pending) {
    const identity = window.netlifyIdentity;
    const isLoggedIn = identity && identity.currentUser();

    if (isLoggedIn) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className   = 'post-delete-btn';
      deleteBtn.textContent = '✕ Delete';
      deleteBtn.setAttribute('aria-label', 'Delete post');

      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete this post?')) return;

        deleteBtn.disabled    = true;
        deleteBtn.textContent = 'Deleting…';

        try {
          const token = await getToken();

          if (!token) {
            throw new Error('Not signed in — please sign in on the App page first.');
          }

          const res = await fetch('/api/delete-post', {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ id: post.id }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Server error (${res.status})`);
          }

          article.remove();
        } catch (err) {
          console.error('[posts] Delete error:', err);
          deleteBtn.disabled    = false;
          deleteBtn.textContent = '✕ Delete';
          alert(`Failed to delete post: ${err.message}`);
        }
      });

      footer.appendChild(deleteBtn);
    }
>>>>>>> 7e85b5b (fix: wire up delete-post function and auth on posts page)
  }

  article.appendChild(footer);
  return article;
}

// ─── Pending-posts banner (offline queue) ─────────────────────────────────────
async function showPendingPosts() {
  let db;
  try {
    db = await openDB();
  } catch {
    return;
  }

  const pending = await getAllPending(db);
  if (!pending.length) return;

  const notice = document.createElement('p');
  notice.id        = 'pending-notice';
  notice.className = 'pending-notice';
  notice.textContent = `${pending.length} post${pending.length > 1 ? 's' : ''} queued — will publish when back online.`;
  feed.before(notice);

  for (const record of pending) {
    feed.insertBefore(
      renderPost({ ...record.data, id: record.id, createdAt: record.createdAt }, { pending: true }),
      feed.firstChild
    );
  }
}

// ─── Listen for SW sync messages ──────────────────────────────────────────────
function listenForSWMessages() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', e => {
    const { type, postId, post } = e.data || {};

    if (type === 'POST_SYNCED') {
      const pendingCard = feed.querySelector(`[data-pending-id="${postId}"]`);
      if (pendingCard && post) {
        pendingCard.replaceWith(renderPost(post));
      } else if (pendingCard) {
        pendingCard.remove();
      }

      if (!feed.querySelector('[data-pending-id]')) {
        document.getElementById('pending-notice')?.remove();
      }
    }
  });
}

// ─── Load published posts from API ───────────────────────────────────────────
async function loadPosts() {
  try {
    const res = await fetch('/api/get-posts');
    if (!res.ok) throw new Error(res.statusText);
    const posts = await res.json();

    loading.hidden = true;

    if (posts.length === 0 && !feed.querySelector('[data-pending-id]')) {
      emptyState.hidden = false;
      return;
    }

    posts.forEach(post => feed.appendChild(renderPost(post)));
  } catch {
    loading.hidden = true;
    if (!feed.children.length) {
      errorState.hidden = false;
    }
  }
}

// ─── IndexedDB helpers (page context) ────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('SlingsArrows', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending-posts')) {
        db.createObjectStore('pending-posts', { keyPath: 'id' });
      }
    };
  });
}

function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(['pending-posts'], 'readonly');
    const req = tx.objectStore('pending-posts').getAll();
    req.onerror  = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || []);
  });
}

// ─── Netlify Identity helpers ─────────────────────────────────────────────────

/**
 * Returns a valid JWT for the currently-logged-in Netlify Identity user,
 * or an empty string if no session exists.
 *
 * `netlifyIdentity.currentUser()` returns null until the widget fires its
 * 'init' event (which restores a persisted session from localStorage).  We
 * wait for that event so that a page refresh doesn't cause a spurious 401.
 */
function getIdentityToken() {
  return new Promise(resolve => {
    const identity = window.netlifyIdentity;
    if (!identity) { resolve(''); return; }

    // If the widget has already initialised (e.g. user navigated here from
    // another page in the same tab), currentUser() is already populated.
    const existing = identity.currentUser();
    if (existing) {
      existing.jwt().then(resolve).catch(() => resolve(''));
      return;
    }

    // Otherwise wait for the 'init' event which fires once the widget has
    // checked localStorage / refreshed the session token.
    identity.on('init', user => {
      if (user) {
        user.jwt().then(resolve).catch(() => resolve(''));
      } else {
        resolve('');
      }
    });

    // Kick off initialisation (safe to call multiple times).
    identity.init();
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  listenForSWMessages();
  await showPendingPosts();
  await loadPosts();
})();
