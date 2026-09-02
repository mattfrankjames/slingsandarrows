import { authModal, initAuthBar, ensureFreshSession } from './auth-modal.js';
import { loadingIndicator } from './lib/loading-state.js';
import { lightbox } from './lightbox.js';
import { uploadToCloudinary } from './lib/media.js';
import { currentEmail, clearSession } from './lib/session.js';
import { api } from './lib/api.js';


async function validateMediaFile(file) {
  const maxSize = 50 * 1024 * 1024; // 50 MB

  if (file.size > maxSize) {
    throw new Error('File must be under 50 MB');
  }

  const allowed = ['image/', 'video/', 'audio/'];
  if (!allowed.some(t => file.type.startsWith(t))) {
    throw new Error('Only images, videos, and audio files are allowed');
  }

  if (file.type.startsWith('video/')) {
    await new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      const src = URL.createObjectURL(file);
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(src);
        if (video.duration > 300) {
          reject(new Error('Videos must be under 5 minutes'));
        } else {
          resolve();
        }
      };
      video.onerror = () => {
        URL.revokeObjectURL(src);
        reject(new Error('Could not read video metadata'));
      };
      video.src = src;
    });
  }
}

function createMediaPreviewEl(file) {
  const wrap = document.createElement('div');
  const objectUrl = URL.createObjectURL(file);

  if (file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = objectUrl;
    img.alt = 'Media preview';
    wrap.appendChild(img);
  } else if (file.type.startsWith('video/')) {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.setAttribute('playsinline', '');
    const source = document.createElement('source');
    source.src = objectUrl;
    video.appendChild(source);
    wrap.appendChild(video);
  } else if (file.type.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.controls = true;
    const source = document.createElement('source');
    source.src = objectUrl;
    audio.appendChild(source);
    wrap.appendChild(audio);
  }
  return wrap;
}

// Detect media type from a Cloudinary (or generic) URL.
// Note: Cloudinary stores audio uploaded via the `auto` resource type under
// /video/upload/ — so we must check the file extension *before* checking the
// path segment to avoid treating audio files as videos.
function isAudioUrl(url) {
  const lower = url.toLowerCase();
  // Explicit audio extensions take priority (Cloudinary auto-upload stores
  // audio under /video/upload/ but keeps the original extension in the URL)
  if (
    lower.endsWith('.m4a') || lower.endsWith('.mp3') ||
    lower.endsWith('.wav') || lower.endsWith('.ogg') ||
    lower.endsWith('.aac') || lower.endsWith('.flac')
  ) return true;
  // Cloudinary raw uploads are also audio (no extension rewriting)
  if (url.includes('/raw/upload/')) return true;
  // Cloudinary /video/upload/ URLs that contain an audio MIME hint
  if (url.includes('/video/upload/') && lower.includes('audio')) return true;
  return false;
}

function isVideoUrl(url) {
  // Only treat as video if it's under /video/upload/ AND not an audio file
  return url.includes('/video/upload/') && !isAudioUrl(url);
}

// Insert Cloudinary transformation params after /upload/ in a URL.
// Handles URLs that already contain a transform segment (e.g. /upload/v123456/)
// by inserting before the version/path, not duplicating the segment.
function cloudinaryOptimize(url, width) {
  if (!url || !url.includes('res.cloudinary.com')) return url;
  // Avoid double-inserting transforms if the URL already has them
  if (url.includes('/upload/f_auto')) return url;
  return url.replace('/upload/', `/upload/f_auto,q_auto,w_${width}/`);
}

function buildMediaElement(mediaUrl, className) {
  if (!mediaUrl) return null;
  const container = document.createElement('div');
  container.className = className;

  if (isAudioUrl(mediaUrl)) {
    // Audio — render as <audio> player
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.style.width = '100%';
    audio.style.display = 'block';
    const source = document.createElement('source');
    source.src = mediaUrl;
    audio.appendChild(source);
    container.appendChild(audio);
  } else if (isVideoUrl(mediaUrl)) {
    // Video — render as <video> player; don't preload until user interacts
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'none';
    video.setAttribute('playsinline', '');
    video.setAttribute('loading', 'lazy');
    const source = document.createElement('source');
    source.src = mediaUrl;
    video.appendChild(source);
    container.appendChild(video);
  } else {
    // Image — serve via Cloudinary with format/quality auto + responsive srcset
    const img = document.createElement('img');
    img.alt     = 'Attached media';
    img.loading = 'lazy';
    img.decoding = 'async';

    // Responsive srcset: 400w for mobile, 760w covers the max container width
    img.srcset = [
      `${cloudinaryOptimize(mediaUrl, 400)} 400w`,
      `${cloudinaryOptimize(mediaUrl, 760)} 760w`,
    ].join(', ');
    // Container is capped at 760px (max-width of board-container)
    img.sizes = '(max-width: 760px) 100vw, 760px';
    img.src   = cloudinaryOptimize(mediaUrl, 760); // fallback
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => {
      lightbox.open(cloudinaryOptimize(mediaUrl, 1600), '');
    });
    container.appendChild(img);
  }
  return container;
}

