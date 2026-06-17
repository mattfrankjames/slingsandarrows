/**
 * app.js — Slings & Arrows post composer
 *
 * Handles:
 *  • Netlify Identity auth (login / logout / session restore)
 *  • Image upload to Cloudinary
 *  • Post submission to /api/create-post
 *  • PWA install flow (Android/Chrome + iOS Safari guidance)
 *  • Service Worker registration
 */

/* ─── Auth ────────────────────────────────────────────────────────────────── */

const netlifyIdentity = window.netlifyIdentity;
netlifyIdentity.init({ APIUrl: 'https://slingsandarrows.band/.netlify/identity' });

const authGate      = document.getElementById('auth-gate');
const composerPanel = document.getElementById('composer-panel');
const userEmailEl   = document.getElementById('user-email');
const loginBtn      = document.getElementById('login-btn');
const logoutBtn     = document.getElementById('logout-btn');

function setAuthUI(user) {
  if (user) {
    authGate.hidden      = true;
    composerPanel.hidden = false;
    userEmailEl.textContent = user.email;
  } else {
    authGate.hidden      = false;
    composerPanel.hidden = true;
    userEmailEl.textContent = '';
  }
}

setAuthUI(netlifyIdentity.currentUser());
netlifyIdentity.on('login',  user => { setAuthUI(user); netlifyIdentity.close(); });
netlifyIdentity.on('logout', ()   => setAuthUI(null));

loginBtn.addEventListener('click',  () => netlifyIdentity.open('login'));
logoutBtn.addEventListener('click', () => netlifyIdentity.logout());

/* ─── Image upload ────────────────────────────────────────────────────────── */

const postForm       = document.getElementById('post-form');
const submitBtn      = document.getElementById('submit-btn');
const statusMsg      = document.getElementById('status-msg');
const imageInput     = document.getElementById('post-image');
const imagePreviewWrap = document.getElementById('image-preview-wrap');
const previewImg     = document.getElementById('preview-img');
const removeImageBtn = document.getElementById('remove-image-btn');
const uploadStatus   = document.getElementById('upload-status');

let pendingImageUrl = null;

async function uploadToCloudinary(file) {
  const cloudName    = process.env.CLOUDINARY_CLOUD_NAME;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', uploadPreset);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: 'POST', body: formData }
  );
  if (!res.ok) throw new Error('Upload failed');
  const data = await res.json();
  return data.secure_url;
}

function clearImageState() {
  pendingImageUrl = null;
  imageInput.value = '';
  imagePreviewWrap.hidden = true;
  previewImg.src = '';
  uploadStatus.className = '';
  uploadStatus.textContent = '';
}

imageInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;

  uploadStatus.className   = 'uploading';
  uploadStatus.textContent = 'Uploading photo…';
  imagePreviewWrap.hidden  = true;
  pendingImageUrl          = null;

  try {
    const url       = await uploadToCloudinary(file);
    pendingImageUrl = url;
    previewImg.src  = url;
    imagePreviewWrap.hidden = false;
    uploadStatus.className  = '';
    uploadStatus.textContent = '';
  } catch {
    uploadStatus.className   = 'error';
    uploadStatus.textContent = 'Photo upload failed — you can still publish without one.';
  }
});

removeImageBtn.addEventListener('click', clearImageState);

/* ─── Form submit ─────────────────────────────────────────────────────────── */

postForm.addEventListener('submit', async e => {
  e.preventDefault();

  const title = document.getElementById('post-title').value;
  const body  = document.getElementById('post-body').value;

  submitBtn.disabled       = true;
  statusMsg.className      = '';
  statusMsg.textContent    = 'Publishing…';

  try {
    const user  = netlifyIdentity.currentUser();
    const token = await user.jwt();

    const res = await fetch('/api/create-post', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ title, body, imageUrl: pendingImageUrl || '' }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Unknown error');
    }

    statusMsg.className   = 'success';
    statusMsg.textContent = 'Post published!';
    postForm.reset();
    clearImageState();
  } catch (err) {
    statusMsg.className   = 'error';
    statusMsg.textContent = `Error: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

/* ─── PWA Install flow ────────────────────────────────────────────────────── */

const DISMISS_KEY  = 'pwa-install-dismissed';
const INSTALLED_KEY = 'pwa-installed';

const installBanner  = document.getElementById('install-banner');
const installBtn     = document.getElementById('install-btn');
const installDismiss = document.getElementById('install-dismiss');

// iOS Safari banner (separate element — see app.html)
const iosBanner      = document.getElementById('ios-install-banner');
const iosDismiss     = document.getElementById('ios-install-dismiss');

let deferredPrompt = null;

/** Persist dismiss decision for 30 days */
function dismissInstall() {
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
  try { localStorage.setItem(DISMISS_KEY, String(expires)); } catch { /* private mode */ }
}

function isDismissed() {
  try {
    const val = localStorage.getItem(DISMISS_KEY);
    if (!val) return false;
    if (Date.now() > Number(val)) { localStorage.removeItem(DISMISS_KEY); return false; }
    return true;
  } catch { return false; }
}

function isAlreadyInstalled() {
  // matchMedia detects standalone mode (PWA already installed & running)
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true   // iOS Safari standalone
    || document.referrer.includes('android-app://');
}

/* ── Android / Chrome (beforeinstallprompt) ── */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;

  if (!isAlreadyInstalled() && !isDismissed()) {
    installBanner.hidden = false;
  }
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  installBanner.hidden = true;
  deferredPrompt.prompt();

  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;

  if (outcome === 'accepted') {
    try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* ok */ }
  }
});

installDismiss.addEventListener('click', () => {
  installBanner.hidden = true;
  dismissInstall();
});

/* ── appinstalled — fires when the app is added to the home screen ── */
window.addEventListener('appinstalled', () => {
  installBanner.hidden = true;
  if (iosBanner) iosBanner.hidden = true;
  deferredPrompt = null;
  try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* ok */ }
  console.log('[PWA] App installed successfully.');
});

/* ── iOS Safari install guidance ── */
function isIosSafari() {
  const ua  = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua);
  // Chrome on iOS has 'CriOS', Firefox has 'FxiOS' — we only show for Safari
  const safari = /safari/i.test(ua) && !/crios|fxios|opios|mercury/i.test(ua);
  return ios && safari;
}

if (iosBanner && isIosSafari() && !isAlreadyInstalled() && !isDismissed()) {
  iosBanner.hidden = false;
}

if (iosDismiss) {
  iosDismiss.addEventListener('click', () => {
    if (iosBanner) iosBanner.hidden = true;
    dismissInstall();
  });
}

/* ─── Service Worker registration ────────────────────────────────────────── */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(new URL('../sw.js', import.meta.url), { scope: '/' })
      .then(reg => {
        console.log('[SW] Registered, scope:', reg.scope);

        // Notify the user when a new SW version is waiting
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // A new version is available — show a subtle update nudge
              showUpdateBanner();
            }
          });
        });
      })
      .catch(err => console.warn('[SW] Registration failed:', err));
  });
}

function showUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (banner) banner.hidden = false;
}

// Wire up the update banner reload button (element defined in app.html)
const updateBanner    = document.getElementById('update-banner');
const updateReloadBtn = document.getElementById('update-reload-btn');
const updateDismissBtn = document.getElementById('update-dismiss-btn');

if (updateReloadBtn) {
  updateReloadBtn.addEventListener('click', () => {
    window.location.reload();
  });
}
if (updateDismissBtn) {
  updateDismissBtn.addEventListener('click', () => {
    if (updateBanner) updateBanner.hidden = true;
  });
}
