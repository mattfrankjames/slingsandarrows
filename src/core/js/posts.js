import { initAuthBar, ensureFreshSession } from './auth-modal.js';
import { loadingIndicator } from './lib/loading-state.js';
import { renderPost, loadMyLikes, isLoggedIn } from './post-render.js';
import { postComposerModal } from './post-composer-modal.js';
import { retryQueuedPostsOnReconnect, syncQueuedPostsIfOnline } from './post-composer.js';
import { api } from './lib/api.js';

const feed       = document.getElementById('posts-feed');
const loading    = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');
const newPostBtn = document.getElementById('new-post-btn');

// ─── "+ New Post" button (feed-embedded composer) ──────────────────────────────
// Shown to any signed-in user — same UX-convenience gating used for the
// gallery upload button and the /app composer; the server still enforces
// ALLOWED_AUTHORS on the actual publish (netlify/functions/create-post.mjs).
function initComposerButton() {
  function applyVisibility() {
    if (newPostBtn) newPostBtn.hidden = !isLoggedIn();
  }
  applyVisibility();

  const identity = window.netlifyIdentity;
  if (identity) {
    identity.on('init',   applyVisibility);
    identity.on('login',  applyVisibility);
    identity.on('logout', applyVisibility);
  }
  window.addEventListener('auth-modal:login', applyVisibility);

  newPostBtn?.addEventListener('click', () => postComposerModal.open());
}

// Update (or remove) the "N posts queued" banner above the feed.
function renderPendingNotice(count) {
  let notice = document.getElementById('pending-notice');
  if (count === 0) {
    notice?.remove();
    return;
  }
  if (!notice) {
    notice = document.createElement('p');
    notice.id        = 'pending-notice';
    notice.className = 'pending-notice';
    feed.before(notice);
  }
  notice.textContent = `${count} post${count > 1 ? 's' : ''} queued — will publish when back online.`;
}

// Publishing (or offline-queuing) from the feed's own composer modal should
// show up immediately, the same way the gallery's upload modal prepends a
// new item to the grid instead of waiting on a refetch.
postComposerModal.onPublished((post, { pending } = {}) => {
  emptyState.hidden = true;
  if (pending) {
    feed.insertBefore(
      renderPost({ ...post.data, id: post.id, createdAt: post.createdAt }, { pending: true }),
      feed.firstChild
    );
    renderPendingNotice(feed.querySelectorAll('[data-pending-id]').length);
  } else {
    feed.insertBefore(renderPost(post), feed.firstChild);
  }
});

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

  renderPendingNotice(pending.length);

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
    .register(new URL('../../sw.js', import.meta.url), { scope: '/' })
    .then(reg => syncQueuedPostsIfOnline(reg))
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

      // Update (or remove) the notice to match however many pending cards remain
      renderPendingNotice(feed.querySelectorAll('[data-pending-id]').length);
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
    const posts = await api.posts.list();

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
  const settled = loadingIndicator(loading);
  try {
    const posts = await api.posts.list();

    settled();

    if (posts.length === 0 && !feed.querySelector('[data-pending-id]')) {
      emptyState.hidden = false;
      return;
    }

    posts.forEach(post => feed.appendChild(renderPost(post)));
  } catch {
    settled();
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
  initComposerButton();
  registerServiceWorker();
  listenForSWMessages();
  retryQueuedPostsOnReconnect();
  await loadMyLikes(); // resolve like state before rendering post cards
  await showPendingPosts(); // show offline queue before network posts load
  await loadPosts();
})();