// Re-render the signed-in affordances when the modal reports a sign-in.
// There is no local session copy to update — session.js reads storage.
window.addEventListener('auth-modal:login', () => {
  updateModalAuth();
  refreshDeleteButtons();
  refreshReplyForms();
});

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const threadsList  = document.getElementById('threads-list');
const loadingEl    = document.getElementById('loading');
const emptyState   = document.getElementById('empty-state');
const errorState   = document.getElementById('error-state');

const newThreadBtn  = document.getElementById('new-thread-btn');
const modal         = document.getElementById('new-thread-modal');
const modalClose    = document.getElementById('modal-close');
const modalCancel   = document.getElementById('modal-cancel');
const authGate      = document.getElementById('board-auth-gate');
const threadForm    = document.getElementById('new-thread-form');
const threadTitle   = document.getElementById('thread-title');
const threadBody    = document.getElementById('thread-body');
const threadSubmit  = document.getElementById('thread-submit-btn');
const formStatus    = document.getElementById('form-status');
const loginBtnBoard = document.getElementById('login-btn-board');

// ─── Auth helpers ─────────────────────────────────────────────────────────────
// Board code asks "is anyone signed in" rather than for a user object.
function currentUser() {
  const email = currentEmail();
  return email ? { email } : null;
}

function getDisplayName(email) {
  if (!email) return 'Anonymous';
  return email.split('@')[0];
}

// ─── Date formatter ───────────────────────────────────────────────────────────
function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

// ─── Auth gate in modal ───────────────────────────────────────────────────────
function updateModalAuth() {
  const user = currentUser();
  if (user) {
    authGate.hidden   = true;
    threadForm.hidden = false;
  } else {
    authGate.hidden   = false;
    threadForm.hidden = true;
  }
}

// ─── Modal open/close ─────────────────────────────────────────────────────────
function openModal() {
  updateModalAuth();
  modal.showModal();
  modal.querySelector('input, textarea')?.focus();
}

function closeModal() {
  if (modal.open) modal.close();
  threadForm.reset();
  formStatus.textContent = '';
  // Reset media state
  selectedThreadMedia = null;
  if (mediaPreviewEl)   mediaPreviewEl.innerHTML = '';
  if (mediaPreviewWrap) mediaPreviewWrap.hidden = true;
  if (mediaStatusEl)    { mediaStatusEl.textContent = ''; mediaStatusEl.className = ''; }
}

newThreadBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
modal.addEventListener('click', e => {
  if (e.target === modal) closeModal();
});
// Escape is handled by <dialog>; 'cancel' fires first, so the form reset in
// closeModal() still runs however the dialog is dismissed.
modal.addEventListener('cancel', () => closeModal());

// Open the custom auth modal when the "Sign In / Create Account" button is clicked
loginBtnBoard.addEventListener('click', () => {
  // Close the thread modal first so modals don't stack
  closeModal();
  authModal.open('login');
});

// ─── Re-render all open reply form sections to reflect current auth state ─────
function refreshReplyForms() {
  document.querySelectorAll('.reply-form-section').forEach(el => {
    const threadId = el.closest('.thread-card')?.dataset.threadId;
    if (threadId) renderReplyFormSection(el, threadId);
  });
}

// ─── Netlify Identity events (keep for users already signed in via widget) ────
window.addEventListener('load', () => {
  const identity = window.netlifyIdentity;
  if (!identity) return;

  identity.on('init', () => {
    updateModalAuth();
    refreshDeleteButtons();
    refreshReplyForms();
  });

  identity.on('login', () => {
    updateModalAuth();
    refreshDeleteButtons();
    refreshReplyForms();
  });

  identity.on('logout', () => {
    // The widget's session is gone; drop the custom-modal one too.
    clearSession();
    updateModalAuth();
    refreshDeleteButtons();
    refreshReplyForms();
  });
});

