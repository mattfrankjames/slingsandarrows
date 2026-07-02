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
  return window.netlifyIdentity?.currentUser() ?? null;
}

async function getToken() {
  try {
    const user = currentUser();
    if (!user) return null;
    return await user.jwt();
  } catch {
    return null;
  }
}

function isAdmin() {
  const user = currentUser();
  if (!user) return false;
  const allowed = (window.__ALLOWED_AUTHORS__ || '').split(',')
    .map(e => e.trim().toLowerCase()).filter(Boolean);
  // Fall back to checking if the user has any app_metadata role hint
  // In practice, ALLOWED_AUTHORS is a server-side env var, so we check via
  // a lightweight heuristic: the user is admin if they can reach the board
  // at all (any logged-in user can delete their own content; ALLOWED_AUTHORS
  // guards the actual API). We expose a data attribute from the HTML if needed,
  // but the simplest UX is: show delete buttons to all logged-in users and let
  // the server enforce the ALLOWED_AUTHORS check.
  return !!user;
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
    authGate.hidden  = true;
    threadForm.hidden = false;
  } else {
    authGate.hidden  = false;
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

loginBtnBoard.addEventListener('click', () => {
  window.netlifyIdentity?.open('login');
});

// ─── Re-render all open reply form sections to reflect current auth state ─────
function refreshReplyForms() {
  document.querySelectorAll('.reply-form-section').forEach(el => {
    const threadId = el.closest('.thread-card')?.dataset.threadId;
    if (threadId) renderReplyFormSection(el, threadId);
  });
}

// ─── Netlify Identity events ──────────────────────────────────────────────────
window.addEventListener('load', () => {
  const identity = window.netlifyIdentity;
  if (!identity) return;

  // 'init' fires on page load — user may already be signed in from a previous
  // session.  We need to refresh reply forms once the identity state is known
  // so that "sign in to reply" is replaced with the actual reply form.
  identity.on('init', () => {
    updateModalAuth();
    refreshDeleteButtons();
    refreshReplyForms();
  });

  identity.on('login', () => {
    updateModalAuth();
    refreshDeleteButtons();
    // Replace "sign in to reply" with the actual reply form in any open threads
    refreshReplyForms();
  });

  identity.on('logout', () => {
    updateModalAuth();
    refreshDeleteButtons();
    // Replace reply forms with the "sign in" prompt
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

  // Delete reply button — visible only when logged in
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

    // Remove the card from the DOM
    cardEl.remove();

    // Decrement the toggle button's reply count
    const threadCard = threadsList.querySelector(`[data-thread-id="${threadId}"]`);
    if (threadCard) {
      const toggleBtn = threadCard.querySelector('.toggle-replies-btn');
      if (toggleBtn) {
        const count = Math.max(0, parseInt(toggleBtn.dataset.replyCount || '0', 10) - 1);
        toggleBtn.dataset.replyCount = count;
        const isOpen = threadCard.querySelector('.replies-container.visible');
        const arrow = isOpen ? '▾' : '▸';
        toggleBtn.textContent = count === 0
          ? `Replies (0) ${arrow}`
          : `${count} repl${count === 1 ? 'y' : 'ies'} ${arrow}`;
      }

      // Show "no replies" message if list is now empty
      const repliesListEl = threadCard.querySelector('.replies-list');
      const noRepliesEl   = threadCard.querySelector('.no-replies');
      if (repliesListEl && noRepliesEl && !repliesListEl.children.length) {
        noRepliesEl.hidden = false;
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

    // Remove the card from the DOM
    cardEl.remove();

    // Show empty state if no threads remain
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
function renderReplyFormSection(container, threadId, onReplyPosted) {
  container.innerHTML = '';

  const user = currentUser();

  if (!user) {
    const authMsg = document.createElement('div');
    authMsg.className = 'auth-required';
    authMsg.innerHTML = `Sign in to leave a reply &nbsp;
      <button class="btn btn-sm btn-primary" style="margin-inline-start:0.5em;" data-login-btn>Sign In</button>`;
    authMsg.querySelector('[data-login-btn]').addEventListener('click', () => {
      window.netlifyIdentity?.open('login');
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

      // Append the new reply to the replies list above the form
      const repliesListEl = container.closest('.replies-container')
        ?.querySelector('.replies-list');
      const noRepliesEl = container.closest('.replies-container')
        ?.querySelector('.no-replies');

      if (repliesListEl) {
        if (noRepliesEl) noRepliesEl.hidden = true;
        repliesListEl.appendChild(buildReplyCard(reply, threadId));
      }

      // Update reply count badge on the toggle button
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

  // Card header: title + delete button
  const cardHeader = document.createElement('div');
  cardHeader.className = 'thread-card-header';

  const title = document.createElement('h3');
  title.className = 'thread-title';
  title.textContent = thread.title;

  // Delete thread button — only visible when logged in
  const deleteThreadBtn = document.createElement('button');
  deleteThreadBtn.className = 'thread-delete-btn';
  deleteThreadBtn.textContent = 'Delete thread';
  deleteThreadBtn.hidden = !currentUser();
  deleteThreadBtn.setAttribute('aria-label', `Delete thread: ${thread.title}`);
  deleteThreadBtn.addEventListener('click', () => handleDeleteThread(thread.id, card));

  cardHeader.appendChild(title);
  cardHeader.appendChild(deleteThreadBtn);
  card.appendChild(cardHeader);

  // Meta: author + date
  const meta = document.createElement('div');
  meta.className = 'thread-meta';

  const authorSpan = document.createElement('span');
  authorSpan.textContent = getDisplayName(thread.author);

  const dateSpan = document.createElement('span');
  dateSpan.textContent = formatDate(thread.createdAt);

  meta.appendChild(authorSpan);
  meta.appendChild(dateSpan);
  card.appendChild(meta);

  // Body preview
  const preview = document.createElement('p');
  preview.className = 'thread-preview';
  preview.textContent = thread.body;
  card.appendChild(preview);

  // Toggle replies button
  const replyCount = thread.replyCount || 0;
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'toggle-replies-btn';
  toggleBtn.dataset.replyCount = replyCount;
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.textContent = replyCount === 0
    ? 'Replies (0) ▸'
    : `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'} ▸`;
  card.appendChild(toggleBtn);

  // Replies container (hidden until toggled)
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

    // Prepend the new thread card
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
