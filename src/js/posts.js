import { authModal, initAuthBar } from './auth-modal.js';
import { lightbox } from './lightbox.js';

const feed       = document.getElementById('posts-feed');
const loading    = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const errorState = document.getElementById('error-state');

// postIds the signed-in user has liked, loaded once on init
let myLikedPostIds = new Set();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isCloudinaryUrl(url) {
  return typeof url === 'string' && url.startsWith('https://res.cloudinary.com/');
}

function isCloudinaryVideo(url) {
  if (!isCloudinaryUrl(url)) return false;
  // Cloudinary video URLs contain /video/upload/ in the path
  return url.includes('/video/upload/');
}

// Detect audio uploads. Cloudinary stores audio uploaded via the `auto`
// resource type under /video/upload/ — so we check the file extension
// *before* checking the path segment to avoid treating audio as video.
function isAudioUrl(url) {
  if (!isCloudinaryUrl(url)) return false;
  const lower = url.toLowerCase();
  if (
    lower.endsWith('.m4a') || lower.endsWith('.mp3') ||
    lower.endsWith('.wav') || lower.endsWith('.ogg') ||
    lower.endsWith('.aac') || lower.endsWith('.flac')
  ) return true;
  if (url.includes('/raw/upload/')) return true;
  return false;
}

// Insert Cloudinary transformation params after /upload/ without double-inserting.
// Uses q_auto so Cloudinary picks optimal quality for each requested format.
function cloudinaryOptimize(url, width) {
  if (!url || !isCloudinaryUrl(url)) return url;
  if (url.includes('/upload/f_auto')) return url; // already optimized
  return url.replace('/upload/', `/upload/f_auto,q_auto,w_${width}/`);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape the whole body first, then convert the admin-composer's
// `[text](https://…)` link syntax into real anchors. Because the conversion
// runs on already-escaped text, there is no way for a post body to inject
// arbitrary HTML — only this one exact, http(s)-only pattern becomes a tag.
function renderBodyHtml(body) {
  const escaped = escapeHtml(body);
  return escaped.replace(
    /\[([^[\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
  );
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year:  'numeric',
    month: 'long',
    day:   'numeric',
  });
}

// ─── Image cache invalidation ─────────────────────────────────────────────────
/**
 * Evict a Cloudinary URL from the image cache after a post or gallery item is
 * deleted.  Tries the Cache API directly first; also notifies the SW for any
 * variant entries it may hold.
 *
 * @param {string} imageUrl
 */
async function invalidateImageCache(imageUrl) {
  if (!imageUrl) return;
  try {
    if ('caches' in window) {
      const cache = await caches.open('sa-images-v1');
      await cache.delete(imageUrl);
    }
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'INVALIDATE_IMAGE',
        url:  imageUrl,
      });
    }
  } catch (err) {
    console.warn('[posts] invalidateImageCache error:', err);
  }
}

