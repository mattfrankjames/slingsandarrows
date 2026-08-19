// Self-injecting "New Post" dialog for the feed page — same architecture as
// AuthModal (src/js/auth-modal.js): a singleton that injects its own markup
// into <body> once, then exposes open()/close(). Uses the native <dialog>
// element so focus-trapping, Escape handling, and the ::backdrop are all
// handled by the browser rather than hand-rolled.
import { initPostComposerForm, hasDraftContent } from './post-composer.js';

const DIALOG_HTML = `
  <dialog id="post-composer-dialog" aria-labelledby="composer-modal-title">
    <div class="composer-modal-header">
      <h2 id="composer-modal-title">New Post</h2>
      <button type="button" class="composer-modal-close" id="composer-modal-close" aria-label="Close">✕</button>
    </div>
    <div class="composer">
      <form id="post-form">
        <label for="post-title">Title (optional)</label>
        <input type="text" id="post-title" name="title" placeholder="Leave blank to post without a title">
        <label for="post-body">Body *</label>
        <div class="composer-toolbar">
          <button type="button" class="btn btn-sm" id="insert-link-btn">🔗 Insert Link</button>
          <button type="button" class="btn btn-sm" id="insert-readmore-btn">✂ Insert Read More Break</button>
        </div>
        <p class="composer-hint">Everything above the break shows in the feed; readers click "Read more" to see the rest.</p>
        <div id="link-insert-panel" hidden class="link-insert-panel">
          <label for="link-text-input">Link text</label>
          <input type="text" id="link-text-input" placeholder="e.g. Get tickets">
          <label for="link-url-input">URL</label>
          <input type="url" id="link-url-input" placeholder="https://…">
          <div class="link-insert-actions">
            <button type="button" class="btn btn-sm" id="link-insert-confirm">Insert</button>
            <button type="button" class="btn btn-sm" id="link-insert-cancel">Cancel</button>
          </div>
          <p id="link-insert-status" class="link-insert-status"></p>
        </div>
        <textarea id="post-body" name="body" placeholder="What's happening with the band?" required></textarea>
        <label for="post-image">Photo / Video / Audio (optional)</label>
        <input type="file" id="post-image" name="image" accept="image/*,video/*,audio/*">
        <div id="image-preview-wrap" hidden>
          <div id="preview-media"></div>
          <button type="button" id="remove-image-btn" aria-label="Remove media">✕</button>
        </div>
        <p id="upload-status" aria-live="polite"></p>
        <button type="submit" class="btn" id="submit-btn">Publish Post</button>
        <p id="status-msg" role="status" aria-live="polite"></p>
      </form>
    </div>
  </dialog>
`;

// How long the "✓ Post published!" / "📱 Saved offline" message stays visible
// before the dialog auto-closes — mirrors the gallery upload modal's timing
// (src/js/gallery.js's handleUpload: setTimeout(closeUploadModal, 1200)).
const AUTO_CLOSE_DELAY_MS = 1200;

class PostComposerModal {
  constructor() {
    this._publishedHandlers = [];
    this._setupDOM();
  }

  _setupDOM() {
    document.body.insertAdjacentHTML('beforeend', DIALOG_HTML);
    this.dialog = document.getElementById('post-composer-dialog');

    this._composer = initPostComposerForm({
      onPublished:     post   => this._handlePublished(post),
      onQueuedOffline: record => this._handleQueuedOffline(record),
    });

    document.getElementById('composer-modal-close')
      .addEventListener('click', () => this.requestClose());

    // Backdrop click: a click that lands outside the dialog's own box still
    // dispatches to the dialog element itself (::backdrop isn't a real
    // hit-testable node), so a bounding-rect check tells backdrop clicks
    // apart from clicks on the dialog's own padding.
    this.dialog.addEventListener('click', e => {
      if (e.target !== this.dialog) return;
      const rect = this.dialog.getBoundingClientRect();
      const insideDialog =
        e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!insideDialog) this.requestClose();
    });

    // Escape fires 'cancel' before 'close' — intercept so an in-progress
    // draft gets the same discard confirmation as the close button, instead
    // of the browser silently closing the dialog out from under the author.
    this.dialog.addEventListener('cancel', e => {
      e.preventDefault();
      this.requestClose();
    });
  }

  open() {
    this.dialog.showModal();
    document.body.style.overflow = 'hidden';
    document.getElementById('post-title')?.focus();
  }

  /** Close, but confirm first if the author has unsaved title/body/media. */
  requestClose() {
    if (hasDraftContent() && !confirm('Discard this post? Your draft will be lost.')) {
      return;
    }
    this._composer?.reset();
    this._close();
  }

  _close() {
    if (!this.dialog.open) return;
    this.dialog.close();
    document.body.style.overflow = '';
  }

  _handlePublished(post) {
    this._publishedHandlers.forEach(fn => fn(post, { pending: false }));
    setTimeout(() => this._close(), AUTO_CLOSE_DELAY_MS);
  }

  _handleQueuedOffline(record) {
    this._publishedHandlers.forEach(fn => fn(record, { pending: true }));
    setTimeout(() => this._close(), AUTO_CLOSE_DELAY_MS);
  }

  /**
   * Register a callback for when a post is published or queued offline.
   * @param {(post: object, meta: { pending: boolean }) => void} fn
   */
  onPublished(fn) {
    this._publishedHandlers.push(fn);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
export const postComposerModal = new PostComposerModal();
