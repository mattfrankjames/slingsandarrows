/**
 * Custom authentication modal using Netlify GoTrue API
 * Provides sign-up and sign-in flows without relying on Netlify Identity widget
 */

export class AuthModal {
  constructor(options = {}) {
    this.apiUrl = options.apiUrl || 'https://slingsandarrows.band/.netlify/identity';
    this.mode = 'login'; // 'login' or 'signup'
    this.isLoading = false;
    this._onLoginCallbacks = [];
    this.setupDOM();
    this.attachListeners();
  }

  setupDOM() {
    const html = `
      <div class="auth-modal" id="auth-modal" hidden role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <div class="auth-modal-overlay"></div>
        <div class="auth-modal-content">
          <div class="auth-modal-header">
            <h2 id="auth-title">Sign In</h2>
            <button class="auth-modal-close" id="auth-close" aria-label="Close">✕</button>
          </div>

          <!-- Tab switcher -->
          <div class="auth-tabs" role="tablist">
            <button class="auth-tab-btn auth-tab-btn--active" data-mode="login" role="tab" aria-selected="true">
              Sign In
            </button>
            <button class="auth-tab-btn" data-mode="signup" role="tab" aria-selected="false">
              Create Account
            </button>
          </div>

          <!-- Form -->
          <form id="auth-form" class="auth-form" novalidate>
            <div class="form-group">
              <label for="auth-email">Email</label>
              <input
                type="email"
                id="auth-email"
                name="email"
                required
                placeholder="your@email.com"
                autocomplete="email">
            </div>

            <div class="form-group">
              <label for="auth-password">Password</label>
              <input
                type="password"
                id="auth-password"
                name="password"
                required
                placeholder="••••••••"
                autocomplete="current-password">
            </div>

            <!-- Signup-only: confirm password -->
            <div class="form-group" id="confirm-password-group" hidden>
              <label for="auth-confirm">Confirm Password</label>
              <input
                type="password"
                id="auth-confirm"
                name="confirm"
                placeholder="••••••••"
                autocomplete="new-password">
              <span class="form-hint" id="password-hint" hidden>Passwords don't match</span>
            </div>

            <button type="submit" class="btn btn-primary auth-submit-btn" id="auth-submit">
              Sign In
            </button>

            <p id="auth-error" class="auth-error" role="alert" aria-live="polite" hidden></p>
            <p id="auth-loading" class="auth-loading" hidden aria-live="polite">Loading…</p>
            <p id="auth-success" class="auth-success" role="status" aria-live="polite" hidden></p>
          </form>

          <!-- Password reset link (login mode only) -->
          <p id="forgot-password-section" class="auth-forgot">
            <button type="button" id="forgot-password-btn" class="auth-link-btn">
              Forgot password?
            </button>
          </p>

          <!-- Sign-up info (signup mode only) -->
          <p id="signup-info" class="auth-info" hidden>
            We'll send a confirmation email. Check your inbox to verify your account.
          </p>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', html);
  }

  attachListeners() {
    const modal     = document.getElementById('auth-modal');
    const overlay   = modal.querySelector('.auth-modal-overlay');
    const tabBtns   = document.querySelectorAll('.auth-tab-btn');
    const form      = document.getElementById('auth-form');
    const closeBtn  = document.getElementById('auth-close');
    const forgotBtn = document.getElementById('forgot-password-btn');
    const passwordInputs = [
      document.getElementById('auth-password'),
      document.getElementById('auth-confirm'),
    ];

    // Tab switching
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchMode(btn.dataset.mode);
      });
    });

    // Form submission
    form.addEventListener('submit', e => {
      e.preventDefault();
      this.handleSubmit();
    });

    // Real-time password match validation (signup only)
    passwordInputs.forEach(input => {
      input.addEventListener('input', () => {
        this.validatePasswordMatch();
      });
    });

    // Close button
    closeBtn.addEventListener('click', () => {
      this.close();
    });

    // Close on overlay click
    overlay.addEventListener('click', () => {
      this.close();
    });

    // Close on Escape key
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('auth-modal').hidden) {
        this.close();
      }
    });

    // Forgot password
    forgotBtn.addEventListener('click', e => {
      e.preventDefault();
      this.showPasswordReset();
    });
  }

  switchMode(mode) {
    this.mode = mode;

    const tabBtns        = document.querySelectorAll('.auth-tab-btn');
    const title          = document.getElementById('auth-title');
    const submitBtn      = document.getElementById('auth-submit');
    const confirmGroup   = document.getElementById('confirm-password-group');
    const forgotSection  = document.getElementById('forgot-password-section');
    const signupInfo     = document.getElementById('signup-info');
    const passwordHint   = document.getElementById('password-hint');

    // Update tab styling and aria
    tabBtns.forEach(btn => {
      const isActive = btn.dataset.mode === mode;
      btn.classList.toggle('auth-tab-btn--active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    if (mode === 'signup') {
      title.textContent    = 'Create Account';
      submitBtn.textContent = 'Sign Up';
      confirmGroup.hidden  = false;
      forgotSection.hidden = true;
      signupInfo.hidden    = false;
      document.getElementById('auth-password').autocomplete = 'new-password';
    } else {
      title.textContent    = 'Sign In';
      submitBtn.textContent = 'Sign In';
      confirmGroup.hidden  = true;
      forgotSection.hidden = false;
      signupInfo.hidden    = true;
      passwordHint.hidden  = true;
      document.getElementById('auth-password').autocomplete = 'current-password';
    }

    // Clear form and messages
    document.getElementById('auth-form').reset();
    this.clearError();
    this.clearSuccess();
  }

  validatePasswordMatch() {
    if (this.mode !== 'signup') return;

    const password = document.getElementById('auth-password').value;
    const confirm  = document.getElementById('auth-confirm').value;
    const hint     = document.getElementById('password-hint');

    if (confirm && password !== confirm) {
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  async handleSubmit() {
    const email    = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const confirm  = document.getElementById('auth-confirm').value;

    // Basic validation
    if (!email || !password) {
      this.showError('Email and password are required');
      return;
    }

    if (this.mode === 'signup' && !confirm) {
      this.showError('Please confirm your password');
      return;
    }

    if (this.mode === 'signup' && password !== confirm) {
      this.showError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      this.showError('Password must be at least 6 characters');
      return;
    }

    this.clearError();
    this.clearSuccess();

    const submitBtn = document.getElementById('auth-submit');
    const loadingEl = document.getElementById('auth-loading');

    submitBtn.disabled  = true;
    loadingEl.hidden    = false;
    this.isLoading      = true;

    try {
      if (this.mode === 'signup') {
        await this.signup(email, password);
      } else {
        await this.login(email, password);
      }
    } catch (err) {
      this.showError(err.message);
    } finally {
      submitBtn.disabled = false;
      loadingEl.hidden   = true;
      this.isLoading     = false;
    }
  }

  async signup(email, password) {
    const response = await fetch(`${this.apiUrl}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error_description || data.msg || 'Sign-up failed');
    }

    this.showSuccess(
      'Account created! Check your email to confirm, then sign in.'
    );

    // Switch back to login after a short delay so the user can sign in
    setTimeout(() => {
      this.switchMode('login');
    }, 2000);
  }

  async login(email, password) {
    // GoTrue's /token endpoint is an OAuth 2.0 token endpoint and requires
    // application/x-www-form-urlencoded, NOT application/json.
    // Sending JSON causes a "unsupported grant_type" error because the server
    // cannot parse the grant_type field from a JSON body.
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('username', email);
    params.append('password', password);

    const response = await fetch(`${this.apiUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error_description || data.msg || 'Sign-in failed');
    }

    const data = await response.json();

    // Store the token so Netlify Identity widget can pick it up on the next
    // page load, and so board.js can read it directly.
    try {
      localStorage.setItem('gotrue.user', JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        email,
      }));
    } catch {
      // localStorage may be unavailable in some contexts — not fatal
    }

    this.showSuccess('Signed in successfully!');

    // Dispatch a custom event so board.js (and any other listeners) can react
    // without a full page reload.
    window.dispatchEvent(
      new CustomEvent('auth-modal:login', {
        detail: {
          token: data.access_token,
          email,
          user: { email, token: data.access_token },
        },
      })
    );

    // Close modal after a short pause so the success message is readable
    setTimeout(() => {
      this.close();
    }, 800);
  }

  showError(message) {
    const errorEl = document.getElementById('auth-error');
    errorEl.textContent = message;
    errorEl.hidden = false;
    document.getElementById('auth-success').hidden = true;
  }

  clearError() {
    const errorEl = document.getElementById('auth-error');
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  showSuccess(message) {
    const successEl = document.getElementById('auth-success');
    successEl.textContent = message;
    successEl.hidden = false;
    document.getElementById('auth-error').hidden = true;
  }

  clearSuccess() {
    const successEl = document.getElementById('auth-success');
    successEl.textContent = '';
    successEl.hidden = true;
  }

  showPasswordReset() {
    // Delegate to the Netlify Identity widget if available; otherwise show a
    // helpful message since GoTrue recovery requires the widget flow.
    if (window.netlifyIdentity) {
      this.close();
      window.netlifyIdentity.open('recovery');
    } else {
      this.showError(
        'To reset your password, visit the sign-in page and use "Forgot password" in the Netlify Identity dialog.'
      );
    }
  }

  open(initialMode = 'login') {
    this.switchMode(initialMode);
    document.getElementById('auth-modal').hidden = false;
    // Focus the email input after the modal is visible
    setTimeout(() => {
      document.getElementById('auth-email').focus();
    }, 100);
  }

  close() {
    document.getElementById('auth-modal').hidden = true;
    document.getElementById('auth-form').reset();
    this.clearError();
    this.clearSuccess();
  }

  /**
   * Register a callback to run after a successful login.
   * The callback receives { token, email, user }.
   */
  onLogin(fn) {
    window.addEventListener('auth-modal:login', e => fn(e.detail));
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
export const authModal = new AuthModal({
  apiUrl: 'https://slingsandarrows.band/.netlify/identity',
});

// ── Auth bar (header sign-out strip) ──────────────────────────────────────────
/**
 * Wire up the persistent auth bar that appears in the page header when a user
 * is signed in.  Expects the following elements in the DOM:
 *
 *   <div id="auth-bar" hidden>
 *     <span id="auth-bar-email"></span>
 *     <button id="auth-bar-logout">Sign Out</button>
 *   </div>
 *
 * Works with both the Netlify Identity widget session and the custom-modal
 * session stored in localStorage under `gotrue.user`.
 */
export function initAuthBar() {
  const authBar   = document.getElementById('auth-bar');
  const emailEl   = document.getElementById('auth-bar-email');
  const logoutBtn = document.getElementById('auth-bar-logout');

  if (!authBar || !logoutBtn) return;

  // ── Resolve current user from widget or localStorage ──────────────────────
  function resolveUser() {
    // 1. Netlify Identity widget (preferred — has refresh-token support)
    const widgetUser = window.netlifyIdentity?.currentUser?.();
    if (widgetUser) return { email: widgetUser.email, source: 'widget' };

    // 2. Custom-modal session stored in localStorage
    try {
      const raw = localStorage.getItem('gotrue.user');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.access_token && parsed?.email) {
          if (!parsed.expires_at || parsed.expires_at > Date.now()) {
            return { email: parsed.email, source: 'storage' };
          }
          // Expired — clean up
          localStorage.removeItem('gotrue.user');
        }
      }
    } catch { /* ignore */ }

    return null;
  }

  function applyUser(user) {
    if (user) {
      if (emailEl) emailEl.textContent = user.email;
      authBar.hidden = false;
    } else {
      if (emailEl) emailEl.textContent = '';
      authBar.hidden = true;
    }
  }

  // Initial render
  applyUser(resolveUser());

  // ── Netlify Identity widget events ────────────────────────────────────────
  const identity = window.netlifyIdentity;
  if (identity) {
    identity.on('init',   user => applyUser(user ? { email: user.email } : resolveUser()));
    identity.on('login',  user => applyUser({ email: user.email }));
    identity.on('logout', ()   => {
      // Also clear custom-modal session on widget logout
      try { localStorage.removeItem('gotrue.user'); } catch { /* ignore */ }
      applyUser(null);
    });
  }

  // ── Custom auth-modal login event ─────────────────────────────────────────
  window.addEventListener('auth-modal:login', e => {
    applyUser({ email: e.detail.email });
  });

  // ── Sign-out button ───────────────────────────────────────────────────────
  logoutBtn.addEventListener('click', () => {
    // Clear custom-modal session
    try { localStorage.removeItem('gotrue.user'); } catch { /* ignore */ }

    // Sign out of the Netlify Identity widget if it has an active session
    if (window.netlifyIdentity?.currentUser?.()) {
      window.netlifyIdentity.logout();
    } else {
      // No widget session — just clear the bar immediately
      applyUser(null);
    }
  });
}