// ─── Get a JWT from Netlify Identity or custom-modal session ─────────────────
async function getToken() {
  try {
    // 1. Netlify Identity widget session
    const identity = window.netlifyIdentity;
    if (identity) {
      const user = identity.currentUser();
      if (user) return await user.jwt();
    }

    // 2. Custom-modal session stored in localStorage
    const raw = localStorage.getItem('gotrue.user');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.access_token) {
        if (!parsed.expires_at || parsed.expires_at > Date.now()) {
          return parsed.access_token;
        }
        localStorage.removeItem('gotrue.user');
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function isLoggedIn() {
  // Check both widget session and custom-modal localStorage session
  if (window.netlifyIdentity?.currentUser?.()) return true;
  try {
    const raw = localStorage.getItem('gotrue.user');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.access_token && parsed?.email) {
        if (!parsed.expires_at || parsed.expires_at > Date.now()) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

function getDisplayName(email) {
  if (!email) return 'Anonymous';
  return email.split('@')[0];
}

// ─── Render a single post card ────────────────────────────────────────────────
function renderPost(post, { pending = false } = {}) {
  const article = document.createElement('article');
  article.className = 'post-card';
  if (pending) {
    article.dataset.pendingId = post.id;
    article.classList.add('post-card--pending');
  }

  if (post.title) {
    const h3 = document.createElement('h3');
    h3.className   = 'post-title';
    h3.textContent = post.title;
    article.appendChild(h3);
  }

  // Media — image, video, or audio
  if (isCloudinaryUrl(post.imageUrl)) {
    if (isAudioUrl(post.imageUrl)) {
      const audio = document.createElement('audio');
      audio.className = 'post-audio';
      audio.controls = true;

      const source = document.createElement('source');
      source.src = post.imageUrl;
      audio.appendChild(source);
      article.appendChild(audio);
    } else if (isCloudinaryVideo(post.imageUrl)) {
      const video = document.createElement('video');
      video.className = 'post-image';
      video.controls  = true;
      video.preload   = 'none'; // don't preload video data until user interacts
      video.setAttribute('playsinline', '');
      video.setAttribute('loading', 'lazy');

      const source = document.createElement('source');
      source.src  = post.imageUrl;
      // Let the browser figure out the MIME type from the URL extension
      video.appendChild(source);
      article.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.className = 'post-image';
      img.alt       = post.title || '';
      img.loading   = 'lazy';
      img.decoding  = 'async';

      // Responsive srcset via Cloudinary on-the-fly transforms.
      // The feed container is capped at 700px; 1400w covers 2× retina.
      img.srcset = [
        `${cloudinaryOptimize(post.imageUrl, 400)} 400w`,
        `${cloudinaryOptimize(post.imageUrl, 700)} 700w`,
        `${cloudinaryOptimize(post.imageUrl, 1400)} 1400w`,
      ].join(', ');
      // Container is max 700px wide; below 736px it fills the viewport.
      img.sizes = '(max-width: 736px) 100vw, 700px';
      img.src   = cloudinaryOptimize(post.imageUrl, 700); // fallback
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', () => {
        lightbox.open(cloudinaryOptimize(post.imageUrl, 1600), post.title || '');
      });

      article.appendChild(img);
    }
  }

  const p = document.createElement('p');
  p.className = 'post-body';
  p.innerHTML = renderBodyHtml(post.body);
  article.appendChild(p);

  // Footer: meta + optional delete button
  const footer = document.createElement('div');
  footer.className = 'post-footer';

  const meta = document.createElement('p');
  meta.className = 'post-meta';
  if (pending) {
    meta.textContent = '⏳ Pending sync…';
    meta.classList.add('post-meta--pending');
  } else {
    meta.textContent = formatDate(post.createdAt);
  }
  footer.appendChild(meta);

  // Delete button — only for published posts when a session is active
  if (!pending) {
    if (isLoggedIn()) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className   = 'post-delete-btn';
      deleteBtn.textContent = '✕ Delete';
      deleteBtn.setAttribute('aria-label', 'Delete post');

      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to delete this post?')) return;

        deleteBtn.disabled    = true;
        deleteBtn.textContent = 'Deleting…';

        try {
          const token = await getToken();

          if (!token) {
            throw new Error('Not signed in — please sign in on the App page first.');
          }

          const res = await fetch('/api/delete-post', {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ id: post.id }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || `Server error (${res.status})`);
          }

          // Evict the deleted post's image from the SW cache so it doesn't
          // linger and consume quota.
          if (post.imageUrl) await invalidateImageCache(post.imageUrl);

          article.remove();
        } catch (err) {
          console.error('[posts] Delete error:', err);
          deleteBtn.disabled    = false;
          deleteBtn.textContent = '✕ Delete';
          alert(`Failed to delete post: ${err.message}`);
        }
      });

      footer.appendChild(deleteBtn);
    }
  }

  article.appendChild(footer);

  // Like + comments — only for published posts
  if (!pending) {
    article.appendChild(buildPostActions(post));
    article.appendChild(buildCommentsSection(post));
  }

  return article;
}

