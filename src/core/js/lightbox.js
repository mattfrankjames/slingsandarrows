// Minimal single-image lightbox — click a post/reply photo to view it full-size.
// Self-contained: injects its own styles and DOM on first use.

let overlay, imgEl, captionEl;

function ensureBuilt() {
  if (overlay) return;

  const style = document.createElement('style');
  style.textContent = `
    .sa-lightbox {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.9);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 2em 1em;
    }
    .sa-lightbox.active { display: flex; }
    .sa-lightbox img {
      max-width: 100%;
      max-height: 85vh;
      object-fit: contain;
      display: block;
      border-radius: 4px;
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

  overlay = document.createElement('div');
  overlay.className = 'sa-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <button class="sa-lightbox-close" aria-label="Close">✕</button>
    <figure class="sa-lightbox-figure">
      <img alt="">
      <figcaption class="sa-lightbox-caption"></figcaption>
    </figure>
  `;
  document.body.appendChild(overlay);

  imgEl = overlay.querySelector('img');
  captionEl = overlay.querySelector('.sa-lightbox-caption');

  overlay.querySelector('.sa-lightbox-close').addEventListener('click', close);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) close();
  });
}

function open(src, caption = '') {
  ensureBuilt();
  imgEl.src = src;
  imgEl.alt = caption;
  captionEl.textContent = caption;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function close() {
  if (!overlay) return;
  overlay.classList.remove('active');
  document.body.style.overflow = '';
}

export const lightbox = { open, close };
