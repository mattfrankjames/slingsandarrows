// Import product data at build time — Parcel bundles the JSON so no runtime
// fetch is needed and the page works even when the JSON path resolves
// differently after bundling.
import merchData from '../data/merch.json';

// ─── State ────────────────────────────────────────────────────────────────────
let products = [];

/**
 * Cart structure:
 * {
 *   [cartKey: string]: {
 *     productId: string,
 *     name: string,
 *     size: string|null,
 *     price: number,
 *     stripePriceId: string,
 *     quantity: number,
 *   }
 * }
 */
let cart = {};

try {
  cart = JSON.parse(localStorage.getItem('merch-cart') || '{}');
} catch {
  cart = {};
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const loadingEl       = document.getElementById('loading');
const errorEl         = document.getElementById('error-state');
const grid            = document.getElementById('merch-grid');
const cartItemsEl     = document.getElementById('cart-items');
const cartEmptyEl     = document.getElementById('cart-empty');
const cartTotalEl     = document.getElementById('cart-total');
const cartTotalAmt    = document.getElementById('cart-total-amount');
const checkoutBtn     = document.getElementById('checkout-btn');
const checkoutOverlay = document.getElementById('checkout-overlay');

// ─── Stripe ───────────────────────────────────────────────────────────────────
// window.Stripe is loaded via the <script src="https://js.stripe.com/v3/"> tag.
// The public key is read from the environment at build time by Parcel.
// If the env var is absent (local dev without .env) we degrade gracefully.
const STRIPE_KEY = process.env.STRIPE_PUBLIC_KEY || '';
const stripe = STRIPE_KEY ? window.Stripe(STRIPE_KEY) : null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatPrice(cents) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function cartKey(productId, size) {
  return size ? `${productId}__${size}` : productId;
}

function saveCart() {
  try {
    localStorage.setItem('merch-cart', JSON.stringify(cart));
  } catch { /* storage full — not fatal */ }
}

// ─── Load products ────────────────────────────────────────────────────────────
// Products come from the statically-imported JSON — no network request needed.
function loadProducts() {
  try {
    products = (merchData && Array.isArray(merchData.products))
      ? merchData.products
      : [];

    loadingEl.hidden = true;

    if (!products.length) {
      errorEl.textContent = 'No products available right now.';
      errorEl.hidden = false;
      return;
    }

    products.forEach(p => grid.appendChild(renderProductCard(p)));
  } catch (err) {
    console.error('[merch] loadProducts error:', err);
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }
}

// ─── Render a product card ────────────────────────────────────────────────────
function renderProductCard(product) {
  const card = document.createElement('article');
  card.className = 'product-card';
  card.dataset.productId = product.id;

  // Product image
  const img = document.createElement('img');
  img.className = 'product-image';
  img.src       = product.image;
  img.alt       = product.name;
  img.loading   = 'lazy';
  card.appendChild(img);

  // Content area
  const content = document.createElement('div');
  content.className = 'product-content';

  const name = document.createElement('h3');
  name.className   = 'product-name';
  name.textContent = product.name;
  content.appendChild(name);

  const desc = document.createElement('p');
  desc.className   = 'product-description';
  desc.textContent = product.description;
  content.appendChild(desc);

  const price = document.createElement('p');
  price.className   = 'product-price';
  price.textContent = formatPrice(product.price);
  content.appendChild(price);

  // Size selector (only shown when product has sizes)
  let selectedSize = null;

  if (product.sizes && product.sizes.length > 0) {
    const sizesWrap = document.createElement('div');
    sizesWrap.className = 'product-sizes';

    const sizeLabel = document.createElement('label');
    sizeLabel.textContent = 'Size';
    sizesWrap.appendChild(sizeLabel);

    const sizeButtons = document.createElement('div');
    sizeButtons.className = 'size-buttons';
    sizeButtons.setAttribute('role', 'group');
    sizeButtons.setAttribute('aria-label', 'Select a size');

    product.sizes.forEach(size => {
      const btn = document.createElement('button');
      btn.className   = 'size-btn';
      btn.textContent = size;
      btn.type        = 'button';
      btn.setAttribute('aria-pressed', 'false');

      btn.addEventListener('click', () => {
        // Deselect all, select this one
        sizeButtons.querySelectorAll('.size-btn').forEach(b => {
          b.classList.remove('selected');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');
        selectedSize = size;
        addBtn.disabled = false;
      });

      sizeButtons.appendChild(btn);
    });

    sizesWrap.appendChild(sizeButtons);
    content.appendChild(sizesWrap);
  }

  // Add to cart button
  const addBtn = document.createElement('button');
  addBtn.className = 'add-to-cart-btn';
  addBtn.type      = 'button';
  addBtn.textContent = 'Add to Cart';
  // Disable until a size is chosen (when sizes exist)
  addBtn.disabled = product.sizes && product.sizes.length > 0;

  addBtn.addEventListener('click', () => {
    addToCart(product, selectedSize);
    // Brief visual feedback
    addBtn.textContent = '✓ Added!';
    setTimeout(() => { addBtn.textContent = 'Add to Cart'; }, 1200);
  });

  content.appendChild(addBtn);
  card.appendChild(content);
  return card;
}

// ─── Cart operations ──────────────────────────────────────────────────────────
function addToCart(product, size) {
  const key = cartKey(product.id, size);
  if (cart[key]) {
    cart[key].quantity += 1;
  } else {
    cart[key] = {
      productId: product.id,
      name: product.name,
      size: size || null,
      price: product.price,
      stripePriceId: product.stripePriceId || '',
      quantity: 1,
    };
  }
  saveCart();
  renderCart();
}

function removeFromCart(key) {
  delete cart[key];
  saveCart();
  renderCart();
}

function cartTotal() {
  return Object.values(cart).reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function cartItemCount() {
  return Object.keys(cart).length;
}

// ─── Render cart sidebar ──────────────────────────────────────────────────────
function renderCart() {
  const items = Object.entries(cart);

  // Clear existing item rows (keep the empty message node)
  cartItemsEl.querySelectorAll('.cart-item').forEach(el => el.remove());

  if (!items.length) {
    cartEmptyEl.hidden   = false;
    cartTotalEl.hidden   = true;
    checkoutBtn.disabled = true;
    return;
  }

  cartEmptyEl.hidden = true;

  items.forEach(([key, item]) => {
    const row = document.createElement('div');
    row.className = 'cart-item';

    const nameWrap = document.createElement('div');
    nameWrap.className = 'cart-item-name';
    nameWrap.textContent = item.name;

    if (item.size) {
      const small = document.createElement('small');
      small.textContent = `Size: ${item.size}`;
      nameWrap.appendChild(small);
    }

    if (item.quantity > 1) {
      const qty = document.createElement('small');
      qty.textContent = `Qty: ${item.quantity}`;
      nameWrap.appendChild(qty);
    }

    const right = document.createElement('div');
    right.className = 'cart-item-right';

    const priceEl = document.createElement('span');
    priceEl.className   = 'cart-item-price';
    priceEl.textContent = formatPrice(item.price * item.quantity);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'cart-item-remove';
    removeBtn.type      = 'button';
    removeBtn.textContent = '✕';
    removeBtn.setAttribute('aria-label', `Remove ${item.name}${item.size ? ` (${item.size})` : ''} from cart`);
    removeBtn.addEventListener('click', () => removeFromCart(key));

    right.appendChild(priceEl);
    right.appendChild(removeBtn);

    row.appendChild(nameWrap);
    row.appendChild(right);
    cartItemsEl.appendChild(row);
  });

  // Update total
  cartTotalEl.hidden       = false;
  cartTotalAmt.textContent = formatPrice(cartTotal());
  checkoutBtn.disabled     = false;
}

// ─── Checkout ─────────────────────────────────────────────────────────────────
async function handleCheckout() {
  if (!cartItemCount()) return;

  checkoutBtn.disabled = true;
  checkoutOverlay.classList.add('active');

  try {
    // Build line items for the serverless function
    const lineItems = Object.values(cart).map(item => ({
      productId:     item.productId,
      name:          item.name,
      size:          item.size,
      price:         item.price,
      stripePriceId: item.stripePriceId,
      quantity:      item.quantity,
    }));

    const res = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineItems,
        successUrl: `${window.location.origin}/merch?checkout=success`,
        cancelUrl:  `${window.location.origin}/merch?checkout=cancel`,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Server error (${res.status})`);
    }

    const { sessionId, url } = await res.json();

    // Prefer direct URL redirect; fall back to Stripe.js redirectToCheckout
    if (url) {
      window.location.href = url;
    } else if (stripe && sessionId) {
      const { error } = await stripe.redirectToCheckout({ sessionId });
      if (error) throw new Error(error.message);
    } else {
      throw new Error('No checkout URL returned from server.');
    }
  } catch (err) {
    console.error('[merch] checkout error:', err);
    checkoutOverlay.classList.remove('active');
    checkoutBtn.disabled = false;
    alert(`Checkout failed: ${err.message}`);
  }
}

// ─── Handle post-checkout query params ───────────────────────────────────────
function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('checkout');

  if (status === 'success') {
    // Clear cart on successful purchase
    cart = {};
    saveCart();
    renderCart();

    const banner = document.createElement('p');
    banner.style.cssText = [
      'background: rgba(168,245,168,0.12)',
      'border: 1px solid rgba(168,245,168,0.45)',
      'color: #a8f5a8',
      'padding: 0.75em 1em',
      'border-radius: 4px',
      'margin-block-end: 1.5em',
      'font-size: 0.95em',
    ].join(';');
    banner.textContent = '✓ Order placed — thank you! Check your email for confirmation.';
    document.querySelector('.merch-header').after(banner);

    // Clean up URL
    history.replaceState({}, '', '/merch');
  } else if (status === 'cancel') {
    history.replaceState({}, '', '/merch');
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
checkoutBtn.addEventListener('click', handleCheckout);
handleCheckoutReturn();
renderCart(); // restore persisted cart from localStorage
loadProducts();
