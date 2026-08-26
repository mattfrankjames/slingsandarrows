// Shared post-composer logic — powers both the standalone /app page (app.js)
// and the feed's inline "+ New Post" modal (post-composer-modal.js), so the
// two entry points can never drift out of sync. Assumes the #post-form
// markup (and its child field IDs) is present in the document wherever
// initPostComposerForm() is called.

import { uploadToCloudinary } from './lib/media.js';

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

const postQueue = new PostQueue();
let queueReady = null;

function ensureQueueReady() {
  if (!queueReady) queueReady = postQueue.init();
  return queueReady;
}

// ─── Media helpers ────────────────────────────────────────────────────────────
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

// ─── Insert-link toolbar ────────────────────────────────────────────────────
// Lets the signed-in author insert a safe `[text](https://…)` link into the
// body textarea. Rendered as a real <a> on the feed by post-render.js, which
// parses only this exact syntax — no raw HTML is ever stored.
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

// ─── Submit ───────────────────────────────────────────────────────────────────
async function queueOfflinePost(postData, token, statusMsg) {
  await ensureQueueReady();
  const record = await postQueue.add(postData, token);
  setStatus(statusMsg, '📱 Saved offline — will publish when back online.', 'success');

  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('sync-posts');
    } catch {
      // Background sync not available — the reconnect listener will retry
    }
  }
  return record;
}

async function handleSubmit({ title, body, media, form, submitBtn, uploadStatus, statusMsg, onSuccess, onPublished, onQueuedOffline }) {
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

    // ── Get auth token ──────────────────────────────────────────────────────
    const identity = window.netlifyIdentity;
    const user     = identity?.currentUser();
    let token      = '';
    try {
      if (user) {
        token = await user.jwt();
      } else {
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
      const record = await queueOfflinePost(postData, token, statusMsg);
      form.reset();
      onSuccess();
      onQueuedOffline?.(record);
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
    const createdPost = await res.json();

    setStatus(statusMsg, '✓ Post published!', 'success');
    form.reset();
    onSuccess();
    onPublished?.(createdPost);

    setTimeout(() => {
      statusMsg.textContent = '';
      statusMsg.className   = '';
    }, 2500);

  } catch (err) {
    console.error('[post-composer] Post error:', err);
    setStatus(statusMsg, `✕ ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}

// ─── Public: draft-guard helper for embedding modals ──────────────────────────
export function hasDraftContent() {
  const title = document.getElementById('post-title');
  const body  = document.getElementById('post-body');
  const media = document.getElementById('post-image');
  return !!(title?.value.trim() || body?.value.trim() || media?.files?.length);
}

// ─── Public: wire the #post-form markup wherever it lives in the DOM ─────────
/**
 * @param {object} [hooks]
 * @param {(post: object) => void} [hooks.onPublished] - called with the
 *   server's created-post JSON after a successful publish.
 * @param {(record: object) => void} [hooks.onQueuedOffline] - called with the
 *   IndexedDB queue record after a post is saved for offline sync.
 * @returns {{ reset: () => void }}
 */
export function initPostComposerForm({ onPublished, onQueuedOffline } = {}) {
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

  function resetForm() {
    form.reset();
    selectedMedia = null;
    mediaInput.value = '';
    clearPreview();
    clearUploadStatus(uploadStatus);
    setStatus(statusMsg, '', '');
  }

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
      onPublished,
      onQueuedOffline,
    });
  });

  return { reset: resetForm };
}

// ─── Public: opportunistically retry queued posts right after SW registration ─
// Covers the case where Background Sync fired while the page was closed and
// left stale queue entries, or the browser lacks Background Sync entirely —
// called once from each entry point's registerServiceWorker() success handler.
export async function syncQueuedPostsIfOnline(reg) {
  await ensureQueueReady();
  const pending = await postQueue.getAll().catch(() => []);
  if (pending.length && navigator.onLine && 'SyncManager' in window) {
    try {
      await reg.sync.register('sync-posts');
    } catch {
      // Background sync not available — the reconnect listener will retry
    }
  }
}

// ─── Public: retry queued posts once connectivity returns ─────────────────────
// Background Sync (registered in queueOfflinePost) handles this on browsers
// that support it, even if the tab is closed. This is the fallback for
// browsers without SyncManager (e.g. Safari) — it only fires while a page
// that called this is open, so both entry points (app.js and posts.js) call
// it to cover a post queued from either the /app page or the feed modal.
export function retryQueuedPostsOnReconnect() {
  window.addEventListener('online', async () => {
    await ensureQueueReady();
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