// Show or hide all delete buttons based on current auth state
function refreshDeleteButtons() {
  const show = !!currentUser();
  document.querySelectorAll('.thread-delete-btn, .reply-delete-btn').forEach(btn => {
    btn.hidden = !show;
  });
}

// ─── Build a reply card element ───────────────────────────────────────────────
function buildReplyCard(reply, threadId) {
  const card = document.createElement('div');
  card.className = 'reply-card';
  card.dataset.replyId = reply.id;

  const header = document.createElement('div');
  header.className = 'reply-header';

  const author = document.createElement('span');
  author.className = 'reply-author';
  author.textContent = getDisplayName(reply.author);

  const dateMeta = document.createElement('span');
  dateMeta.className = 'reply-date';
  dateMeta.textContent = formatDate(reply.createdAt);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'reply-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.hidden = !currentUser();
  deleteBtn.setAttribute('aria-label', 'Delete this reply');
  deleteBtn.addEventListener('click', () => handleDeleteReply(threadId, reply.id, card));

  header.appendChild(author);
  header.appendChild(dateMeta);
  header.appendChild(deleteBtn);

  const body = document.createElement('p');
  body.className = 'reply-body';
  body.textContent = reply.body;

  card.appendChild(header);

  // Media attachment
  if (reply.mediaUrl) {
    const mediaEl = buildMediaElement(reply.mediaUrl, 'reply-media');
    if (mediaEl) card.appendChild(mediaEl);
  }

  card.appendChild(body);
  return card;
}