// ─── Like + comments-toggle row ────────────────────────────────────────────────
function buildPostActions(post) {
  const actions = document.createElement('div');
  actions.className = 'post-actions';

  const likeBtn = document.createElement('button');
  likeBtn.type = 'button';
  likeBtn.className = 'like-btn';
  const liked = myLikedPostIds.has(post.id);
  if (liked) likeBtn.classList.add('liked');
  likeBtn.setAttribute('aria-label', liked ? 'Unlike this post' : 'Like this post');
  likeBtn.innerHTML = `<span class="like-heart">${liked ? '♥' : '♡'}</span><span class="like-count">${post.likeCount || 0}</span>`;

  likeBtn.addEventListener('click', async () => {
    if (!isLoggedIn()) {
      authModal.open('login');
      return;
    }
    likeBtn.disabled = true;
    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');

      const res = await fetch('/api/posts/likes/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ postId: post.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Server error (${res.status})`);
      }
      const { liked: nowLiked, likeCount } = await res.json();
      if (nowLiked) myLikedPostIds.add(post.id); else myLikedPostIds.delete(post.id);
      likeBtn.classList.toggle('liked', nowLiked);
      likeBtn.setAttribute('aria-label', nowLiked ? 'Unlike this post' : 'Like this post');
      likeBtn.innerHTML = `<span class="like-heart">${nowLiked ? '♥' : '♡'}</span><span class="like-count">${likeCount}</span>`;
    } catch (err) {
      console.error('[posts] like error:', err);
      alert(`Could not update like: ${err.message}`);
    } finally {
      likeBtn.disabled = false;
    }
  });

  const commentsToggleBtn = document.createElement('button');
  commentsToggleBtn.type = 'button';
  commentsToggleBtn.className = 'comments-toggle-btn';
  const commentCount = post.commentCount || 0;
  commentsToggleBtn.dataset.commentCount = commentCount;
  commentsToggleBtn.setAttribute('aria-expanded', 'false');
  commentsToggleBtn.textContent = commentCount === 0
    ? 'Comments (0) ▸'
    : `${commentCount} comment${commentCount === 1 ? '' : 's'} ▸`;

  actions.appendChild(likeBtn);
  actions.appendChild(commentsToggleBtn);

  // Wired up once the comments section (built alongside) exists in the DOM
  actions.dataset.postId = post.id;
  commentsToggleBtn.addEventListener('click', () => {
    const article = actions.closest('.post-card');
    const container = article?.querySelector('.comments-container');
    if (!container) return;

    const isOpen = container.classList.contains('visible');
    if (isOpen) {
      container.classList.remove('visible');
      commentsToggleBtn.setAttribute('aria-expanded', 'false');
    } else {
      container.classList.add('visible');
      commentsToggleBtn.setAttribute('aria-expanded', 'true');
      if (!container.dataset.loaded) {
        container.dataset.loaded = 'true';
        const listEl    = container.querySelector('.comments-list');
        const noneEl    = container.querySelector('.no-comments');
        const loadingEl = container.querySelector('.comments-loading');
        const formEl    = container.querySelector('.comment-form-section');
        loadComments(post.id, listEl, noneEl, loadingEl, commentsToggleBtn);
        renderCommentFormSection(formEl, post.id, listEl, noneEl, commentsToggleBtn);
      }
    }
    const count = parseInt(commentsToggleBtn.dataset.commentCount || '0', 10);
    const arrow = container.classList.contains('visible') ? '▾' : '▸';
    commentsToggleBtn.textContent = count === 0
      ? `Comments (0) ${arrow}`
      : `${count} comment${count === 1 ? '' : 's'} ${arrow}`;
  });

  return actions;
}

function buildCommentsSection(post) {
  const container = document.createElement('div');
  container.className = 'comments-container';

  const loadingEl = document.createElement('p');
  loadingEl.className = 'comments-loading';
  loadingEl.textContent = 'Loading comments…';
  loadingEl.hidden = true;

  const noneEl = document.createElement('p');
  noneEl.className = 'no-comments';
  noneEl.textContent = 'No comments yet — be the first!';
  noneEl.hidden = true;

  const listEl = document.createElement('div');
  listEl.className = 'comments-list';

  const formSection = document.createElement('div');
  formSection.className = 'comment-form-section';

  container.appendChild(loadingEl);
  container.appendChild(noneEl);
  container.appendChild(listEl);
  container.appendChild(formSection);

  return container;
}

