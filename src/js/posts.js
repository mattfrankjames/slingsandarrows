import { initAuthBar, ensureFreshSession } from './auth-modal.js';
import { renderPost, loadMyLikes } from './post-render.js';

const feed       = document.getElementById('posts-feed');
const loading    = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');

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

// ─── Service Worker registration + messages ────────────────────────────────────
// Registers the SW so the feed benefits from its stale-while-revalidate /api/
// caching (instant repaint on repeat visits) even for visitors who land here
// without ever going through /app first.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url), { scope: '/' })
    .catch(err => console.warn('[posts] SW registration failed:', err));
}

function listenForSWMessages() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', e => {
    const { type, postId, post, url } = e.data || {};

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

    // The SW revalidated /api/get-posts in the background and found the
    // response actually changed — silently re-render instead of leaving
    // stale content on screen until the user manually reloads.
    if (type === 'API_UPDATED' && url?.includes('/api/get-posts')) {
      refreshPostsSilently();
    }
  });
}

// ─── Silent background refresh ─────────────────────────────────────────────────
async function refreshPostsSilently() {
  try {
    const res = await fetch('/api/get-posts');
    if (!res.ok) return;
    const posts = await res.json();

    await loadMyLikes(); // like counts/state may have moved too

    // Replace only published cards — leave any pending (offline-queued) ones
    feed.querySelectorAll('.post-card:not([data-pending-id])').forEach(el => el.remove());

    if (posts.length === 0 && !feed.querySelector('[data-pending-id]')) {
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
      posts.forEach(post => feed.appendChild(renderPost(post)));
    }
  } catch (err) {
    console.warn('[posts] refreshPostsSilently error:', err);
  }
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
  await ensureFreshSession(); // refresh an expired session before any auth checks below
  initAuthBar();
  registerServiceWorker();
  listenForSWMessages();
  await loadMyLikes(); // resolve like state before rendering post cards
  await showPendingPosts(); // show offline queue before network posts load
  await loadPosts();
})();