// ─── Delete a reply ───────────────────────────────────────────────────────────
async function handleDeleteReply(threadId, replyId, cardEl) {
  if (!confirm('Delete this reply?')) return;

  const btn = cardEl.querySelector('.reply-delete-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  try {
    await api.board.replies.remove(threadId, replyId);

    cardEl.remove();

    const threadCard = threadsList.querySelector(`[data-thread-id="${threadId}"]`);
    if (threadCard) {
      // Recount from the DOM so the value is always accurate
      const replyCount = threadCard.querySelectorAll('.reply-card').length;

      const toggleBtn = threadCard.querySelector('.toggle-replies-btn');
      if (toggleBtn) {
        toggleBtn.dataset.replyCount = replyCount;
        const isOpen = !!threadCard.querySelector('.replies-container.visible');
        const arrow = isOpen ? '▾' : '▸';
        toggleBtn.textContent = replyCount === 0
          ? `Replies (0) ${arrow}`
          : `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'} ${arrow}`;
      }

      // Show the "no replies" message when the list is now empty
      const repliesListEl = threadCard.querySelector('.replies-list');
      const noRepliesEl   = threadCard.querySelector('.no-replies');
      if (repliesListEl && noRepliesEl && !repliesListEl.children.length) {
        noRepliesEl.hidden = false;
      }

      // Collapse the replies container when there are no replies left
      if (replyCount === 0) {
        const repliesContainer = threadCard.querySelector('.replies-container');
        if (repliesContainer) {
          repliesContainer.classList.remove('visible');
          if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
        }
      }
    }
  } catch (err) {
    console.error('[board] delete reply error:', err);
    alert(`Could not delete reply: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  }
}

// ─── Delete a thread ──────────────────────────────────────────────────────────
async function handleDeleteThread(threadId, cardEl) {
  if (!confirm('Delete this thread and all its replies? This cannot be undone.')) return;

  const btn = cardEl.querySelector('.thread-delete-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  try {
    await api.board.threads.remove(threadId);

    cardEl.remove();

    if (!threadsList.children.length) {
      emptyState.hidden = false;
    }
  } catch (err) {
    console.error('[board] delete thread error:', err);
    alert(`Could not delete thread: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Delete thread'; }
  }
}

// ─── Fetch and render replies into a container ────────────────────────────────
async function loadReplies(threadId, repliesListEl, noRepliesEl, loadingEl) {
  loadingEl.hidden = false;
  noRepliesEl.hidden = true;
  repliesListEl.innerHTML = '';

  try {
    const replies = await api.board.replies.list(threadId);

    loadingEl.hidden = true;

    // ── Reconcile the toggle-button label with the actual fetched count ───
    // The stored thread.replyCount can drift out of sync (e.g. if replies were
    // deleted directly in the blob store, or a race condition occurred during
    // creation). Always use the authoritative count from the fetched array.
    const threadCard = repliesListEl.closest('.thread-card');
    if (threadCard) {
      const toggleBtn = threadCard.querySelector('.toggle-replies-btn');
      if (toggleBtn) {
        const actualCount = replies.length;
        toggleBtn.dataset.replyCount = actualCount;
        // Button is open at this point (we just expanded it)
        toggleBtn.textContent = actualCount === 0
          ? 'Replies (0) ▾'
          : `${actualCount} repl${actualCount === 1 ? 'y' : 'ies'} ▾`;
      }
    }

    if (!replies.length) {
      noRepliesEl.hidden = false;
      return;
    }

    replies.forEach(reply => repliesListEl.appendChild(buildReplyCard(reply, threadId)));
  } catch (err) {
    loadingEl.hidden = true;
    repliesListEl.innerHTML = `<p class="reply-status error">Could not load replies.</p>`;
    console.error('[board] loadReplies error:', err);
  }
}

// ─── Build the reply form section (auth-aware) ────────────────────────────────
function renderReplyFormSection(container, threadId) {
  container.innerHTML = '';

  const user = currentUser();

  if (!user) {
    const authMsg = document.createElement('div');
    authMsg.className = 'auth-required';
    authMsg.innerHTML = `Sign in to leave a reply &nbsp;
      <button class="btn btn-sm btn-primary" style="margin-inline-start:0.5em;" data-login-btn>Sign In</button>`;
    authMsg.querySelector('[data-login-btn]').addEventListener('click', () => {
      authModal.open('login');
    });
    container.appendChild(authMsg);
    return;
  }

  const heading = document.createElement('h4');
  heading.textContent = 'Leave a Reply';
  container.appendChild(heading);

  const form = document.createElement('form');
  form.className = 'reply-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Write your reply…';
  textarea.required = true;

  // ── Media input for replies ──────────────────────────────────────────────
  const mediaWrap = document.createElement('div');
  mediaWrap.className = 'reply-media-wrap';

  const mediaLabel = document.createElement('label');
  mediaLabel.textContent = 'Media (optional)';
  mediaLabel.style.cssText = 'display:block; font-size:0.85em; opacity:0.7; margin-block-end:0.3em;';

  const replyMediaInput = document.createElement('input');
  replyMediaInput.type = 'file';
  replyMediaInput.accept = 'image/*,video/*,audio/*';
  replyMediaInput.setAttribute('aria-label', 'Attach photo, video, or audio to reply');
  // `font: inherit` rather than naming a family: the typeface is the site's
  // choice, and a licensed Typekit name written into shared code both hardcodes
  // this band's identity and would fail to load anywhere without that kit.
  replyMediaInput.style.cssText =
    'width:100%; background:transparent; border:1px dashed rgba(255,255,255,0.25); ' +
    'color:white; font: inherit; font-size:0.9rem; ' +
    'padding:0.4em; border-radius:4px; cursor:pointer;';

  const replyMediaPreviewWrap = document.createElement('div');
  replyMediaPreviewWrap.hidden = true;
  replyMediaPreviewWrap.style.marginBlockStart = '0.5em';

  const replyMediaPreview = document.createElement('div');
  replyMediaPreview.className = 'reply-media-preview';

  const removeReplyMediaBtn = document.createElement('button');
  removeReplyMediaBtn.type = 'button';
  removeReplyMediaBtn.className = 'btn btn-sm';
  removeReplyMediaBtn.textContent = 'Remove Media';
  removeReplyMediaBtn.style.cssText =
    'margin-block-start:0.4em; background:rgba(245,168,168,0.12); ' +
    'border-color:rgba(245,168,168,0.35); color:#f5a8a8;';

  replyMediaPreviewWrap.appendChild(replyMediaPreview);
  replyMediaPreviewWrap.appendChild(removeReplyMediaBtn);

  const replyMediaStatus = document.createElement('p');
  replyMediaStatus.className = 'reply-media-status';

  mediaWrap.appendChild(mediaLabel);
  mediaWrap.appendChild(replyMediaInput);
  mediaWrap.appendChild(replyMediaPreviewWrap);
  mediaWrap.appendChild(replyMediaStatus);

  let selectedReplyMedia = null;

  replyMediaInput.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    replyMediaStatus.textContent = '';
    replyMediaStatus.className = 'reply-media-status';
    selectedReplyMedia = null;
    try {
      await validateMediaFile(file);
      selectedReplyMedia = file;
      replyMediaPreview.innerHTML = '';
      replyMediaPreview.appendChild(createMediaPreviewEl(file));
      replyMediaPreviewWrap.hidden = false;
    } catch (err) {
      replyMediaStatus.textContent = `✕ ${err.message}`;
      replyMediaStatus.className = 'reply-media-status error';
      replyMediaInput.value = '';
    }
  });

  removeReplyMediaBtn.addEventListener('click', () => {
    selectedReplyMedia = null;
    replyMediaInput.value = '';
    replyMediaPreview.innerHTML = '';
    replyMediaPreviewWrap.hidden = true;
    replyMediaStatus.textContent = '';
    replyMediaStatus.className = 'reply-media-status';
  });

  // ── Actions row ──────────────────────────────────────────────────────────
  const actions = document.createElement('div');
  actions.className = 'reply-form-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-primary btn-sm';
  submitBtn.textContent = 'Post Reply';

  const status = document.createElement('p');
  status.className = 'reply-status';

  actions.appendChild(submitBtn);
  form.appendChild(textarea);
  form.appendChild(mediaWrap);
  form.appendChild(actions);
  form.appendChild(status);
  container.appendChild(form);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = textarea.value.trim();
    if (!body) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting…';
    status.textContent = '';
    status.className = 'reply-status';

    try {
      let mediaUrl = '';

      if (selectedReplyMedia) {
        replyMediaStatus.textContent = 'Uploading media…';
        replyMediaStatus.className = 'reply-media-status uploading';
        try {
          const result = await uploadToCloudinary(selectedReplyMedia);
          mediaUrl = result.secure_url;
          replyMediaStatus.textContent = '';
          replyMediaStatus.className = 'reply-media-status';
        } catch (err) {
          replyMediaStatus.textContent = `✕ Media upload failed: ${err.message}`;
          replyMediaStatus.className = 'reply-media-status error';
          // Post without media rather than blocking
        }
      }

      const reply = await api.board.replies.create(threadId, { body, mediaUrl });

      const repliesListEl = container.closest('.replies-container')
        ?.querySelector('.replies-list');
      const noRepliesEl = container.closest('.replies-container')
        ?.querySelector('.no-replies');

      if (repliesListEl) {
        if (noRepliesEl) noRepliesEl.hidden = true;
        repliesListEl.appendChild(buildReplyCard(reply, threadId));
      }

      const card = container.closest('.thread-card');
      if (card) {
        const toggleBtn = card.querySelector('.toggle-replies-btn');
        if (toggleBtn) {
          const count = parseInt(toggleBtn.dataset.replyCount || '0', 10) + 1;
          toggleBtn.dataset.replyCount = count;
          toggleBtn.textContent = `${count} repl${count === 1 ? 'y' : 'ies'} ▾`;
        }
      }

      // Reset reply form
      textarea.value = '';
      selectedReplyMedia = null;
      replyMediaInput.value = '';
      replyMediaPreview.innerHTML = '';
      replyMediaPreviewWrap.hidden = true;
      replyMediaStatus.textContent = '';
      replyMediaStatus.className = 'reply-media-status';

      status.textContent = 'Reply posted!';
      status.className = 'reply-status success';
      setTimeout(() => { status.textContent = ''; }, 3000);
    } catch (err) {
      console.error('[board] post reply error:', err);
      status.textContent = `Error: ${err.message}`;
      status.className = 'reply-status error';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Post Reply';
    }
  });
}

