import { authModal, initAuthBar, ensureFreshSession } from './auth-modal.js';
import { initPostComposerForm, retryQueuedPostsOnReconnect, syncQueuedPostsIfOnline } from './post-composer.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  // Silently refresh an expired custom-modal session (if a refresh token is
  // available) before initAuth() checks it — otherwise a session older than
  // its 1-hour access token lifetime looks logged-out on every page load.
  await ensureFreshSession();

  // initAuth() no longer requires the Netlify Identity widget to be present —
  // it also supports the custom-modal (GoTrue) session stored in localStorage.
  // We still wait for 'load' so the widget (if present) has time to initialise
  // before we call identity.currentUser().
  if (document.readyState === 'complete') {
    initAuth();
  } else {
    window.addEventListener('load', initAuth, { once: true });
  }

  registerServiceWorker();
  listenForSWMessages();
  retryQueuedPostsOnReconnect();
})();

// ─── Auth ─────────────────────────────────────────────────────────────────────
function initAuth() {
  const authGate      = document.getElementById('auth-gate');
  const composerPanel = document.getElementById('composer-panel');
  const userEmailEl   = document.getElementById('user-email');
  const loginBtn      = document.getElementById('login-btn');
  const logoutBtn     = document.getElementById('logout-btn');

  // ── Resolve current user from widget or localStorage ─────────────────────
  function resolveUser() {
    // 1. Netlify Identity widget (preferred)
    const widgetUser = window.netlifyIdentity?.currentUser?.();
    if (widgetUser) return widgetUser;

    // 2. Custom-modal session stored in localStorage
    try {
      const raw = localStorage.getItem('gotrue.user');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.access_token && parsed?.email) {
          if (!parsed.expires_at || parsed.expires_at > Date.now()) {
            return { email: parsed.email };
          }
          localStorage.removeItem('gotrue.user');
        }
      }
    } catch { /* ignore */ }

    return null;
  }

  function applyUser(user) {
    if (user) {
      authGate.hidden         = true;
      composerPanel.hidden    = false;
      userEmailEl.textContent = user.email;
      // Close the custom auth modal in case it was open
      authModal.close();
    } else {
      authGate.hidden         = false;
      composerPanel.hidden    = true;
      userEmailEl.textContent = '';
    }
  }

  // Restore session on page load
  applyUser(resolveUser());

  // Netlify Identity widget events (for users already signed in via widget).
  // The widget itself is initialized by initAuthBar() below, which must run
  // after these listeners are attached so it doesn't fire 'init' before
  // anything is listening for it.
  const identity = window.netlifyIdentity;
  if (identity) {
    identity.on('init',   user => applyUser(user || resolveUser()));
    identity.on('login',  user => { applyUser(user); identity.close(); });
    identity.on('logout', ()   => {
      try { localStorage.removeItem('gotrue.user'); } catch { /* ignore */ }
      applyUser(null);
    });
  }

  // Custom auth-modal login event (fired by AuthModal after successful sign-in)
  window.addEventListener('auth-modal:login', e => {
    applyUser({ email: e.detail.email });
  });

  // Login button opens the custom auth modal
  loginBtn.addEventListener('click', () => authModal.open('login'));

  // Logout: clear custom-modal session and sign out of widget if active
  logoutBtn.addEventListener('click', () => {
    try { localStorage.removeItem('gotrue.user'); } catch { /* ignore */ }
    if (identity?.currentUser?.()) {
      identity.logout();
    } else {
      applyUser(null);
    }
  });

  // Wire the post form once (it's always in the DOM)
  initPostComposerForm();
  initAuthBar();
}

// ─── Service Worker messages ──────────────────────────────────────────────────
function listenForSWMessages() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', e => {
    const { type } = e.data || {};
    if (type === 'POST_SYNCED') {
      console.log('[app] Background sync published post:', e.data.postId);
    }
    if (type === 'POST_SYNC_FAILED') {
      console.warn('[app] Background sync permanently failed for post:', e.data.postId);
    }
  });
}

// ─── Image cache invalidation ─────────────────────────────────────────────────
/**
 * Ask the service worker to evict a specific Cloudinary URL from the image
 * cache.  Used after a post (and its media) is deleted so the stale cached
 * image doesn't persist indefinitely.
 *
 * @param {string} imageUrl  - The Cloudinary URL to remove from the cache.
 */
async function invalidateImageCache(imageUrl) {
  if (!imageUrl) return;
  try {
    // Fast path: remove directly from the Cache API (same origin context).
    if ('caches' in window) {
      const cache = await caches.open('sa-images-v1');
      await cache.delete(imageUrl);
    }
    // Belt-and-suspenders: also tell the SW so it can clean up any variant
    // requests it may have stored (e.g. with different Accept headers).
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'INVALIDATE_IMAGE',
        url:  imageUrl,
      });
    }
  } catch (err) {
    // Non-fatal — the image will eventually be evicted by the LRU trim.
    console.warn('[app] invalidateImageCache error:', err);
  }
}

// ─── Service Worker registration ──────────────────────────────────────────────
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url), { scope: '/' })
    .then(reg => {
      console.log('[app] SW registered, scope:', reg.scope);
      syncQueuedPostsIfOnline(reg);
    })
    .catch(err => console.warn('[app] SW registration failed:', err));
}
