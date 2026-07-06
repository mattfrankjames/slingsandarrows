import { initAuthBar } from './auth-modal.js';

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
  // Cloudinary video URLs contain /video/upload/ in the path
  return url.includes('/video/upload/');
}

// Insert Cloudinary transformation params after /upload/ without double-inserting.
// Uses q_auto so Cloudinary picks optimal quality for each requested format.
function cloudinaryOptimize(url, width) {
  if (!url || !isCloudinaryUrl(url)) return url;
  if (url.includes('/upload/f_auto')) return url; // already optimized
  return url.replace('/upload/', `/upload/f_auto,q_auto,w_${width}/`);
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year:  'numeric',
    month: 'long',
    day:   'numeric',
  });
}

// ─── Get a JWT from Netlify Identity if available ─────────────────────────────
// netlify-identity-widget is loaded on posts.html so window.netlifyIdentity is
// always present; this helper safely reads the JWT from the current session.
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
      video.preload   = 'none'; // don't preload video data until user interacts
      video.setAttribute('playsinline', '');
      video.setAttribute('loading', 'lazy');

      const source = document.createElement('source');
      source.src  = post.imageUrl;
      // Let the browser figure out the MIME type from the URL extension
      video.appendChild(source);
      article.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.className = 'post-image';
      img.alt       = post.title || '';
      img.loading   = 'lazy';
      img.decoding  = 'async';

      // Responsive srcset via Cloudinary on-the-fly transforms.
      // The feed container is capped at 700px; 1400w covers 2× retina.
      img.srcset = [
        `${cloudinaryOptimize(post.imageUrl, 400)} 400w`,
        `${cloudinaryOptimize(post.imageUrl, 700)} 700w`,
        `${cloudinaryOptimize(post.imageUrl, 1400)} 1400w`,
      ].join(', ');
      // Container is max 700px wide; below 736px it fills the viewport.
      img.sizes = '(max-width: 736px) 100vw, 700px';
      img.src   = cloudinaryOptimize(post.imageUrl, 700); // fallback

      article.appendChild(img);
    }
  }

  const p = document.createElement('p');
  p.className   = 'post-body';
  p.textContent = post.body;
  article.appendChild(p);

  // Footer: meta + optional delete button
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
    return; // IndexedDB unavailable — skip silently
  }

  const pending = await getAllPending(db);
  if (!pending.length) return;

  // Insert a notice at the top of the feed
  const notice = document.createElement('p');
  notice.id        = 'pending-notice';
  notice.className = 'pending-notice';
  notice.textContent = `${pending.length} post${pending.length > 1 ? 's' : ''} queued — will publish when back online.`;
  feed.before(notice);

  // Render each queued post as a greyed-out optimistic card
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
      // Replace the pending card with the real published post
      const pendingCard = feed.querySelector(`[data-pending-id="${postId}"]`);
      if (pendingCard && post) {
        pendingCard.replaceWith(renderPost(post));
      } else if (pendingCard) {
        pendingCard.remove();
      }

      // Remove notice if no more pending cards
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
    // Only show error state if we have nothing else to display
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

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  initAuthBar();
  listenForSWMessages();
  await showPendingPosts(); // show offline queue before network posts load
  await loadPosts();
})();