// ─── Build a full thread card element ────────────────────────────────────────
function buildThreadCard(thread) {
  const card = document.createElement('div');
  card.className = 'thread-card';
  card.dataset.threadId = thread.id;

  const cardHeader = document.createElement('div');
  cardHeader.className = 'thread-card-header';

  const title = document.createElement('h3');
  title.className = 'thread-title';
  title.textContent = thread.title;

  const deleteThreadBtn = document.createElement('button');
  deleteThreadBtn.className = 'thread-delete-btn';
  deleteThreadBtn.textContent = 'Delete thread';
  deleteThreadBtn.hidden = !currentUser();
  deleteThreadBtn.setAttribute('aria-label', `Delete thread: ${thread.title}`);
  deleteThreadBtn.addEventListener('click', () => handleDeleteThread(thread.id, card));

  cardHeader.appendChild(title);
  cardHeader.appendChild(deleteThreadBtn);
  card.appendChild(cardHeader);

  const meta = document.createElement('div');
  meta.className = 'thread-meta';

  const authorSpan = document.createElement('span');
  authorSpan.textContent = getDisplayName(thread.author);

  const dateSpan = document.createElement('span');
  dateSpan.textContent = formatDate(thread.createdAt);

  meta.appendChild(authorSpan);
  meta.appendChild(dateSpan);
  card.appendChild(meta);

  // Media attachment
  if (thread.mediaUrl) {
    const mediaEl = buildMediaElement(thread.mediaUrl, 'thread-media');
    if (mediaEl) card.appendChild(mediaEl);
  }

  const preview = document.createElement('p');
  preview.className = 'thread-preview';
  preview.textContent = thread.body;
  card.appendChild(preview);

  const replyCount = thread.replyCount || 0;
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'toggle-replies-btn';
  toggleBtn.dataset.replyCount = replyCount;
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.textContent = replyCount === 0
    ? 'Replies (0) ▸'
    : `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'} ▸`;
  card.appendChild(toggleBtn);

  const repliesContainer = document.createElement('div');
  repliesContainer.className = 'replies-container';

  const repliesLoadingEl = document.createElement('p');
  repliesLoadingEl.className = 'replies-loading';
  repliesLoadingEl.textContent = 'Loading replies…';
  repliesLoadingEl.hidden = true;

  const noRepliesEl = document.createElement('p');
  noRepliesEl.className = 'no-replies';
  noRepliesEl.textContent = 'No replies yet — be the first!';
  noRepliesEl.hidden = true;

  const repliesListEl = document.createElement('div');
  repliesListEl.className = 'replies-list';

  const replyFormSection = document.createElement('div');
  replyFormSection.className = 'reply-form-section';

  repliesContainer.appendChild(repliesLoadingEl);
  repliesContainer.appendChild(noRepliesEl);
  repliesContainer.appendChild(repliesListEl);
  repliesContainer.appendChild(replyFormSection);
  card.appendChild(repliesContainer);

  let repliesLoaded = false;

  toggleBtn.addEventListener('click', () => {
    const isOpen = repliesContainer.classList.contains('visible');

    if (isOpen) {
      repliesContainer.classList.remove('visible');
      toggleBtn.setAttribute('aria-expanded', 'false');
      const count = parseInt(toggleBtn.dataset.replyCount || '0', 10);
      toggleBtn.textContent = count === 0
        ? 'Replies (0) ▸'
        : `${count} repl${count === 1 ? 'y' : 'ies'} ▸`;
    } else {
      repliesContainer.classList.add('visible');
      toggleBtn.setAttribute('aria-expanded', 'true');
      const count = parseInt(toggleBtn.dataset.replyCount || '0', 10);
      toggleBtn.textContent = count === 0
        ? 'Replies (0) ▾'
        : `${count} repl${count === 1 ? 'y' : 'ies'} ▾`;

      if (!repliesLoaded) {
        repliesLoaded = true;
        loadReplies(thread.id, repliesListEl, noRepliesEl, repliesLoadingEl);
        renderReplyFormSection(replyFormSection, thread.id);
      }
    }
  });

  return card;
}

