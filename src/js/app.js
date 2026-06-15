import netlifyIdentity from 'netlify-identity-widget';

netlifyIdentity.init();

const authGate      = document.getElementById('auth-gate');
const composerPanel = document.getElementById('composer-panel');
const userEmailEl   = document.getElementById('user-email');
const loginBtn      = document.getElementById('login-btn');
const logoutBtn     = document.getElementById('logout-btn');
const postForm      = document.getElementById('post-form');
const submitBtn     = document.getElementById('submit-btn');
const statusMsg     = document.getElementById('status-msg');
const installBanner = document.getElementById('install-banner');
const installBtn    = document.getElementById('install-btn');
const installDismiss = document.getElementById('install-dismiss');

function setAuthUI(user) {
  if (user) {
    authGate.hidden = true;
    composerPanel.hidden = false;
    userEmailEl.textContent = user.email;
  } else {
    authGate.hidden = false;
    composerPanel.hidden = true;
    userEmailEl.textContent = '';
  }
}

setAuthUI(netlifyIdentity.currentUser());

netlifyIdentity.on('login', user => {
  setAuthUI(user);
  netlifyIdentity.close();
});

netlifyIdentity.on('logout', () => setAuthUI(null));

loginBtn.addEventListener('click', () => netlifyIdentity.open('login'));
logoutBtn.addEventListener('click', () => netlifyIdentity.logout());

postForm.addEventListener('submit', async e => {
  e.preventDefault();

  const title = document.getElementById('post-title').value;
  const body  = document.getElementById('post-body').value;

  submitBtn.disabled = true;
  statusMsg.className = '';
  statusMsg.textContent = 'Publishing…';

  try {
    const user  = netlifyIdentity.currentUser();
    const token = await user.jwt();

    const res = await fetch('/api/create-post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ title, body }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Unknown error');
    }

    statusMsg.className = 'success';
    statusMsg.textContent = 'Post published!';
    postForm.reset();
  } catch (err) {
    statusMsg.className = 'error';
    statusMsg.textContent = `Error: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

// PWA install prompt
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  installBanner.hidden = false;
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') installBanner.hidden = true;
  deferredPrompt = null;
});

installDismiss.addEventListener('click', () => {
  installBanner.hidden = true;
});

// Service worker — Parcel resolves the URL and bundles sw.js as a separate worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: '/' })
    .catch(err => console.warn('SW registration failed:', err));
}
