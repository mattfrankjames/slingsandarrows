/**
 * PWAInstallManager
 * Handles beforeinstallprompt, install banner visibility, dismiss persistence,
 * and SW update notifications.
 */
class PWAInstallManager {
  constructor() {
    this.deferredPrompt = null;
    this.installBanner = document.getElementById('install-banner');
    this.installBtn    = document.getElementById('install-btn');
    this.dismissBtn    = document.getElementById('install-dismiss');

    this.init();
  }

  init() {
    // Already installed as a standalone app — no banner needed
    if (this.isStandalone()) {
      this.hideInstallBanner();
      return;
    }

    // User dismissed recently — respect their choice
    if (this.isDismissed()) {
      this.hideInstallBanner();
      return;
    }

    // Capture the install prompt before the browser shows its own UI
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.showInstallBanner();
    });

    // Hide banner once the app is installed via any path
    window.addEventListener('appinstalled', () => {
      this.handleInstalled();
    });

    // Wire up buttons
    this.installBtn?.addEventListener('click', () => this.promptInstall());
    this.dismissBtn?.addEventListener('click', () => this.dismissBanner());

    // Poll for SW updates
    this.watchForUpdates();
  }

  // ── Banner visibility ──────────────────────────────────────────────────────

  showInstallBanner() {
    this.installBanner?.removeAttribute('hidden');
  }

  hideInstallBanner() {
    this.installBanner?.setAttribute('hidden', '');
  }

  // ── Install flow ───────────────────────────────────────────────────────────

  async promptInstall() {
    if (!this.deferredPrompt) return;

    try {
      this.deferredPrompt.prompt();
      const { outcome } = await this.deferredPrompt.userChoice;

      if (outcome === 'accepted') {
        this.handleInstalled();
      } else {
        // Dismissed the native dialog — snooze banner for 7 days
        this.dismissBanner(7 * 24 * 60 * 60 * 1000);
      }
    } catch (err) {
      console.error('Install prompt failed:', err);
    } finally {
      this.deferredPrompt = null;
    }
  }

  handleInstalled() {
    localStorage.setItem('pwa-installed', 'true');
    this.hideInstallBanner();
  }

  // ── Dismiss persistence ────────────────────────────────────────────────────

  /** @param {number} duration ms to snooze (default 24 h) */
  dismissBanner(duration = 24 * 60 * 60 * 1000) {
    const until = Date.now() + duration;
    localStorage.setItem('pwa-dismiss-until', String(until));
    this.hideInstallBanner();
  }

  isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true ||
      localStorage.getItem('pwa-installed') === 'true'
    );
  }

  isDismissed() {
    const until = localStorage.getItem('pwa-dismiss-until');
    if (!until) return false;
    return Date.now() < parseInt(until, 10);
  }

  // ── SW update notifications ────────────────────────────────────────────────

  watchForUpdates() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.ready.then((registration) => {
      // Poll for updates every hour
      setInterval(() => registration.update(), 60 * 60 * 1000);

      // A new SW has taken control — prompt user to refresh
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        this.showUpdateNotification();
      });
    });
  }

  showUpdateNotification() {
    // Avoid stacking multiple banners
    if (document.getElementById('sw-update-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'sw-update-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.style.cssText = [
      'position:fixed',
      'bottom:1rem',
      'left:50%',
      'transform:translateX(-50%)',
      'background:rgba(0,0,0,0.92)',
      'border:1px solid rgba(255,255,255,0.35)',
      'color:#fff',
      'padding:0.75em 1.25em',
      'border-radius:4px',
      'display:flex',
      'gap:1em',
      'align-items:center',
      'font-family:"ballinger-mono",sans-serif',
      'font-size:0.9rem',
      'z-index:9999',
      'white-space:nowrap',
    ].join(';');

    const msg = document.createElement('span');
    msg.textContent = 'A new version is available.';

    const btn = document.createElement('button');
    btn.textContent = 'Refresh';
    btn.style.cssText = [
      'background:rgba(255,255,255,0.15)',
      'border:1px solid rgba(255,255,255,0.45)',
      'color:#fff',
      'padding:0.3em 0.9em',
      'border-radius:4px',
      'cursor:pointer',
      'font-family:inherit',
      'font-size:inherit',
    ].join(';');
    btn.addEventListener('click', () => window.location.reload());

    const close = document.createElement('button');
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Dismiss update notification');
    close.style.cssText = [
      'background:none',
      'border:none',
      'color:#fff',
      'cursor:pointer',
      'font-size:1rem',
      'padding:0',
      'opacity:0.6',
    ].join(';');
    close.addEventListener('click', () => banner.remove());

    banner.appendChild(msg);
    banner.appendChild(btn);
    banner.appendChild(close);
    document.body.appendChild(banner);
  }
}

// Kick off after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new PWAInstallManager());
} else {
  new PWAInstallManager();
}
