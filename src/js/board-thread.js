// board-thread.js — thread detail page with replies

// ─── Extract thread ID from the URL (/board/<id>) ────────────────────────────
function getThreadIdFromUrl() {
  // URL is /board/<threadId> — grab the last path segment
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

const threadId = getThreadIdFromUrl();

// DOM refs
const pageLoadingEl  = document.getElementById('page-loading');
const pageErrorEl    = document.getElementById('page-error');
const threadContent  = document.getElementById('thread-content');
const threadTitleEl  = document.getElementById('thread-title');
const threadBodyEl   = document.getElementById('thread-body');
const threadMetaEl   = document.getElementById('thread-meta');
const repliesHeading = document.getElementById('replies-heading');
const repliesListEl  = document.getElementById('replies-list');
const noRepliesEl    = document.getElementById('no-replies');
const replyAuthGate  = document.getElementById('reply-auth-gate');
const replyForm      = document.getElementById('reply-form');
const replyStatus    = document.getElementById('reply-status');

let currentUser = null;

// ─── Authentication ───────────────────────────────────────────────────────────
function initAuth() {
  const identity = window.netlifyIdentity;
  identity.init({ APIUrl: 'https://slingsandarrows.band/.netlify/identity' });

  currentUser = identity.currentUser();
  updateReplyUI();

  identity.on('init', user => {
    currentUser = user;
    updateReplyUI();
  });

  identity.on('login', user => {
    currentUser = user;
    identity.close();
    updateReplyUI();
  });

  identity.on('logout', () => {
    currentUser = null;
    updateReplyUI();
  });

  document.getElementById('login-btn-reply')?.addEventListener('click', () => {
    identity.open('login');
  });
}

function updateReplyUI() {
  if (currentUser) {
    replyAuthGate.hidden = true;
    replyForm.hidden     = false;
  } else {
    replyAuthGate.hidden = false;
    replyForm.hidden     = true;
  }
}

// ─── Load thread ──────────────────────────────────────────────────────────────
async function loadThread() {
  if (!threadId) {
    pageLoadingEl.hidden = true;
    pageErrorEl.hidden   = false;
    return;
  }

  try {
    const res = await fetch(`/api/board/get-thread?id=${encodeURIComponent(threadId)}`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const thread = await res.json();

    // Populate thread header
    threadTitleEl.textContent = thread.title;
    threadBodyEl.textContent  = thread.body;
    threadMetaEl.textContent  = `${thread.author} · ${formatDate(thread.createdAt)}`;

    pageLoadingEl.hidden = true;
    threadContent.hidden = false;

    // Update page title
    document.title = `${thread.title} — Slings & Arrows`;

    // Load replies
    await loadReplies();
  } catch (err) {
    console.error('[board-thread] Failed to load thread:', err);
    pageLoadingEl.hidden = true;
    pageErrorEl.hidden   = false;
  }
}

// ─── Load replies ─────────────────────────────────────────────────────────────
async function loadReplies() {
  try {
    const res = await fetch(`/api/board/get-replies?threadId=${encodeURIComponent(threadId)}`);
    if (!res.ok) throw new Error(res.statusText);

    const replies = await res.json();

    repliesListEl.innerHTML = '';

    if (replies.length === 0) {
      noRepliesEl.hidden    = false;
      repliesHeading.hidden = true;
    } else {
      noRepliesEl.hidden    = true;
      repliesHeading.hidden = false;
      repliesHeading.textContent = `${replies.length} ${replies.length === 1 ? 'Reply' : 'Replies'}`;

      for (const reply of replies) {
        repliesListEl.appendChild(renderReply(reply));
      }
    }
  } catch (err) {
    console.error('[board-thread] Failed to load replies:', err);
  }
}

// ─── Render a single reply card ───────────────────────────────────────────────
function renderReply(reply) {
  const div = document.createElement('div');
  div.className = 'reply-card';
  div.dataset.replyId = reply.id;

  const body = document.createElement('p');
  body.className   = 'reply-body';
  body.textContent = reply.body;

  const meta = document.createElement('p');
  meta.className   = 'reply-meta';
  meta.textContent = `${reply.author} · ${formatDate(reply.createdAt)}`;

  div.appendChild(body);
  div.appendChild(meta);
  return div;
}

// ─── Reply form submission ────────────────────────────────────────────────────
replyForm.addEventListener('submit', async e => {
  e.preventDefault();

  if (!currentUser) {
    setReplyStatus('✕ You must be signed in to reply', 'error');
    return;
  }

  const body = document.getElementById('reply-body').value.trim();
  if (!body) {
    setReplyStatus('✕ Reply cannot be empty', 'error');
    return;
  }

  let token = '';
  try {
    token = await currentUser.jwt();
  } catch (err) {
    setReplyStatus('✕ Session expired — please sign in again', 'error');
    return;
  }

  const submitBtn = document.getElementById('reply-submit-btn');
  submitBtn.disabled = true;
  setReplyStatus('Posting…', '');

  try {
    const res = await fetch('/api/board/create-reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ threadId, body }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

    const newReply = await res.json();

    // Append the new reply immediately
    noRepliesEl.hidden    = true;
    repliesHeading.hidden = false;
    repliesListEl.appendChild(renderReply(newReply));

    // Update heading count
    const count = repliesListEl.querySelectorAll('.reply-card').length;
    repliesHeading.textContent = `${count} ${count === 1 ? 'Reply' : 'Replies'}`;

    replyForm.reset();
    setReplyStatus('✓ Reply posted!', 'success');
    setTimeout(() => setReplyStatus('', ''), 3000);
  } catch (err) {
    console.error('[board-thread] Reply error:', err);
    setReplyStatus(`✕ ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year:  'numeric',
    month: 'short',
    day:   'numeric',
  });
}

function setReplyStatus(message, type) {
  replyStatus.textContent = message;
  replyStatus.style.color =
    type === 'error'   ? '#f5a8a8' :
    type === 'success' ? '#a8f5a8' :
    'inherit';
}

// ─── Initialize ───────────────────────────────────────────────────────────────
initAuth();
loadThread();
