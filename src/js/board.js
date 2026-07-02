const threadsListEl  = document.getElementById('threads-list');
const loadingEl      = document.getElementById('loading');
const emptyStateEl   = document.getElementById('empty-state');
const errorStateEl   = document.getElementById('error-state');
const newThreadBtn   = document.getElementById('new-thread-btn');
const newThreadModal = document.getElementById('new-thread-modal');
const newThreadForm  = document.getElementById('new-thread-form');
const boardAuthGate  = document.getElementById('board-auth-gate');
const modalClose     = document.getElementById('modal-close');
const modalCancel    = document.getElementById('modal-cancel');
const formStatus     = document.getElementById('form-status');

let currentUser = null;

// ─── Authentication ───────────────────────────────────────────────────────────
function initAuth() {
  const identity = window.netlifyIdentity;
  identity.init({ APIUrl: 'https://slingsandarrows.band/.netlify/identity' });

  // Restore any existing session
  currentUser = identity.currentUser();

  identity.on('init', user => {
    currentUser = user;
  });

  identity.on('login', user => {
    currentUser = user;
    identity.close();
    // If the modal is already open, flip to the form
    if (newThreadModal.classList.contains('active')) {
      updateModalUI();
    }
  });

  identity.on('logout', () => {
    currentUser = null;
    // If modal is open, show the auth gate again
    if (newThreadModal.classList.contains('active')) {
      updateModalUI();
    }
  });

  document.getElementById('login-btn-board')?.addEventListener('click', () => {
    identity.open('login');
  });
}

// ─── Modal controls ───────────────────────────────────────────────────────────
newThreadBtn.addEventListener('click', () => {
  newThreadModal.classList.add('active');
  updateModalUI();
  // Focus the first interactive element inside the modal
  requestAnimationFrame(() => {
    const firstFocusable = newThreadModal.querySelector('button, input, textarea');
    firstFocusable?.focus();
  });
});

modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);

// Close on backdrop click
newThreadModal.addEventListener('click', e => {
  if (e.target === newThreadModal) closeModal();
});

// Close on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && newThreadModal.classList.contains('active')) {
    closeModal();
  }
});

function closeModal() {
  newThreadModal.classList.remove('active');
  newThreadForm.reset();
  formStatus.textContent = '';
  formStatus.style.color = 'inherit';
  newThreadBtn.focus();
}

function updateModalUI() {
  if (currentUser) {
    boardAuthGate.hidden = true;
    newThreadForm.hidden = false;
    // Focus the title field when the form appears
    requestAnimationFrame(() => {
      document.getElementById('thread-title')?.focus();
    });
  } else {
    boardAuthGate.hidden = false;
    newThreadForm.hidden = true;
  }
}

// ─── Form submission ──────────────────────────────────────────────────────────
newThreadForm.addEventListener('submit', async e => {
  e.preventDefault();

  if (!currentUser) {
    setFormStatus('✕ You must be signed in to post', 'error');
    return;
  }

  const title = document.getElementById('thread-title').value.trim();
  const body  = document.getElementById('thread-body').value.trim();

  if (!title || !body) {
    setFormStatus('✕ Title and message are required', 'error');
    return;
  }

  let token = '';
  try {
    token = await currentUser.jwt();
  } catch {
    setFormStatus('✕ Session expired — please sign in again', 'error');
    return;
  }

  const submitBtn = document.getElementById('thread-submit-btn');
  submitBtn.disabled = true;
  setFormStatus('Posting…', '');

  try {
    const res = await fetch('/api/board/create-thread', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ title, body }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

    setFormStatus('✓ Thread posted!', 'success');
    setTimeout(() => {
      closeModal();
      loadThreads();
    }, 1200);
  } catch (err) {
    console.error('[board] Post error:', err);
    setFormStatus(`✕ ${err.message}`, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// ─── Load and render threads ──────────────────────────────────────────────────
async function loadThreads() {
  loadingEl.hidden = false;
  emptyStateEl.hidden = true;
  errorStateEl.hidden = true;
  threadsListEl.innerHTML = '';

  try {
    const res = await fetch(`/api/board/get-threads?t=${Date.now()}`);
    if (!res.ok) throw new Error(res.statusText);

    const threads = await res.json();
    loadingEl.hidden = true;

    if (threads.length === 0) {
      emptyStateEl.hidden = false;
      return;
    }

    threadsListEl.innerHTML = threads.map(thread => `
      <div class="thread-card" data-thread-id="${escapeHtml(thread.id)}" tabindex="0"
        role="button" aria-label="View thread: ${escapeHtml(thread.title)}">
        <div class="thread-title">${escapeHtml(thread.title)}</div>
        <div class="thread-preview">${escapeHtml(thread.body)}</div>
        <div class="thread-meta">
          <span>${escapeHtml(thread.author)} &bull; ${formatDate(thread.createdAt)}</span>
          <span class="reply-count">${thread.replyCount || 0} ${thread.replyCount === 1 ? 'reply' : 'replies'}</span>
        </div>
      </div>
    `).join('');

    // Click and keyboard handlers for each card
    document.querySelectorAll('.thread-card').forEach(card => {
      const navigate = () => {
        window.location.href = `/board/${card.dataset.threadId}`;
      };
      card.addEventListener('click', navigate);
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate();
        }
      });
    });
  } catch (err) {
    console.error('[board] Failed to load threads:', err);
    loadingEl.hidden = true;
    errorStateEl.hidden = false;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[ch]));
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function setFormStatus(message, type) {
  formStatus.textContent = message;
  formStatus.style.color = type === 'error' ? '#f5a8a8' : type === 'success' ? '#a8f5a8' : 'inherit';
}

// ─── Initialize ───────────────────────────────────────────────────────────────
initAuth();
loadThreads();
