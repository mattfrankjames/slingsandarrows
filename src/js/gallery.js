// ─── Constants ────────────────────────────────────────────────────────────────
import { initAuthBar } from './auth-modal.js';

const CLOUDINARY_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

// ─── State ────────────────────────────────────────────────────────────────────
/** @type {Array<{id:string, mediaUrl:string, mediaType:string, caption:string, createdAt:string}>} */
let galleryItems = [];
let lightboxIndex = 0;
let isAdmin = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const grid        = document.getElementById('gallery-grid');
const loading     = document.getElementById('loading');
const emptyState  = document.getElementById('empty-state');
const errorState  = document.getElementById('error-state');
const uploadBtn   = document.getElementById('upload-btn');

// Lightbox
const lightbox       = document.getElementById('lightbox');
const lightboxClose  = document.getElementById('lightbox-close');
const lightboxWrap   = document.getElementById('lightbox-media-wrap');
const lightboxPrev   = document.getElementById('lightbox-prev');
const lightboxNext   = document.getElementById('lightbox-next');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxCounter = document.getElementById('lightbox-counter');

// Upload modal
const uploadModal   = document.getElementById('upload-modal');
const modalClose    = document.getElementById('modal-close');
const modalCancel   = document.getElementById('modal-cancel');
const authGate      = document.getElementById('gallery-auth-gate');
const loginBtn      = document.getElementById('login-btn');
const uploadForm    = document.getElementById('upload-form');
const mediaFileInput = document.getElementById('media-file');
const previewWrap   = document.getElementById('media-preview-wrap');
const previewEl     = document.getElementById('media-preview');
const removeMediaBtn = document.getElementById('remove-media-btn');
const mediaStatus   = document.getElementById('media-status');
const captionInput  = document.getElementById('media-caption');
const uploadSubmit  = document.getElementById('upload-submit-btn');
const formStatus    = document.getElementById('form-status');

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  initAuthBar();
  initAuth();
  await loadGallery();
  initLightbox();
  initUploadModal();
})();

// ─── Authentication ───────────────────────────────────────────────────────────
function initAuth() {
  const identity = window.netlifyIdentity;
  identity.init({ APIUrl: 'https://slingsandarrows.band/.netlify/identity' });

  function applyUser(user) {
    isAdmin = !!user;
    // Show upload button and delete overlays only for logged-in users.
    // The server still enforces ALLOWED_AUTHORS — this is just UX convenience.
    if (uploadBtn) uploadBtn.hidden = !user;

    // Refresh delete button visibility on existing cards
    document.querySelectorAll('.gallery-item-delete').forEach(btn => {
      btn.hidden = !user;
    });

    // Swap auth gate ↔ upload form inside the modal
    if (authGate)   authGate.hidden   = !!user;
    if (uploadForm) uploadForm.hidden = !user;
  }

  applyUser(identity.currentUser());
  identity.on('init',   user => applyUser(user));
  identity.on('login',  user => { applyUser(user); identity.close(); });
  identity.on('logout', ()   => applyUser(null));

  loginBtn?.addEventListener('click', () => identity.open('login'));
}

// ─── Gallery loading & rendering ─────────────────────────────────────────────
async function loadGallery() {
  try {
    const res = await fetch('/api/gallery/list');
    if (!res.ok) throw new Error(res.statusText);
    galleryItems = await res.json();

    loading.hidden = true;

    if (!galleryItems.length) {
      emptyState.hidden = false;
      return;
    }

    galleryItems.forEach((item, idx) => grid.appendChild(renderThumbnail(item, idx)));
  } catch {
    loading.hidden = true;
    if (!grid.children.length) errorState.hidden = false;
  }
}

/**
 * Build a thumbnail card for one gallery item.
 * @param {object} item
 * @param {number} idx  — index into galleryItems array
 */