// ─── Load + render comments ────────────────────────────────────────────────────
async function loadComments(postId, listEl, noneEl, loadingEl, toggleBtn) {
  loadingEl.hidden = false;
  noneEl.hidden = true;
  listEl.innerHTML = '';

  try {
    const res = await fetch(`/api/posts/comments?postId=${encodeURIComponent(postId)}`);
    if (!res.ok) throw new Error(res.statusText);
    const comments = await res.json();

    loadingEl.hidden = true;

    // Reconcile the toggle label with the authoritative fetched count
    if (toggleBtn) {
      toggleBtn.dataset.commentCount = comments.length;
      toggleBtn.textContent = comments.length === 0
        ? 'Comments (0) ▾'
        : `${comments.length} comment${comments.length === 1 ? '' : 's'} ▾`;
    }

    if (!comments.length) {
      noneEl.hidden = false;
      return;
    }

    comments.forEach(comment => listEl.appendChild(buildCommentCard(comment, postId, listEl, noneEl, toggleBtn)));
  } catch (err) {
    loadingEl.hidden = true;
    listEl.innerHTML = `<p class="comment-status error">Could not load comments.</p>`;
    console.error('[posts] loadComments error:', err);
  }
}

function buildCommentCard(comment, postId, listEl, noneEl, toggleBtn) {
  const card = document.createElement('div');
  card.className = 'comment-card';
  card.dataset.commentId = comment.id;

  const header = document.createElement('div');
  header.className = 'comment-header';

  const author = document.createElement('span');
  author.className = 'comment-author';
  author.textContent = getDisplayName(comment.author);

  const date = document.createElement('span');
  date.className = 'comment-date';
  date.textContent = formatDate(comment.createdAt);

  header.appendChild(author);
  header.appendChild(date);

  if (isLoggedIn()) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'comment-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.setAttribute('aria-label', 'Delete this comment');
    deleteBtn.addEventListener('click', () => handleDeleteComment(postId, comment.id, card, listEl, noneEl, toggleBtn));
    header.appendChild(deleteBtn);
  }

  const body = document.createElement('p');
  body.className = 'comment-body';
  body.textContent = comment.body;

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

async function handleDeleteComment(postId, commentId, cardEl, listEl, noneEl, toggleBtn) {
  if (!confirm('Delete this comment?')) return;

  const btn = cardEl.querySelector('.comment-delete-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  try {
    const token = await getToken();
    if (!token) throw new Error('Not signed in');

    const res = await fetch('/api/posts/comments/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ postId, commentId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

    cardEl.remove();

    if (toggleBtn) {
      const count = Math.max(0, parseInt(toggleBtn.dataset.commentCount || '1', 10) - 1);
      toggleBtn.dataset.commentCount = count;
      const arrow = toggleBtn.getAttribute('aria-expanded') === 'true' ? '▾' : '▸';
      toggleBtn.textContent = count === 0
        ? `Comments (0) ${arrow}`
        : `${count} comment${count === 1 ? '' : 's'} ${arrow}`;
    }
    if (listEl && noneEl && !listEl.children.length) noneEl.hidden = false;
  } catch (err) {
    console.error('[posts] delete comment error:', err);
    alert(`Could not delete comment: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  }
}

// ─── Comment form (auth-aware) ─────────────────────────────────────────────────
function renderCommentFormSection(container, postId, listEl, noneEl, toggleBtn) {
  if (container.dataset.built) return;
  container.dataset.built = 'true';

  if (!isLoggedIn()) {
    const authMsg = document.createElement('div');
    authMsg.className = 'comment-auth-required';
    authMsg.innerHTML = `Sign in to leave a comment &nbsp;
      <button type="button" class="btn btn-sm" style="margin-inline-start:0.5em;">Sign In</button>`;
    authMsg.querySelector('button').addEventListener('click', () => authModal.open('login'));
    container.appendChild(authMsg);
    return;
  }

  const form = document.createElement('form');
  form.className = 'comment-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Write a comment…';
  textarea.required = true;

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn btn-sm';
  submitBtn.textContent = 'Post Comment';

  const status = document.createElement('p');
  status.className = 'comment-status';

  form.appendChild(textarea);
  form.appendChild(submitBtn);
  form.appendChild(status);
  container.appendChild(form);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = textarea.value.trim();
    if (!body) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting…';
    status.textContent = '';
    status.className = 'comment-status';

    try {
      const token = await getToken();
      if (!token) throw new Error('Not signed in');

      const res = await fetch('/api/posts/comments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ postId, body }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Server error (${res.status})`);
      }

      const comment = await res.json();
      if (noneEl) noneEl.hidden = true;
      listEl?.appendChild(buildCommentCard(comment, postId, listEl, noneEl, toggleBtn));

      if (toggleBtn) {
        const count = parseInt(toggleBtn.dataset.commentCount || '0', 10) + 1;
        toggleBtn.dataset.commentCount = count;
        toggleBtn.textContent = `${count} comment${count === 1 ? '' : 's'} ▾`;
      }

      textarea.value = '';
      status.textContent = 'Comment posted!';
      status.className = 'comment-status success';
      setTimeout(() => { status.textContent = ''; }, 3000);
    } catch (err) {
      console.error('[posts] post comment error:', err);
      status.textContent = `Error: ${err.message}`;
      status.className = 'comment-status error';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Post Comment';
    }
  });
}

