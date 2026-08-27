import { authModal, initAuthBar, ensureFreshSession } from './auth-modal.js';
import { initPostComposerForm, retryQueuedPostsOnReconnect, syncQueuedPostsIfOnline } from './post-composer.js';
import { currentEmail, clearSession, signOut } from './lib/session.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  // Silently refresh an expired custom-modal session (if a refresh token is
  // available) before initAuth() checks it — otherwise a session older than
  // its 1-hour access token lifetime looks logged-out on every page load.
  await ensureFreshSession();

  // initAuth() works with either auth system — see lib/session.js. We still
  // wait for 'load' so the widget, if present, has initialised before
  // currentEmail() consults it.
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

  const resolveUser = () => {
    const email = currentEmail();
    return email ? { email } : null;
  };

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
      clearSession();
      applyUser(null);
    });
  }

  // Custom auth-modal login event (fired by AuthModal after successful sign-in)
  window.addEventListener('auth-modal:login', e => {
    applyUser({ email: e.detail.email });
  });

  // Login button opens the custom auth modal
  loginBtn.addEventListener('click', () => authModal.open('login'));

  logoutBtn.addEventListener('click', () => {
    const hadWidgetSession = Boolean(identity?.currentUser?.());
    signOut();
    // The widget's 'logout' handler repaints when there was a widget session;
    // otherwise nothing else will.
    if (!hadWidgetSession) applyUser(null);
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
