// ─── IndexedDB offline queue ──────────────────────────────────────────────────
class PostQueue {
  constructor() {
    this._db = null;
  }

  async init() {
    if (this._db) return;
    this._db = await new Promise((resolve, reject) => {
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

  _tx(mode) {
    return this._db.transaction(['pending-posts'], mode).objectStore('pending-posts');
  }

  add(postData, token) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const record = { id, data: postData, token, createdAt: new Date().toISOString() };
    return new Promise((resolve, reject) => {
      const req = this._tx('readwrite').add(record);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(record);
    });
  }

  remove(id) {
    return new Promise((resolve, reject) => {
      const req = this._tx('readwrite').delete(id);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve();
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      const req = this._tx('readonly').getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result || []);
    });
  }
}

// ─── Media helpers ────────────────────────────────────────────────────────────
const CLOUDINARY_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

/**
 * Compress an image File to WebP at ≤1920×1080, quality 0.82.
 * Returns a Blob.
 */
async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = ev => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX_W = 1920;
        const MAX_H = 1080;
        let { width, height } = img;

        if (width > MAX_W) { height = Math.round(height * MAX_W / width); width = MAX_W; }
        if (height > MAX_H) { width = Math.round(width * MAX_H / height); height = MAX_H; }

        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          blob => blob ? resolve(blob) : reject(new Error('Canvas toBlob failed')),
          'image/webp',
          0.82
        );
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Return the duration (seconds) of a video File without loading the full file.
 */
function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    const src = URL.createObjectURL(file);
    video.onloadedmetadata = () => { URL.revokeObjectURL(src); resolve(video.duration); };
    video.onerror = () => { URL.revokeObjectURL(src); reject(new Error('Could not read video')); };
    video.src = src;
  });
}

/**
 * Upload a File/Blob to Cloudinary using the unsigned upload preset.
 * Uses the "auto" resource type so both images and videos are handled.
 * Returns the Cloudinary response JSON.
 */
