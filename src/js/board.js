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

function getDisplayName(email) {
  if (!email) return 'Anonymous';
  // Show the part before @, capitalised
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

// ─── Netlify Identity events ──────────────────────────────────────────────────
window.addEventListener('load', () => {
  const identity = window.netlifyIdentity;
  if (!identity) return;

  identity.on('login', () => {
    updateModalAuth();
  });

  identity.on('logout', () => {
    updateModalAuth();
    // Re-render reply sections to hide forms
    document.querySelectorAll('.reply-form-section').forEach(el => {
      const threadId = el.closest('.thread-card')?.dataset.threadId;
      if (threadId) renderReplyFormSection(el, threadId);
    });
  });
});

// ─── Build a reply card element ───────────────────────────────────────────────
function buildReplyCard(reply) {
  const card = document.createElement('div');
  card.className = 'reply-card';

  const header = document.createElement('div');
  header.className = 'reply-header';

  const author = document.createElement('span');
  author.className = 'reply-author';
  author.textContent = getDisplayName(reply.author);

  const date = document.createElement('span');
  date.className = 'reply-date';
  date.textContent = formatDate(reply.createdAt);

  header.appendChild(author);
  header.appendChild(date);

  const body = document.createElement('p');
  body.className = 'reply-body';
  body.textContent = reply.body;

  card.appendChild(header);
  card.appendChild(body);
  return card;
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

    replies.forEach(reply => repliesListEl.appendChild(buildReplyCard(reply)));
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
        repliesListEl.appendChild(buildReplyCard(reply));
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

  // Card header: title
  const cardHeader = document.createElement('div');
  cardHeader.className = 'thread-card-header';

  const title = document.createElement('h3');
  title.className = 'thread-title';
  title.textContent = thread.title;

  cardHeader.appendChild(title);
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