// ─── New thread form — media state & wiring ───────────────────────────────────
let selectedThreadMedia = null;

const threadMediaInput    = document.getElementById('thread-media');
const mediaPreviewWrap    = document.getElementById('media-preview-wrap');
const mediaPreviewEl      = document.getElementById('media-preview');
const removeMediaBtn      = document.getElementById('remove-media-btn');
const mediaStatusEl       = document.getElementById('media-status');

threadMediaInput.addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;

  mediaStatusEl.textContent = '';
  mediaStatusEl.className = '';
  selectedThreadMedia = null;

  try {
    await validateMediaFile(file);
    selectedThreadMedia = file;
    mediaPreviewEl.innerHTML = '';
    mediaPreviewEl.appendChild(createMediaPreviewEl(file));
    mediaPreviewWrap.hidden = false;
  } catch (err) {
    mediaStatusEl.textContent = `✕ ${err.message}`;
    mediaStatusEl.className = 'error';
    threadMediaInput.value = '';
  }
});

removeMediaBtn.addEventListener('click', () => {
  selectedThreadMedia = null;
  threadMediaInput.value = '';
  mediaPreviewEl.innerHTML = '';
  mediaPreviewWrap.hidden = true;
  mediaStatusEl.textContent = '';
  mediaStatusEl.className = '';
});