async function uploadToCloudinary(file) {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_PRESET) {
    console.error('Cloudinary env vars missing:', { CLOUDINARY_CLOUD, CLOUDINARY_PRESET });
    throw new Error('Cloudinary configuration missing');
  }

  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CLOUDINARY_PRESET);

  console.log('Uploading to Cloudinary:', { cloud: CLOUDINARY_CLOUD, preset: CLOUDINARY_PRESET });

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`,
    { method: 'POST', body: fd }
  );

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    console.error('Cloudinary error response:', detail);
    throw new Error(detail?.error?.message || `Cloudinary upload failed (${res.status})`);
  }

  const result = await res.json();
  console.log('Cloudinary response:', result);
  return result;
}

// ─── Globals ──────────────────────────────────────────────────────────────────
const postQueue = new PostQueue();
let deferredInstallPrompt = null;

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  await postQueue.init();

  // Netlify Identity widget loads asynchronously (async attribute on the script
  // tag), so window.netlifyIdentity may not exist yet when this module runs.
  // We try immediately, then fall back to the window 'load' event which fires
  // after all scripts have finished executing.
  if (window.netlifyIdentity) {
    initAuth();
  } else {
    window.addEventListener('load', () => {
      if (window.netlifyIdentity) {
        initAuth();
      } else {
        console.error('[app] Netlify Identity widget failed to load');
      }
    });
  }

  initInstallPrompt();
  registerServiceWorker();
  listenForSWMessages();
  listenForOnline();
})();

// ─── Auth ─────────────────────────────────────────────────────────────────────
function initAuth() {
  const identity = window.netlifyIdentity;
  if (!identity) {
    console.warn('[app] netlifyIdentity not available yet');
    return;
  }

  identity.init({ APIUrl: 'https://slingsandarrows.band/.netlify/identity' });

  const authGate      = document.getElementById('auth-gate');
  const composerPanel = document.getElementById('composer-panel');
  const userEmailEl   = document.getElementById('user-email');
  const loginBtn      = document.getElementById('login-btn');
  const logoutBtn     = document.getElementById('logout-btn');
  const installHelp   = document.getElementById('install-help');
  const installBanner = document.getElementById('install-banner');

  function applyUser(user) {
    if (user) {
      authGate.hidden      = true;
      composerPanel.hidden = false;
      userEmailEl.textContent = user.email;

      // Close any open modals when user logs in
      if (installHelp) installHelp.hidden = true;
      if (installBanner) installBanner.hidden = true;
    } else {
      authGate.hidden      = false;
      composerPanel.hidden = true;
      userEmailEl.textContent = '';
    }
  }

  // Restore session on page load
  applyUser(identity.currentUser());

  identity.on('init',   user => applyUser(user));
  identity.on('login',  user => {
    applyUser(user);
    identity.close();
  });
  identity.on('logout', ()   => applyUser(null));

  loginBtn.addEventListener('click',  () => identity.open('login'));
  logoutBtn.addEventListener('click', () => identity.logout());

  // Wire the post form once (it's always in the DOM)
  initPostForm();
}

// ─── Post Form ────────────────────────────────────────────────────────────────
function initPostForm() {
  const form          = document.getElementById('post-form');
  const titleInput    = document.getElementById('post-title');
  const bodyInput     = document.getElementById('post-body');
  const mediaInput    = document.getElementById('post-image');
  const previewWrap   = document.getElementById('image-preview-wrap');
  const previewImg    = document.getElementById('preview-img');
  const removeBtn     = document.getElementById('remove-image-btn');
  const uploadStatus  = document.getElementById('upload-status');
  const statusMsg     = document.getElementById('status-msg');
  const submitBtn     = document.getElementById('submit-btn');

  // selectedMedia: { file: File, type: 'image'|'video' } | null
  let selectedMedia = null;

  // ── Media picker ──────────────────────────────────────────────────────────
  mediaInput.accept = 'image/*,video/*';

  mediaInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    clearUploadStatus(uploadStatus);
    selectedMedia = null;

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');

    if (!isImage && !isVideo) {
      setUploadStatus(uploadStatus, 'Only images and videos are supported.', 'error');
      mediaInput.value = '';
      return;
    }

    if (isVideo) {
      try {
        const duration = await getVideoDuration(file);
        if (duration > 120) {
          setUploadStatus(uploadStatus, 'Videos must be under 2 minutes.', 'error');
          mediaInput.value = '';
          return;
        }
      } catch {
        setUploadStatus(uploadStatus, 'Could not read video metadata.', 'error');
        mediaInput.value = '';
        return;
      }
    }

    selectedMedia = { file, type: isImage ? 'image' : 'video' };

    // Show local preview immediately (before upload)
    const objectUrl = URL.createObjectURL(file);
    previewImg.src = objectUrl;
    previewImg.alt = isVideo ? 'Video preview' : 'Image preview';
    previewWrap.hidden = false;
  });

  removeBtn.addEventListener('click', () => {
    selectedMedia = null;
    mediaInput.value = '';
    previewWrap.hidden = true;
    previewImg.src = '';
    clearUploadStatus(uploadStatus);
  });

  // ── Submit ────────────────────────────────────────────────────────────────
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await handleSubmit({
      title:       titleInput.value,
      body:        bodyInput.value,
      media:       selectedMedia,
      form,
      submitBtn,
      uploadStatus,
      statusMsg,
      onSuccess:   () => {
        selectedMedia = null;
        mediaInput.value = '';
        previewWrap.hidden = true;
        previewImg.src = '';
        clearUploadStatus(uploadStatus);
      },
    });
  });
}

async function handleSubmit({ title, body, media, form, submitBtn, uploadStatus, statusMsg, onSuccess }) {
  submitBtn.disabled = true;
  setStatus(statusMsg, 'Publishing…', '');

  try {
    let mediaUrl = '';

    // ── Media upload ────────────────────────────────────────────────────────
    if (media) {
      let fileToUpload = media.file;

      if (media.type === 'image') {
        setUploadStatus(uploadStatus, 'Compressing image…', 'uploading');
        try {
          fileToUpload = await compressImage(media.file);
        } catch (err) {
          console.warn('Compression failed, using original:', err);
          fileToUpload = media.file;
        }
      }

      setUploadStatus(uploadStatus, 'Uploading media…', 'uploading');
      try {
        const result = await uploadToCloudinary(fileToUpload);
        mediaUrl = result.secure_url;
        console.log('Cloudinary upload successful, mediaUrl:', mediaUrl);
        clearUploadStatus(uploadStatus);
      } catch (err) {
        console.error('Cloudinary upload failed:', err);
        setUploadStatus(uploadStatus, `Media upload failed: ${err.message}`, 'error');
        // Continue without media rather than blocking entirely
        mediaUrl = '';
      }
    }

    // ── Prepare post data ───────────────────────────────────────────────────
    const postData = {
      title:    title.trim(),
      body:     body.trim(),
      imageUrl: mediaUrl,
    };

    console.log('Post data being sent:', postData);

    // ── Get auth token ──────────────────────────────────────────────────────
    const identity = window.netlifyIdentity;
    const user     = identity.currentUser();
    let token      = '';
    try {
      token = user ? await user.jwt() : '';
    } catch (err) {
      console.warn('JWT fetch failed:', err);
    }

    // ── Check connectivity ──────────────────────────────────────────────────
    if (!navigator.onLine) {
      await queueOfflinePost(postData, token, statusMsg);
      form.reset();
      onSuccess();
      return;
    }

    // ── Send to backend ─────────────────────────────────────────────────────
    const res = await fetch('/api/create-post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(postData),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(errData.error || `Server error (${res.status})`);
    }

    // ── SUCCESS ─────────────────────────────────────────────────────────────
    setStatus(statusMsg, '✓ Post published!', 'success');
    form.reset();
    onSuccess();

    setTimeout(() => {
      statusMsg.textContent = '';
      statusMsg.className   = '';
    }, 2500);

  } catch (err) {
    console.error('[app] Post error:', err);
    setStatus(statusMsg, `✕ ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

