// Minimal single-image lightbox — click a post/reply photo to view it full-size.
// Self-contained: injects its own styles and DOM on first use.
//
// Built on <dialog>. The previous version was a div with role="dialog" and
// aria-modal="true", which promises behaviour the browser then has to be told
// to provide: focus stayed on the page behind, Tab walked straight out of the
// open lightbox, and nothing restored focus on close. showModal() gives all of
// that — the focus trap, the inert background, the ::backdrop and Escape — from
// the platform, and deletes the code that was half-implementing it.

/** @type {HTMLDialogElement | null} */
let dialog = null;
let imgEl, captionEl;

function ensureBuilt() {
  if (dialog) return;

  const style = document.createElement('style');
  style.textContent = `
    .sa-lightbox {
      border: 0;
      padding: 2em 1em;
      max-width: 100vw;
      max-height: 100vh;
      width: 100%;
      height: 100%;
      background: transparent;
      overflow: hidden;
    }
    /* <dialog> is display:none until open, so this replaces the old
       .active class entirely — the open state is now the element's own. */
    .sa-lightbox[open] {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .sa-lightbox::backdrop {
      background: rgba(0, 0, 0, 0.9);
    }
    .sa-lightbox img {
      max-width: 100%;
      max-height: 85vh;
      object-fit: contain;
      display: block;
      border-radius: var(--radius, 4px);
    }
    .sa-lightbox-caption {
      color: rgba(255, 255, 255, 0.7);
      font-size: 0.85em;
      text-align: center;
      margin-block-start: 0.75em;
    }
    .sa-lightbox-close {
      position: absolute;
      top: 1em;
      right: 1em;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: white;
      width: 2.25em;
      height: 2.25em;
      border-radius: 50%;
      font-size: 1.1rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .sa-lightbox-close:hover { background: rgba(255, 255, 255, 0.2); }
    .sa-lightbox-figure { display: flex; flex-direction: column; align-items: center; max-width: 100%; }
  `;
  document.head.appendChild(style);

  dialog = document.createElement('dialog');
  dialog.className = 'sa-lightbox';
  dialog.setAttribute('aria-label', 'Media viewer');
  dialog.innerHTML = `
    <button class="sa-lightbox-close" aria-label="Close">✕</button>
    <figure class="sa-lightbox-figure">
      <img alt="">
      <figcaption class="sa-lightbox-caption"></figcaption>
    </figure>
  `;
  document.body.appendChild(dialog);

  imgEl = dialog.querySelector('img');
  captionEl = dialog.querySelector('.sa-lightbox-caption');

  dialog.querySelector('.sa-lightbox-close').addEventListener('click', close);

  // Click-outside-to-close. The dialog fills the viewport so that its
  // ::backdrop can be styled, which means "outside" is the dialog's own
  // padding — anything that is not the figure or the close button.
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close();
  });

  // Escape is handled by the browser, which fires 'cancel' then 'close'. The
  // scroll lock is released in the 'close' handler so it lifts however the
  // dialog was dismissed.
  dialog.addEventListener('close', () => {
    document.body.style.overflow = '';
  });
}

/**
 * @param {string} src
 * @param {string} [caption]
 */
function open(src, caption = '') {
  ensureBuilt();
  imgEl.src = src;
  imgEl.alt = caption;
  captionEl.textContent = caption;
  dialog.showModal();
  document.body.style.overflow = 'hidden';
}

function close() {
  if (dialog?.open) dialog.close();
}

export const lightbox = { open, close };