// ─── New thread form submission ───────────────────────────────────────────────
threadForm.addEventListener('submit', async e => {
  e.preventDefault();

  const title = threadTitle.value.trim();
  const body  = threadBody.value.trim();

  if (!title || !body) return;

  threadSubmit.disabled = true;
  threadSubmit.textContent = 'Posting…';
  formStatus.textContent = '';

  try {
    let mediaUrl = '';

    if (selectedThreadMedia) {
      mediaStatusEl.textContent = 'Uploading media…';
      mediaStatusEl.className = 'uploading';
      try {
        const result = await uploadToCloudinary(selectedThreadMedia);
        mediaUrl = result.secure_url;
        mediaStatusEl.textContent = '';
        mediaStatusEl.className = '';
      } catch (err) {
        mediaStatusEl.textContent = `✕ Media upload failed: ${err.message}`;
        mediaStatusEl.className = 'error';
        // Continue posting without media rather than blocking
      }
    }

    const thread = await api.board.threads.create({ title, body, mediaUrl });

    const card = buildThreadCard(thread);
    if (threadsList.firstChild) {
      threadsList.insertBefore(card, threadsList.firstChild);
    } else {
      threadsList.appendChild(card);
    }
    emptyState.hidden = true;

    closeModal();
  } catch (err) {
    console.error('[board] create thread error:', err);
    formStatus.textContent = `Error: ${err.message}`;
    formStatus.style.color = '#f5a8a8';
  } finally {
    threadSubmit.disabled = false;
    threadSubmit.textContent = 'Post Thread';
  }
});

// ─── Load all threads on page load ───────────────────────────────────────────
async function loadThreads() {
  const settled = loadingIndicator(loadingEl);
  try {
    const threads = await api.board.threads.list();

    settled();

    if (!threads.length) {
      emptyState.hidden = false;
      return;
    }

    threads.forEach(thread => threadsList.appendChild(buildThreadCard(thread)));
  } catch (err) {
    console.error('[board] loadThreads error:', err);
    settled();
    errorState.hidden = false;
  }
}

// ─── Silent background refresh ─────────────────────────────────────────────────
// Re-fetches and re-renders the thread list without disturbing the user —
// re-expands (and reloads replies for) any threads that were already open.
async function refreshThreadsSilently() {
  try {
    const threads = await api.board.threads.list();

    const openThreadIds = Array.from(threadsList.querySelectorAll('.thread-card'))
      .filter(card => card.querySelector('.replies-container.visible'))
      .map(card => card.dataset.threadId);

    threadsList.innerHTML = '';

    if (!threads.length) {
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    threads.forEach(thread => {
      const card = threadsList.appendChild(buildThreadCard(thread));
      if (openThreadIds.includes(thread.id)) {
        card.querySelector('.toggle-replies-btn')?.click();
      }
    });
  } catch (err) {
    console.warn('[board] refreshThreadsSilently error:', err);
  }
}

// ─── Service Worker registration + messages ────────────────────────────────────
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker
    .register(new URL('../../sw.js', import.meta.url), { scope: '/' })
    .catch(err => console.warn('[board] SW registration failed:', err));
}

function listenForSWMessages() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', e => {
    const { type, url } = e.data || {};
    // The SW revalidated /api/board/threads in the background and found the
    // response actually changed — silently re-render instead of leaving
    // stale content on screen until the user manually reloads.
    if (type === 'API_UPDATED' && url?.includes('/api/board/threads')) {
      refreshThreadsSilently();
    }
  });
}

(async () => {
  // Refresh an expired session (if a refresh token is available) before the
  // auth-gated UI below (delete buttons, reply forms, auth bar) renders.
  await ensureFreshSession();
  registerServiceWorker();
  listenForSWMessages();
  loadThreads();
  initAuthBar();
})();