async function queueOfflinePost(postData, token, statusMsg) {
  await postQueue.add(postData, token);
  setStatus(statusMsg, '📱 Saved offline — will publish when back online.', 'success');

  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('sync-posts');
    } catch {
      // Background sync not available — online listener will retry
    }
  }
}

// ─── Retry queued posts when back online ──────────────────────────────────────
function listenForOnline() {
  window.addEventListener('online', async () => {
    const pending = await postQueue.getAll().catch(() => []);
    if (!pending.length) return;

    for (const record of pending) {
      try {
        const res = await fetch('/api/create-post', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(record.token ? { Authorization: `Bearer ${record.token}` } : {}),
          },
          body: JSON.stringify(record.data),
        });

        if (res.ok) {
          await postQueue.remove(record.id);
        } else if (res.status >= 400 && res.status < 500) {
          // Unrecoverable — drop it
          await postQueue.remove(record.id);
        }
      } catch {
        // Still offline or transient error — leave in queue
      }
    }
  });
}

// ─── Service Worker messages ──────────────────────────────────────────────────
function listenForSWMessages() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', e => {
    const { type } = e.data || {};
    if (type === 'POST_SYNCED') {
      console.log('[app] Background sync published post:', e.data.postId);
      // Remove from local queue in case the online listener didn't catch it
      postQueue.remove(e.data.postId).catch(() => {});
    }
    if (type === 'POST_SYNC_FAILED') {
      console.warn('[app] Background sync permanently failed for post:', e.data.postId);
    }
  });
}

// ─── PWA install prompt ───────────────────────────────────────────────────────