function renderThumbnail(item, idx) {
  const article = document.createElement('article');
  article.className = 'gallery-item';
  article.setAttribute('role', 'listitem');
  article.dataset.idx = idx;

  const isVideo = item.mediaType === 'video' || isCloudinaryVideo(item.mediaUrl);

  if (isVideo) {
    // Generate an optimised poster frame via Cloudinary's video transformation
    const img = document.createElement('img');
    img.src     = buildVideoPoster(item.mediaUrl, 400);
    img.alt     = item.caption || 'Video thumbnail';
    img.loading = 'lazy';
    img.decoding = 'async';
    article.appendChild(img);

    const badge = document.createElement('span');
    badge.className   = 'media-badge';
    badge.textContent = '▶ video';
    article.appendChild(badge);
  } else {
    // Responsive square thumbnail — serve 1× and 2× via srcset so retina
    // screens get a sharper image without wasting bandwidth on 1× displays.
    const img = document.createElement('img');
    img.src     = buildCloudinaryThumb(item.mediaUrl, 400);
    img.srcset  = [
      `${buildCloudinaryThumb(item.mediaUrl, 200)} 200w`,
      `${buildCloudinaryThumb(item.mediaUrl, 400)} 400w`,
      `${buildCloudinaryThumb(item.mediaUrl, 600)} 600w`,
    ].join(', ');
    // The grid uses auto-fill with a 200px minimum; 400px covers most cases.
    img.sizes   = '(max-width: 480px) calc(50vw - 1em), (max-width: 768px) calc(33vw - 1em), 200px';
    img.alt     = item.caption || 'Gallery photo';
    img.loading = 'lazy';
    img.decoding = 'async';
    article.appendChild(img);
  }

  // Caption overlay
  if (item.caption) {
    const caption = document.createElement('span');
    caption.className   = 'gallery-item-caption';
    caption.textContent = item.caption;
    article.appendChild(caption);
  }

  // Delete button (admin only — visibility toggled by applyUser)
  const delBtn = document.createElement('button');
  delBtn.className   = 'gallery-item-delete';
  delBtn.textContent = 'Delete';
  delBtn.hidden      = !isAdmin;
  delBtn.setAttribute('aria-label', `Delete ${item.caption || 'this item'}`);
  delBtn.addEventListener('click', e => {
    e.stopPropagation(); // don't open lightbox
    handleDelete(item, article);
  });
  article.appendChild(delBtn);

  // Open lightbox on click
  article.addEventListener('click', () => openLightbox(idx));

  return article;
}

// ─── Cloudinary URL helpers ───────────────────────────────────────────────────

/**
 * Transform a Cloudinary image URL to a square thumbnail of the given size.
 * Uses c_fill + g_auto (content-aware gravity), f_auto (WebP/AVIF), and
 * q_auto (quality ladder) for maximum compression with no visible quality loss.
 */
function buildCloudinaryThumb(url, size) {
  return url.replace(
    '/upload/',
    `/upload/c_fill,g_auto,w_${size},h_${size},f_auto,q_auto/`
  );
}

/**
 * Build an optimised Cloudinary image URL for display at a given max width.
 * Preserves aspect ratio (c_limit), picks the best format (f_auto), and uses
 * Cloudinary's quality ladder (q_auto).
 */
function buildCloudinaryDisplay(url, maxWidth) {
  return url.replace(
    '/upload/',
    `/upload/c_limit,w_${maxWidth},f_auto,q_auto/`
  );
}

/**
 * Build a srcset string for a Cloudinary image at several widths.
 * @param {string} url   - Original Cloudinary image URL
 * @param {number[]} widths - Array of pixel widths to generate descriptors for
 */
function buildCloudinarySrcset(url, widths) {
  return widths
    .map(w => `${buildCloudinaryDisplay(url, w)} ${w}w`)
    .join(', ');
}

/**
 * Build an optimised video poster URL from a Cloudinary video URL.
 * Grabs frame at offset 0, converts to JPEG with auto quality, and
 * resizes to a reasonable thumbnail width.
 */
function buildVideoPoster(videoUrl, width = 400) {
  return videoUrl
    .replace('/video/upload/', `/video/upload/so_0,w_${width},f_auto,q_auto/`)
    .replace(/\.[^.]+$/, '.jpg');
}

