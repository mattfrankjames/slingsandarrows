import { authModal } from './auth-modal.js';

// ─── In-memory auth state ─────────────────────────────────────────────────────
// We maintain our own lightweight session on top of the Netlify Identity widget
// so that users who sign in via the custom modal are immediately recognised
// without a page reload.
let _sessionUser = null; // { email, token }

function _initSessionFromStorage() {
  try {
    const raw = localStorage.getItem('gotrue.user');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.access_token && parsed.email) {
      // Check expiry
      if (parsed.expires_at && parsed.expires_at < Date.now()) {
        localStorage.removeItem('gotrue.user');
        return;
      }
      _sessionUser = { email: parsed.email, token: parsed.access_token };
    }
  } catch {
    // ignore
  }
}

// Initialise from localStorage on module load
_initSessionFromStorage();

// Listen for successful logins from the custom auth modal
window.addEventListener('auth-modal:login', e => {
  _sessionUser = { email: e.detail.email, token: e.detail.token };
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
function currentUser() {
  // Prefer the in-memory session (set after custom-modal login)
  if (_sessionUser) return _sessionUser;
  // Fall back to Netlify Identity widget session
  return window.netlifyIdentity?.currentUser() ?? null;
}

async function getToken() {
  try {
    // In-memory session token (from custom modal login)
    if (_sessionUser?.token) return _sessionUser.token;

    // Netlify Identity widget token
    const user = window.netlifyIdentity?.currentUser();
    if (!user) return null;
    return await user.jwt();
  } catch {
    return null;
  }
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
  modal.classList.add('active');
  modal.querySelector('input, textarea')?.focus();
}

function closeModal() {
  modal.classList.remove('active');
  threadForm.reset();
  formStatus.textContent = '';
}

newThreadBtn.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);
modal.addEventListener('click', e => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
});

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
    // Also clear our in-memory session on widget logout
    _sessionUser = null;
    try { localStorage.removeItem('gotrue.user'); } catch { /* ignore */ }
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
  card.appendChild(body);
  return card;
}

// ─── Delete a reply ───────────────────────────────────────────────────────────
async function handleDeleteReply(threadId, replyId, cardEl) {
  if (!confirm('Delete this reply?')) return;

  const btn = cardEl.querySelector('.reply-delete-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  try {
    const token = await getToken();
    if (!token) throw new Error('Not signed in');

    const res = await fetch('/api/board/replies/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ threadId, replyId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

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
    const token = await getToken();
    if (!token) throw new Error('Not signed in');

    const res = await fetch('/api/board/threads/delete', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ id: threadId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

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
    const res = await fetch(`/api/board/replies?threadId=${encodeURIComponent(threadId)}`);
    if (!res.ok) throw new Error(res.statusText);
    const replies = await res.json();

    loadingEl.hidden = true;

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
      const token = await getToken();
      if (!token) throw new Error('Not signed in');

      const res = await fetch('/api/board/replies/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ threadId, body }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `Server error (${res.status})`);
      }

      const reply = await res.json();

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

      textarea.value = '';
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
    const token = await getToken();
    if (!token) throw new Error('Not signed in — please sign in first.');

    const res = await fetch('/api/board/threads/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title, body }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

    const thread = await res.json();

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
  try {
    const res = await fetch('/api/board/threads');
    if (!res.ok) throw new Error(res.statusText);
    const threads = await res.json();

    loadingEl.hidden = true;

    if (!threads.length) {
      emptyState.hidden = false;
      return;
    }

    threads.forEach(thread => threadsList.appendChild(buildThreadCard(thread)));
  } catch (err) {
    console.error('[board] loadThreads error:', err);
    loadingEl.hidden = true;
    errorState.hidden = false;
  }
}

loadThreads();
