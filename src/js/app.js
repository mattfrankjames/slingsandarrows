const netlifyIdentity = window.netlifyIdentity;

netlifyIdentity.init({ APIUrl: 'https://slingsandarrows.band/.netlify/identity' });

const authGate        = document.getElementById('auth-gate');
const composerPanel   = document.getElementById('composer-panel');
const userEmailEl     = document.getElementById('user-email');
const loginBtn        = document.getElementById('login-btn');
const logoutBtn       = document.getElementById('logout-btn');
const postForm        = document.getElementById('post-form');
const submitBtn       = document.getElementById('submit-btn');
const statusMsg       = document.getElementById('status-msg');
const installBanner   = document.getElementById('install-banner');
const installBtn      = document.getElementById('install-btn');
const installDismiss  = document.getElementById('install-dismiss');
const imageInput      = document.getElementById('post-image');
const imagePreviewWrap = document.getElementById('image-preview-wrap');
const previewImg      = document.getElementById('preview-img');
const removeImageBtn  = document.getElementById('remove-image-btn');
const uploadStatus    = document.getElementById('upload-status');

// ── Auth ──────────────────────────────────────────────────────────────────────

// Tracks the Cloudinary URL from a successful upload
let pendingImageUrl = null;

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

// ── Image upload ──────────────────────────────────────────────────────────────

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

  uploadStatus.className = 'uploading';
  uploadStatus.textContent = 'Uploading photo…';
  imagePreviewWrap.hidden = true;
  pendingImageUrl = null;

  try {
    const url = await uploadToCloudinary(file);
    pendingImageUrl = url;
    previewImg.src = url;
    imagePreviewWrap.hidden = false;
    uploadStatus.className = '';
    uploadStatus.textContent = '';
  } catch {
    uploadStatus.className = 'error';
    uploadStatus.textContent = 'Photo upload failed — you can still publish without one.';
  }
});

removeImageBtn.addEventListener('click', clearImageState);

// ── Form submit ───────────────────────────────────────────────────────────────

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
      body: JSON.stringify({ title, body, imageUrl: pendingImageUrl || '' }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Unknown error');
    }

    statusMsg.className = 'success';
    statusMsg.textContent = 'Post published!';
    postForm.reset();
    clearImageState();
  } catch (err) {
    statusMsg.className = 'error';
    statusMsg.textContent = `Error: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

// ── PWA install prompt ────────────────────────────────────────────────────────
//
// Rules:
//   1. Never show the banner if the app is already installed (display-mode
//      is standalone / minimal-ui).
//   2. Never show if the user dismissed it within the last 30 days.
//   3. Show as soon as the browser fires `beforeinstallprompt`.
//   4. On "Install" → trigger the native prompt; hide banner on acceptance.
//   5. On "✕" dismiss → record the timestamp in localStorage; hide banner.
//   6. Expose `__swInstallDebug()` on window for manual testing in DevTools.
// ─────────────────────────────────────────────────────────────────────────────

const INSTALL_DISMISSED_KEY    = 'sa-install-dismissed-at';
const INSTALL_DISMISS_COOLDOWN = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

let deferredPrompt = null;

/** Returns true when the app is already running as an installed PWA. */
function isRunningStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    window.navigator.standalone === true // Safari iOS
  );
}

/** Returns true if the user dismissed the banner recently (within cooldown). */
function wasDismissedRecently() {
  const ts = localStorage.getItem(INSTALL_DISMISSED_KEY);
  if (!ts) return false;
  return Date.now() - Number(ts) < INSTALL_DISMISS_COOLDOWN;
}

/** Record a dismissal timestamp so we don't nag the user for 30 days. */
function recordDismissal() {
  localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()));
}

/** Clear any stored dismissal (used by the debug helper). */
function clearDismissal() {
  localStorage.removeItem(INSTALL_DISMISSED_KEY);
}

function showInstallBanner() {
  if (isRunningStandalone()) return;   // already installed — nothing to show
  if (wasDismissedRecently()) return;  // user said "not now" recently
  installBanner.hidden = false;
}

function hideInstallBanner() {
  installBanner.hidden = true;
}

// Capture the deferred prompt as early as possible.
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  console.log('[PWA] beforeinstallprompt captured');
  showInstallBanner();
});

// Native install flow.
installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) {
    console.warn('[PWA] No deferred prompt available — browser may have already prompted.');
    return;
  }
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log('[PWA] Install outcome:', outcome);
  deferredPrompt = null;

  if (outcome === 'accepted') {
    hideInstallBanner();
    clearDismissal(); // fresh install — remove any old dismissal record
  }
  // If dismissed at the native level we leave the banner visible so the user
  // can try again in the same session, but we don't record a localStorage
  // dismissal (they didn't explicitly hit ✕ on our banner).
});

// "✕" dismiss — record so we don't show again for 30 days.
installDismiss.addEventListener('click', () => {
  hideInstallBanner();
  recordDismissal();
  console.log('[PWA] Banner dismissed — will not show again for 30 days.');
});

// Hide the banner if the user installs via the browser's own UI (omnibar etc.)
window.addEventListener('appinstalled', () => {
  console.log('[PWA] App installed via browser UI.');
  hideInstallBanner();
  clearDismissal();
  deferredPrompt = null;
});

// ── Debug helper (accessible in DevTools console) ─────────────────────────────
//
//   __swInstallDebug()            → print current state
//   __swInstallDebug('reset')     → clear dismissal + force-show banner
//   __swInstallDebug('dismiss')   → simulate a dismissal
//   __swInstallDebug('standalone')→ log whether the app thinks it's installed
//
window.__swInstallDebug = function (cmd) {
  switch (cmd) {
    case 'reset':
      clearDismissal();
      console.log('[PWA debug] Dismissal cleared.');
      if (deferredPrompt) {
        showInstallBanner();
        console.log('[PWA debug] Banner shown (deferred prompt is ready).');
      } else {
        console.log('[PWA debug] No deferred prompt available yet — reload the page to re-trigger beforeinstallprompt.');
      }
      break;

    case 'dismiss':
      recordDismissal();
      hideInstallBanner();
      console.log('[PWA debug] Dismissal recorded at', new Date(Number(localStorage.getItem(INSTALL_DISMISSED_KEY))).toLocaleString());
      break;

    case 'standalone':
      console.log('[PWA debug] Running standalone:', isRunningStandalone());
      console.log('[PWA debug] display-mode standalone:', window.matchMedia('(display-mode: standalone)').matches);
      console.log('[PWA debug] display-mode minimal-ui:', window.matchMedia('(display-mode: minimal-ui)').matches);
      console.log('[PWA debug] navigator.standalone (iOS):', window.navigator.standalone);
      break;

    default:
      console.group('[PWA debug] Install prompt state');
      console.log('deferredPrompt ready :', !!deferredPrompt);
      console.log('banner hidden        :', installBanner.hidden);
      console.log('running standalone   :', isRunningStandalone());
      console.log('dismissed recently   :', wasDismissedRecently());
      const ts = localStorage.getItem(INSTALL_DISMISSED_KEY);
      console.log('last dismissal       :', ts ? new Date(Number(ts)).toLocaleString() : 'never');
      console.groupEnd();
  }
};

// ── Service Worker registration ───────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url), { scope: '/' })
    .then(reg => {
      console.log('[SW] Registered. Scope:', reg.scope);

      // Notify the user if a new SW version is waiting to activate.
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('[SW] New version available — will activate on next page load.');
          }
        });
      });
    })
    .catch(err => console.warn('[SW] Registration failed:', err));
}