function isCloudinaryVideo(url) {
  return typeof url === 'string' && url.includes('/video/upload/');
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
function initLightbox() {
  lightboxClose.addEventListener('click', closeLightbox);
  lightboxPrev.addEventListener('click', () => navigateLightbox(-1));
  lightboxNext.addEventListener('click', () => navigateLightbox(1));

  // Close on backdrop click
  lightbox.addEventListener('click', e => {
    if (e.target === lightbox) closeLightbox();
  });

  // Keyboard navigation
  document.addEventListener('keydown', e => {
    if (!lightbox.classList.contains('active')) return;
    if (e.key === 'Escape')      closeLightbox();
    if (e.key === 'ArrowLeft')   navigateLightbox(-1);
    if (e.key === 'ArrowRight')  navigateLightbox(1);
  });
}

function openLightbox(idx) {
  lightboxIndex = idx;
  renderLightboxItem();
  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
  lightboxClose.focus();
}

function closeLightbox() {
  lightbox.classList.remove('active');
  document.body.style.overflow = '';

  // Stop any playing video
  const video = lightboxWrap.querySelector('video');
  if (video) video.pause();
}

function navigateLightbox(delta) {
  const next = lightboxIndex + delta;
  if (next < 0 || next >= galleryItems.length) return;
  lightboxIndex = next;
  renderLightboxItem();
}

function renderLightboxItem() {
  const item    = galleryItems[lightboxIndex];
  const isVideo = item.mediaType === 'video' || isCloudinaryVideo(item.mediaUrl);

  // Stop previous video if any
  const prevVideo = lightboxWrap.querySelector('video');
  if (prevVideo) prevVideo.pause();

  lightboxWrap.innerHTML = '';

  if (isVideo) {
    const video = document.createElement('video');
    video.controls   = true;
    video.preload    = 'metadata';
    video.setAttribute('playsinline', '');
    // Show an optimised poster while the video loads
    video.poster = buildVideoPoster(item.mediaUrl, 1200);
    const source = document.createElement('source');
    source.src = item.mediaUrl;
    video.appendChild(source);
    lightboxWrap.appendChild(video);
  } else {
    // Serve an optimised, format-negotiated image capped at 1600px wide —
    // wide enough for any lightbox but much smaller than the raw original.
    const img = document.createElement('img');
    img.src     = buildCloudinaryDisplay(item.mediaUrl, 1600);
    img.srcset  = buildCloudinarySrcset(item.mediaUrl, [800, 1200, 1600]);
    img.sizes   = '(max-width: 900px) 100vw, 1100px';
    img.alt     = item.caption || 'Gallery photo';
    img.decoding = 'async';
    lightboxWrap.appendChild(img);
  }

  lightboxCaption.textContent = item.caption || '';
  lightboxCounter.textContent = `${lightboxIndex + 1} / ${galleryItems.length}`;

  lightboxPrev.disabled = lightboxIndex === 0;
  lightboxNext.disabled = lightboxIndex === galleryItems.length - 1;
}

// ─── Upload modal ─────────────────────────────────────────────────────────────
function initUploadModal() {
  uploadBtn?.addEventListener('click', openUploadModal);
  modalClose?.addEventListener('click', closeUploadModal);
  modalCancel?.addEventListener('click', closeUploadModal);

  // Close on backdrop click
  uploadModal?.addEventListener('click', e => {
    if (e.target === uploadModal) closeUploadModal();
  });

  // Keyboard close
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && uploadModal?.classList.contains('active')) {
      closeUploadModal();
    }
  });

  // File picker
  let selectedFile = null;

  mediaFileInput?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    clearStatus(mediaStatus);
    selectedFile = null;
    previewWrap.hidden = true;
    previewEl.innerHTML = '';

    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');

    if (!isImage && !isVideo) {
      setStatus(mediaStatus, 'Only images and videos are supported.', 'error');
      mediaFileInput.value = '';
      return;
    }

    if (isVideo) {
      try {
        const duration = await getVideoDuration(file);
        if (duration > 300) { // 5-minute limit for gallery
          setStatus(mediaStatus, 'Videos must be under 5 minutes.', 'error');
          mediaFileInput.value = '';
          return;
        }
      } catch {
        setStatus(mediaStatus, 'Could not read video metadata.', 'error');
        mediaFileInput.value = '';
        return;
      }
    }

    selectedFile = { file, type: isImage ? 'image' : 'video' };

    // Local preview
    const objectUrl = URL.createObjectURL(file);
    if (isVideo) {
      const vid = document.createElement('video');
      vid.src     = objectUrl;
      vid.controls = true;
      vid.preload  = 'metadata';
      vid.setAttribute('playsinline', '');
      previewEl.appendChild(vid);
    } else {
      const img = document.createElement('img');
      img.src = objectUrl;
      img.alt = 'Preview';
      previewEl.appendChild(img);
    }
    previewWrap.hidden = false;

    // Expose selectedFile to form submit handler via closure
    uploadForm._selectedFile = selectedFile;
  });

  removeMediaBtn?.addEventListener('click', () => {
    mediaFileInput.value = '';
    previewWrap.hidden = true;
    previewEl.innerHTML = '';
    clearStatus(mediaStatus);
    if (uploadForm) uploadForm._selectedFile = null;
  });

  uploadForm?.addEventListener('submit', handleUpload);
}