/**
 * Detect platform characteristics for install-flow branching.
 * We avoid sniffing the full UA string where possible; these checks are
 * deliberately coarse — we only need to know whether the
 * `beforeinstallprompt` API is available.
 */
function detectPlatform() {
  const ua = navigator.userAgent;
  // iOS: iPhone, iPad (including iPadOS 13+ which reports as Macintosh)
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  // Safari but not Chrome/Edge/Firefox (those all include "Chrome" or "Firefox")
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgA/.test(ua);
  const isFirefox = /Firefox|FxiOS/.test(ua);
  return { isIOS, isSafari, isFirefox };
}

function updateBannerText(text) {
  const span = document.querySelector('#install-banner > span');
  if (span) span.textContent = text;
}

function initInstallPrompt() {
  const banner     = document.getElementById('install-banner');
  const installBtn = document.getElementById('install-btn');
  const dismissBtn = document.getElementById('install-dismiss');

  if (!banner) return;

  const { isIOS, isSafari, isFirefox } = detectPlatform();

  // ── iOS Safari: no programmatic install API ───────────────────────────────
  if (isIOS && isSafari) {
    // Only show once per session — don't nag on every visit
    if (!sessionStorage.getItem('install-banner-dismissed')) {
      banner.hidden = false;
      updateBannerText('Tap Share ↗ then "Add to Home Screen" to install');
      if (installBtn) installBtn.hidden = true; // no programmatic prompt
      if (dismissBtn) dismissBtn.textContent = 'Got it';
    }
    // Always surface the how-to guide on iOS (users frequently need it)
    const helpEl = document.getElementById('install-help');
    if (helpEl) helpEl.hidden = false;
  }

  // ── Firefox: no beforeinstallprompt, but does support PWA install via menu ─
  else if (isFirefox) {
    if (!sessionStorage.getItem('install-banner-dismissed')) {
      banner.hidden = false;
      updateBannerText('Install via browser menu: ⋯ → Add to Home Screen');
      if (installBtn) installBtn.hidden = true;
      if (dismissBtn) dismissBtn.textContent = 'Dismiss';
    }
    const helpEl = document.getElementById('install-help');
    if (helpEl) helpEl.hidden = false;
  }

  // ── Chrome / Edge / Samsung Internet: beforeinstallprompt available ───────
  else {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (!sessionStorage.getItem('install-banner-dismissed')) {
        banner.hidden = false;
        updateBannerText('Add to Home Screen for quick access');
      }
    });

    installBtn?.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      console.log('[app] Install prompt outcome:', outcome);
      deferredInstallPrompt = null;
      banner.hidden = true;
    });

    window.addEventListener('appinstalled', () => {
      console.log('[app] PWA installed');
      deferredInstallPrompt = null;
      banner.hidden = true;
      sessionStorage.setItem('install-banner-dismissed', 'true');
    });
  }

  // ── Dismiss handler (all platforms) ──────────────────────────────────────
  dismissBtn?.addEventListener('click', () => {
    banner.hidden = true;
    sessionStorage.setItem('install-banner-dismissed', 'true');
  });
}

// ─── Service Worker registration ──────────────────────────────────────────────
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url), { scope: '/' })
    .then(reg => {
      console.log('[app] SW registered, scope:', reg.scope);

      // Attempt to sync any queued posts on load (covers case where SW sync
      // fired while the page was closed and we now have stale queue entries)
      postQueue.getAll().then(pending => {
        if (pending.length && navigator.onLine && 'SyncManager' in window) {
          reg.sync.register('sync-posts').catch(() => {});
        }
      });
    })
    .catch(err => console.warn('[app] SW registration failed:', err));
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(el, text, cls) {
  el.textContent = text;
  el.className   = cls;
}

function setUploadStatus(el, text, cls) {
  el.textContent = text;
  el.className   = cls;
}

function clearUploadStatus(el) {
  el.textContent = '';
  el.className   = '';
}