// ─── Load the signed-in user's liked postIds ───────────────────────────────────
async function loadMyLikes() {
  if (!isLoggedIn()) return;
  try {
    const token = await getToken();
    if (!token) return;
    const res = await fetch('/api/posts/likes/mine', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const { postIds } = await res.json();
    myLikedPostIds = new Set(postIds || []);
  } catch (err) {
    console.warn('[posts] loadMyLikes error:', err);
  }
}

// ─── Pending-posts banner (offline queue) ─────────────────────────────────────
async function showPendingPosts() {
  let db;
  try {
    db = await openDB();
  } catch {
    return; // IndexedDB unavailable — skip silently
  }

  const pending = await getAllPending(db);
  if (!pending.length) return;

  // Insert a notice at the top of the feed
  const notice = document.createElement('p');
  notice.id        = 'pending-notice';
  notice.className = 'pending-notice';
  notice.textContent = `${pending.length} post${pending.length > 1 ? 's' : ''} queued — will publish when back online.`;
  feed.before(notice);

  // Render each queued post as a greyed-out optimistic card
  for (const record of pending) {
    feed.insertBefore(
      renderPost({ ...record.data, id: record.id, createdAt: record.createdAt }, { pending: true }),
      feed.firstChild
    );
  }
}

// ─── Listen for SW sync messages ──────────────────────────────────────────────
function listenForSWMessages() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.addEventListener('message', e => {
    const { type, postId, post } = e.data || {};

    if (type === 'POST_SYNCED') {
      // Replace the pending card with the real published post
      const pendingCard = feed.querySelector(`[data-pending-id="${postId}"]`);
      if (pendingCard && post) {
        pendingCard.replaceWith(renderPost(post));
      } else if (pendingCard) {
        pendingCard.remove();
      }

      // Remove notice if no more pending cards
      if (!feed.querySelector('[data-pending-id]')) {
        document.getElementById('pending-notice')?.remove();
      }
    }
  });
}

// ─── Load published posts from API ───────────────────────────────────────────
async function loadPosts() {
  try {
    const res = await fetch('/api/get-posts');
    if (!res.ok) throw new Error(res.statusText);
    const posts = await res.json();

    loading.hidden = true;

    if (posts.length === 0 && !feed.querySelector('[data-pending-id]')) {
      emptyState.hidden = false;
      return;
    }

    posts.forEach(post => feed.appendChild(renderPost(post)));
  } catch {
    loading.hidden = true;
    // Only show error state if we have nothing else to display
    if (!feed.children.length) {
      errorState.hidden = false;
    }
  }
}

// ─── IndexedDB helpers (page context) ────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
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

function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(['pending-posts'], 'readonly');
    const req = tx.objectStore('pending-posts').getAll();
    req.onerror  = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || []);
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  initAuthBar();
  listenForSWMessages();
  await loadMyLikes(); // resolve like state before rendering post cards
  await showPendingPosts(); // show offline queue before network posts load
  await loadPosts();
})();