function openUploadModal() {
  uploadModal?.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeUploadModal() {
  uploadModal?.classList.remove('active');
  document.body.style.overflow = '';
  resetUploadForm();
}

function resetUploadForm() {
  uploadForm?.reset();
  previewWrap.hidden = true;
  previewEl.innerHTML = '';
  clearStatus(mediaStatus);
  clearStatus(formStatus);
  if (uploadForm) uploadForm._selectedFile = null;
}

async function handleUpload(e) {
  e.preventDefault();

  const selectedFile = uploadForm._selectedFile;
  if (!selectedFile) {
    setStatus(formStatus, 'Please select a photo or video.', 'error');
    return;
  }

  uploadSubmit.disabled = true;
  setStatus(formStatus, 'Uploading…', '');

  try {
    let fileToUpload = selectedFile.file;

    // Compress images before upload
    if (selectedFile.type === 'image') {
      setStatus(mediaStatus, 'Compressing image…', 'uploading');
      try {
        fileToUpload = await compressImage(selectedFile.file);
      } catch {
        fileToUpload = selectedFile.file; // fall back to original
      }
    }

    setStatus(mediaStatus, 'Uploading to Cloudinary…', 'uploading');
    const cloudResult = await uploadToCloudinary(fileToUpload);
    clearStatus(mediaStatus);

    const mediaUrl  = cloudResult.secure_url;
    const mediaType = selectedFile.type;
    const caption   = captionInput?.value.trim() || '';

    // Get auth token
    const identity = window.netlifyIdentity;
    const user     = identity.currentUser();
    let token = '';
    try { token = user ? await user.jwt() : ''; } catch { /* expired */ }

    const res = await fetch('/api/gallery/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ mediaUrl, mediaType, caption }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

    const newItem = await res.json();

    // Prepend to local array and grid
    galleryItems.unshift(newItem);
    // Re-index all existing cards
    document.querySelectorAll('.gallery-item').forEach(card => {
      card.dataset.idx = String(Number(card.dataset.idx) + 1);
    });
    const card = renderThumbnail(newItem, 0);
    grid.insertBefore(card, grid.firstChild);

    emptyState.hidden = true;

    setStatus(formStatus, '✓ Uploaded!', 'success');
    setTimeout(closeUploadModal, 1200);
  } catch (err) {
    console.error('[gallery] upload error:', err);
    setStatus(formStatus, `✕ ${err.message}`, 'error');
  } finally {
    uploadSubmit.disabled = false;
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────
async function handleDelete(item, cardEl) {
  if (!confirm(`Delete this ${item.mediaType || 'item'}? This cannot be undone.`)) return;

  const identity = window.netlifyIdentity;
  const user     = identity.currentUser();
  let token = '';
  try { token = user ? await user.jwt() : ''; } catch { /* expired */ }

  try {
    const res = await fetch('/api/gallery/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ id: item.id }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

    // Remove from local state and DOM
    const idx = galleryItems.findIndex(i => i.id === item.id);
    if (idx !== -1) galleryItems.splice(idx, 1);
    cardEl.remove();

    // Re-index remaining cards
    document.querySelectorAll('.gallery-item').forEach((card, i) => {
      card.dataset.idx = i;
    });

    if (!galleryItems.length) emptyState.hidden = false;
  } catch (err) {
    console.error('[gallery] delete error:', err);
    alert(`Could not delete: ${err.message}`);
  }
}

// ─── Media helpers ────────────────────────────────────────────────────────────
async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = ev => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX_W = 2400;
        const MAX_H = 1600;
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
          0.85
        );
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

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

async function uploadToCloudinary(file) {
  if (!CLOUDINARY_CLOUD || !CLOUDINARY_PRESET) {
    throw new Error('Cloudinary configuration missing');
  }
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CLOUDINARY_PRESET);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`,
    { method: 'POST', body: fd }
  );

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail?.error?.message || `Cloudinary upload failed (${res.status})`);
  }
  return res.json();
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className   = cls;
}

function clearStatus(el) {
  if (!el) return;
  el.textContent = '';
  el.className   = '';
}
