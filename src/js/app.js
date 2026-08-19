import { authModal, initAuthBar, ensureFreshSession } from './auth-modal.js';

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

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  // Silently refresh an expired custom-modal session (if a refresh token is
  // available) before initAuth() checks it — otherwise a session older than
  // its 1-hour access token lifetime looks logged-out on every page load.
  await ensureFreshSession();
  await postQueue.init();

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
  listenForOnline();
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
  initPostForm();
  initAuthBar();
}

// ─── Post Form ────────────────────────────────────────────────────────────────
function initPostForm() {
  const form          = document.getElementById('post-form');
  const titleInput    = document.getElementById('post-title');
  const bodyInput     = document.getElementById('post-body');
  const mediaInput    = document.getElementById('post-image');
  const previewWrap   = document.getElementById('image-preview-wrap');
  const previewMedia  = document.getElementById('preview-media');
  const removeBtn     = document.getElementById('remove-image-btn');
  const uploadStatus  = document.getElementById('upload-status');
  const statusMsg     = document.getElementById('status-msg');
  const submitBtn     = document.getElementById('submit-btn');

  // selectedMedia: { file: File, type: 'image'|'video'|'audio' } | null
  let selectedMedia = null;

  function clearPreview() {
    previewWrap.hidden = true;
    previewMedia.innerHTML = '';
  }

  function buildPreviewEl(file, type) {
    const objectUrl = URL.createObjectURL(file);
    if (type === 'image') {
      const img = document.createElement('img');
      img.src = objectUrl;
      img.alt = 'Image preview';
      return img;
    }
    if (type === 'video') {
      const video = document.createElement('video');
      video.src = objectUrl;
      video.controls = true;
      video.preload = 'metadata';
      video.setAttribute('playsinline', '');
      return video;
    }
    const audio = document.createElement('audio');
    audio.src = objectUrl;
    audio.controls = true;
    return audio;
  }

  // ── Media picker ──────────────────────────────────────────────────────────
  mediaInput.accept = 'image/*,video/*,audio/*';

  mediaInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    clearUploadStatus(uploadStatus);
    selectedMedia = null;

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');

    if (!isImage && !isVideo && !isAudio) {
      setUploadStatus(uploadStatus, 'Only images, videos, and audio files are supported.', 'error');
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

    const type = isImage ? 'image' : isVideo ? 'video' : 'audio';
    selectedMedia = { file, type };

    // Show local preview immediately (before upload)
    previewMedia.innerHTML = '';
    previewMedia.appendChild(buildPreviewEl(file, type));
    previewWrap.hidden = false;
  });

  removeBtn.addEventListener('click', () => {
    selectedMedia = null;
    mediaInput.value = '';
    clearPreview();
    clearUploadStatus(uploadStatus);
  });

  // ── Insert-link toolbar ─────────────────────────────────────────────────
  initLinkInsertPanel(bodyInput);
  initReadMoreButton(bodyInput);

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
        clearPreview();
        clearUploadStatus(uploadStatus);
      },
    });
  });
}

// ─── Insert-link toolbar ────────────────────────────────────────────────────
// Lets the signed-in author insert a safe `[text](https://…)` link into the
// body textarea. Rendered as a real <a> on the feed by posts.js, which parses
// only this exact syntax — no raw HTML is ever stored, so there's no XSS
// surface even though the feed renders it via innerHTML.
function initLinkInsertPanel(bodyInput) {
  const toggleBtn  = document.getElementById('insert-link-btn');
  const panel      = document.getElementById('link-insert-panel');
  const textInput  = document.getElementById('link-text-input');
  const urlInput   = document.getElementById('link-url-input');
  const confirmBtn = document.getElementById('link-insert-confirm');
  const cancelBtn  = document.getElementById('link-insert-cancel');
  const status     = document.getElementById('link-insert-status');
  if (!toggleBtn || !panel) return;

  let savedSelection = { start: 0, end: 0 };

  toggleBtn.addEventListener('click', () => {
    savedSelection = {
      start: bodyInput.selectionStart ?? bodyInput.value.length,
      end:   bodyInput.selectionEnd   ?? bodyInput.value.length,
    };
    textInput.value = bodyInput.value.slice(savedSelection.start, savedSelection.end);
    urlInput.value = '';
    status.textContent = '';
    status.className = 'link-insert-status';
    panel.hidden = false;
    urlInput.focus();
  });

  cancelBtn.addEventListener('click', () => { panel.hidden = true; });

  confirmBtn.addEventListener('click', () => {
    const text = textInput.value.trim();
    const url  = urlInput.value.trim();

    if (!text || !url) {
      status.textContent = 'Link text and URL are both required.';
      status.className = 'link-insert-status error';
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      status.textContent = 'URL must start with http:// or https://';
      status.className = 'link-insert-status error';
      return;
    }
    // Guard against brackets/parens in the label breaking the [text](url) syntax
    if (/[[\]()]/.test(text)) {
      status.textContent = 'Link text can’t contain [ ] ( ) characters.';
      status.className = 'link-insert-status error';
      return;
    }

    const markup = `[${text}](${url})`;
    const { start, end } = savedSelection;
    const value = bodyInput.value;
    bodyInput.value = value.slice(0, start) + markup + value.slice(end);
    bodyInput.focus();
    const caret = start + markup.length;
    bodyInput.setSelectionRange(caret, caret);

    panel.hidden = true;
  });
}

// ─── Read More break ────────────────────────────────────────────────────────
// Inserts the same marker post-render.js's renderPost() looks for to split a
// post into a feed excerpt + full permalink page. Must stay in sync with
// READ_MORE_MARKER in src/js/post-render.js.
const READ_MORE_MARKER = '<!--more-->';

function initReadMoreButton(bodyInput) {
  const btn = document.getElementById('insert-readmore-btn');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (bodyInput.value.includes(READ_MORE_MARKER)) {
      alert('This post already has a Read More break.');
      return;
    }

    const start = bodyInput.selectionStart ?? bodyInput.value.length;
    const end   = bodyInput.selectionEnd   ?? bodyInput.value.length;
    const value = bodyInput.value;
    const insertion = `\n\n${READ_MORE_MARKER}\n\n`;

    bodyInput.value = value.slice(0, start) + insertion + value.slice(end);
    bodyInput.focus();
    const caret = start + insertion.length;
    bodyInput.setSelectionRange(caret, caret);
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
    const user     = identity?.currentUser();
    let token      = '';
    try {
      if (user) {
        token = await user.jwt();
      } else {
        // Fall back to custom-modal session token stored in localStorage
        const raw = localStorage.getItem('gotrue.user');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.access_token) token = parsed.access_token;
        }
      }
    } catch (err) {
      console.warn('Token fetch failed:', err);
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
